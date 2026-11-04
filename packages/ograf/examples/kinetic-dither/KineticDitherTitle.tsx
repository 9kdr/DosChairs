/**
 * KineticDitherTitle: hand-written React example for the OGraf wrapper.
 *
 * A kinetic title over a Bayer-dithered accent field, rendered with raw
 * WebGL2. Every frame is a pure function of (props, t): the title mask is
 * rasterized synchronously from props, the shader animates only from uTime,
 * and there are no timers or animation loops. The wrapper drives it with
 * goToTime -> flushSync, so Resolve scrubbing and export stay exact.
 *
 * Wrapper pairing (kept next to the export script, not here): props
 * `title` (text), `accent` (color), `dither` (number 0..1), `speed`
 * (number) become the Inspector controls.
 */
import React from "react";

export interface KineticDitherTitleProps {
  title?: string;
  accent?: string;
  dither?: number;
  speed?: number;
  /** Seconds. Set by the wrapper's goToTime; paint uses this, never a clock. */
  t?: number;
  frame?: number;
  data?: unknown;
}

const W = 1920;
const H = 1080;

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 oColor;
uniform sampler2D uMask;
uniform vec2 uRes;
uniform vec3 uAccent;
uniform float uTime;
uniform float uDither;
uniform float uDuration;

float bayer(vec2 p) {
  vec2 ip = floor(mod(p, 8.0));
  float x = ip.x;
  float y = ip.y;
  float m = 0.0;
  if (x < 4.0) {
    if (y < 4.0) {
      m = x * 4.0 + y;
    } else {
      m = x * 4.0 + (y - 4.0) + 32.0;
    }
  } else {
    if (y < 4.0) {
      m = (x - 4.0) * 4.0 + y + 16.0;
    } else {
      m = (x - 4.0) * 4.0 + (y - 4.0) + 48.0;
    }
  }
  return m / 64.0;
}

void main() {
  vec2 px = vUv * uRes;
  float mask = texture(uMask, vec2(vUv.x, 1.0 - vUv.y)).a;
  float intro = clamp(uTime / 0.6, 0.0, 1.0);
  float outro = clamp((uDuration - uTime) / 0.5, 0.0, 1.0);
  float gate = intro * outro;
  float reveal = gate * smoothstep(1.0 - mask, 1.0 - mask + 0.08, bayer(px * 0.5 + uTime * 8.0));
  vec3 paper = vec3(0.93, 0.91, 0.86);
  vec3 ink = vec3(0.05, 0.06, 0.08);
  float dots = step(0.5 + uDither * 0.5, bayer(px * 0.25));
  vec3 field = mix(ink, uAccent * (0.25 + 0.35 * dots), uDither * 0.55);
  vec3 col = mix(field, paper, reveal);
  oColor = vec4(col, 1.0);
}`;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = "ffb000";
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** Synchronously rasterize the title to an offscreen canvas (alpha mask). */
function rasterizeTitle(title: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const words = title.toUpperCase().slice(0, 24) || "SIGNAL";
  let size = 260;
  ctx.font = `900 ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  while (ctx.measureText(words).width > 1640 && size > 40) {
    size -= 10;
    ctx.font = `900 ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  }
  ctx.fillText(words, W / 2, H / 2);
  return canvas;
}

interface GlState {
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  maskTex: WebGLTexture | null;
  maskKey: string;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
  return shader;
}

function paintFrame(
  node: HTMLCanvasElement,
  state: GlState,
  props: { title: string; accent: string; dither: number; t: number },
  duration: number,
): boolean {
  const { gl } = state;
  try {
    const maskKey = `${props.title}`;
    if (!state.maskTex || state.maskKey !== maskKey) {
      if (state.maskTex) gl.deleteTexture(state.maskTex);
      state.maskTex = gl.createTexture();
      state.maskKey = maskKey;
      const mask = rasterizeTitle(props.title);
      gl.bindTexture(gl.TEXTURE_2D, state.maskTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(state.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.maskTex);
    const set1f = (name: string, v: number): void => {
      const loc = gl.getUniformLocation(state.prog, name);
      if (loc) gl.uniform1f(loc, v);
    };
    set1f("uTime", props.t);
    set1f("uDither", Math.min(1, Math.max(0, props.dither)));
    set1f("uDuration", duration);
    const uRes = gl.getUniformLocation(state.prog, "uRes");
    if (uRes) gl.uniform2f(uRes, W, H);
    const accent = hexToRgb(props.accent);
    const aLoc = gl.getUniformLocation(state.prog, "uAccent");
    if (aLoc) gl.uniform3f(aLoc, accent[0], accent[1], accent[2]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(state.prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.deleteBuffer(buf);
    return true;
  } catch {
    return false;
  }
}

export function KineticDitherTitle(input: KineticDitherTitleProps): React.ReactElement {
  const title = typeof input.title === "string" ? input.title : "SIGNAL";
  const accent = typeof input.accent === "string" ? input.accent : "#ffb000";
  const dither = typeof input.dither === "number" ? input.dither : 0.6;
  const speed = typeof input.speed === "number" && input.speed > 0 ? input.speed : 1;
  const t = typeof input.t === "number" ? Math.max(0, input.t * speed) : 0;
  const duration = 5;
  const stateRef = React.useRef<GlState | null>(null);
  const [glMissing, setGlMissing] = React.useState(false);
  const attach = React.useCallback(
    (node: HTMLCanvasElement | null) => {
      if (!node) {
        stateRef.current = null;
        return;
      }
      let gl = stateRef.current?.gl;
      if (!gl) {
        try {
          gl = node.getContext("webgl2", { alpha: false }) as WebGL2RenderingContext | null;
        } catch {
          gl = null;
        }
        if (!gl) {
          setGlMissing(true);
          return;
        }
        const vs = compile(gl, gl.VERTEX_SHADER, VS);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
        if (!vs || !fs) {
          setGlMissing(true);
          return;
        }
        const prog = gl.createProgram();
        if (!prog) {
          setGlMissing(true);
          return;
        }
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          setGlMissing(true);
          return;
        }
        stateRef.current = { gl, prog, maskTex: null, maskKey: "" };
      }
      const ok = paintFrame(node, stateRef.current!, { title, accent, dither, t }, duration);
      if (!ok) setGlMissing(true);
    },
    [title, accent, dither, speed, t],
  );
  if (glMissing) {
    return React.createElement(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          background: "#14171c",
          color: "#f5c542",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          font: "28px sans-serif",
        },
      },
      "WebGL2 unavailable: this title needs a WebGL2 host",
    );
  }
  return React.createElement("canvas", {
    ref: attach,
    width: W,
    height: H,
    style: { width: "100%", height: "100%", display: "block", background: "#0c0e12" },
  });
}

export default KineticDitherTitle;
