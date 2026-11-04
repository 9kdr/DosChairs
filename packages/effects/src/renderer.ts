/** WebGL2 preview renderer: draws a spec's resolved layers at time t. Browser only. */
import { resolveFrame } from "./curves.js";
import type { EffectSpec } from "./types.js";

export interface RenderAssets {
  images: Map<string, TexImageSource>;
}

const QUAD_VS = `#version 300 es
in vec2 aPos; in vec2 aUv; out vec2 vUv;
uniform vec2 uResolution;
void main() {
  vUv = aUv;
  vec2 clip = (aPos / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const COLOR_FS = `#version 300 es
precision mediump float;
in vec2 vUv; out vec4 oColor;
uniform vec4 uColor; uniform float uKind;
void main() {
  if (uKind > 0.5) {
    vec2 p = vUv * 2.0 - 1.0;
    if (dot(p, p) > 1.0) discard;
  }
  oColor = uColor;
}`;



const TEX_FS = `#version 300 es
precision mediump float;
in vec2 vUv; out vec4 oColor;
uniform sampler2D uTexture; uniform float uOpacity;
void main() { oColor = texture(uTexture, vUv) * vec4(1.0, 1.0, 1.0, uOpacity); }`;

const USER_VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`;

interface GLCache {
  color: WebGLProgram | null;
  tex: WebGLProgram | null;
  user: Map<string, WebGLProgram | null>;
  textures: Map<string, { tex: WebGLTexture; w: number; h: number }>;
  buf: WebGLBuffer | null;
  uvBuf: WebGLBuffer | null;
}

const caches = new WeakMap<WebGL2RenderingContext, GLCache>();

function cache(gl: WebGL2RenderingContext): GLCache {
  let c = caches.get(gl);
  if (!c) {
    c = { color: null, tex: null, user: new Map(), textures: new Map(), buf: null, uvBuf: null };
    caches.set(gl, c);
  }
  return c;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const compileOne = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  };
  const v = compileOne(gl.VERTEX_SHADER, vs);
  const f = compileOne(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

export function parseColor(fill: unknown): [number, number, number] {
  if (typeof fill !== "string") return [1, 1, 1];
  let h = fill.startsWith("#") ? fill.slice(1) : "";
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [1, 1, 1];
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Quad corners (0..1 uv space) for a rotated rect centered at x,y with size w,h. */
export function quadCorners(
  x: number, y: number, w: number, h: number, rotation: number,
): { uv: number[]; px: number[] } {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const uvs = [0, 0, 1, 0, 0, 1, 1, 1];
  const px: number[] = [];
  for (let i = 0; i < 4; i++) {
    const ox = (uvs[i * 2]! - 0.5) * w;
    const oy = (uvs[i * 2 + 1]! - 0.5) * h;
    px.push(x + ox * c - oy * s, y + ox * s + oy * c);
  }
  return { uv: uvs, px };
}

function uploadQuad(
  gl: WebGL2RenderingContext, c: GLCache, prog: WebGLProgram,
  vsName: string, corners: { uv: number[]; px: number[] }, w: number, h: number,
): void {
  gl.useProgram(prog);
  gl.uniform2f(gl.getUniformLocation(prog, "uResolution"), w, h);
  if (!c.buf) c.buf = gl.createBuffer();
  if (!c.uvBuf) c.uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
  const loc = gl.getAttribLocation(prog, vsName);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners.px), gl.STREAM_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, c.uvBuf);
  const uvLoc = gl.getAttribLocation(prog, "aUv");
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners.uv), gl.STREAM_DRAW);
}

function applyBlend(gl: WebGL2RenderingContext, blend: string | undefined): void {
  gl.enable(gl.BLEND);
  switch (blend) {
    case "add":
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      break;
    case "multiply":
      gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      break;
    case "screen":
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      break;
    default:
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }
}

function textTexture(
  gl: WebGL2RenderingContext, c: GLCache, key: string,
  str: string, font: string, size: number, fill: string,
): { tex: WebGLTexture; w: number; h: number } | null {
  const hit = c.textures.get(key);
  if (hit) return hit;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.font = `${size}px ${font}`;
    canvas.width = Math.max(1, Math.ceil(ctx.measureText(str).width) + 8);
    canvas.height = Math.max(1, Math.ceil(size * 1.4));
    ctx.font = `${size}px ${font}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = fill;
    ctx.fillText(str, 4, canvas.height / 2);
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    const entry = { tex, w: canvas.width, h: canvas.height };
    c.textures.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Preview one frame of the spec at time t. Applies published control
 * overrides, evaluates curves, and draws shape/text/image/shader layers.
 * Never throws on bad layer data: the layer is skipped.
 */
export function renderFrame(
  gl: WebGL2RenderingContext,
  spec: EffectSpec,
  t: number,
  controls: Record<string, unknown> = {},
  assets: RenderAssets = { images: new Map() },
): void {
  const c = cache(gl);
  if (!c.color) c.color = compile(gl, QUAD_VS, COLOR_FS);
  if (!c.tex) c.tex = compile(gl, QUAD_VS, TEX_FS);
  gl.viewport(0, 0, spec.width, spec.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  for (const layer of resolveFrame(spec, t, controls)) {
    if (layer.visible === false) continue;
    try {
      applyBlend(gl, layer.blend);
      const r = layer.resolved;
      if (layer.type === "shape") {
        if (!c.color) continue;
        const corners = quadCorners(
          num(r["x"], spec.width / 2), num(r["y"], spec.height / 2),
          num(r["scaleX"], 100), num(r["scaleY"], 100), num(r["rotation"], 0),
        );
        uploadQuad(gl, c, c.color, "aPos", corners, spec.width, spec.height);
        const [cr, cg, cb] = parseColor(r["fill"]);
        gl.uniform4f(gl.getUniformLocation(c.color, "uColor"), cr, cg, cb, num(r["opacity"], 1));
        gl.uniform1f(gl.getUniformLocation(c.color, "uKind"), r["kind"] === "ellipse" ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else if (layer.type === "text" || layer.type === "image") {
        if (!c.tex) continue;
        let entry: { tex: WebGLTexture; w: number; h: number } | null = null;
        let w = 0;
        let h = 0;
        if (layer.type === "text") {
          const str = String(r["string"] ?? "");
          const size = num(r["size"], 48);
          entry = textTexture(gl, c, `txt:${str}|${r["font"]}|${size}|${r["fill"]}`,
            str, String(r["font"] ?? "sans-serif"), size, String(r["fill"] ?? "#ffffff"));
          if (entry) {
            w = entry.w;
            h = entry.h;
          }
        } else {
          const src = String(r["src"] ?? "");
          const img = assets.images.get(src);
          if (img) {
            const key = `img:${src}`;
            entry = c.textures.get(key) ?? null;
            if (!entry) {
              const tex = gl.createTexture();
              if (tex) {
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                const iw = (img as { width?: number }).width ?? 0;
                const ih = (img as { height?: number }).height ?? 0;
                entry = { tex, w: iw, h: ih };
                c.textures.set(key, entry);
              }
            }
            if (entry) {
              w = num(r["scaleX"], entry.w);
              h = num(r["scaleY"], entry.h);
            }
          }
        }
        if (!entry) continue;
        // The rig bakes squash on text/image carriers as scale/scaley
        // multipliers (the pair the Resolve Transform reads); Y falls back
        // to the uniform scale, mirroring the adapter (#294).
        const corners = quadCorners(
          num(r["x"], spec.width / 2), num(r["y"], spec.height / 2),
          w * num(r["scale"], 1), h * num(r["scaley"], num(r["scale"], 1)),
          num(r["rotation"], 0),
        );
        uploadQuad(gl, c, c.tex, "aPos", corners, spec.width, spec.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        gl.uniform1i(gl.getUniformLocation(c.tex, "uTexture"), 0);
        gl.uniform1f(gl.getUniformLocation(c.tex, "uOpacity"), num(r["opacity"], 1));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else if (layer.type === "shader" && spec.shader) {
        let prog = c.user.get(spec.shader.source);
        if (prog === undefined) {
          prog = compile(gl, USER_VS, spec.shader.source);
          c.user.set(spec.shader.source, prog);
        }
        if (!prog) continue;
        gl.useProgram(prog);
        gl.uniform1f(gl.getUniformLocation(prog, "uTime"), t);
        gl.uniform2f(gl.getUniformLocation(prog, "uResolution"), spec.width, spec.height);
        const bound = new Map((spec.shader.uniforms ?? []).map((u) => [u.name, u.controlId]));
        const values: Map<string, unknown> = new Map(
          (spec.controls ?? []).map((ctl) => [ctl.id, ctl.default]),
        );
        for (const [k, v] of Object.entries(controls)) values.set(k, v);
        for (const [uname, cid] of bound) {
          const loc = gl.getUniformLocation(prog, uname);
          if (!loc) continue;
          const v = values.get(cid);
          if (typeof v === "number") gl.uniform1f(loc, v);
          else if (typeof v === "boolean") gl.uniform1f(loc, v ? 1 : 0);
          else if (typeof v === "string" && v.startsWith("#")) {
            const [cr, cg, cb] = parseColor(v);
            gl.uniform3f(loc, cr, cg, cb);
          }
        }
        const loc = gl.getAttribLocation(prog, "aPos");
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    } catch {
      continue;
    }
  }
}
