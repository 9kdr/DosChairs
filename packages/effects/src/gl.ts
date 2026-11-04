/**
 * WebGL2 fullscreen pass for `shader` layers. Framework-free and synchronous:
 * given (spec, t, controls) it paints one deterministic frame. Time arrives
 * only as the `t` argument (seconds, from the wrapper's goToTime) — this
 * module never reads a clock, so the same inputs always record the same GL
 * calls. Unit-tested with a stub context; no DOM needed.
 */
import type { EffectSpec } from "./types.js";

export type UniformValue =
  | { kind: "float"; value: number }
  | { kind: "vec2"; value: [number, number] }
  | { kind: "vec3"; value: [number, number, number] }
  | { kind: "vec4"; value: [number, number, number, number] };

export interface BoundUniform {
  name: string;
  value: UniformValue;
}

const FULLSCREEN_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseHexToVec3(fill: unknown): [number, number, number] | null {
  if (typeof fill !== "string") return null;
  let h = fill.startsWith("#") ? fill.slice(1) : "";
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** Coerce a control value to a GLSL uniform: number/bool, #rrggbb, or a 2-4 number array. */
export function coerceUniformValue(v: unknown): UniformValue | null {
  const n = num(v);
  if (n !== null) return { kind: "float", value: n };
  if (typeof v === "boolean") return { kind: "float", value: v ? 1 : 0 };
  const rgb = parseHexToVec3(v);
  if (rgb) return { kind: "vec3", value: rgb };
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((e) => num(e) !== null)) {
    const vals = (v as number[]).slice(0, 4);
    if (vals.length === 2) return { kind: "vec2", value: [vals[0]!, vals[1]!] };
    if (vals.length === 3) return { kind: "vec3", value: [vals[0]!, vals[1]!, vals[2]!] };
    return { kind: "vec4", value: [vals[0]!, vals[1]!, vals[2]!, vals[3]!] };
  }
  return null;
}

/** Control values with spec defaults filled in; explicit overrides win. */
export function controlValues(
  spec: EffectSpec,
  controls: Record<string, unknown> = {},
): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const c of spec.controls ?? []) values.set(c.id, c.default);
  for (const [k, v] of Object.entries(controls)) values.set(k, v);
  return values;
}

/**
 * Uniforms for one frame. Explicit `shader.uniforms` bindings come first;
 * well-known clock/resolution names the shader declares but nobody bound get
 * host values (seconds, frame, pixels, centered mouse). Names the shader does
 * not declare are skipped by the painter via null locations.
 */
export function shaderUniforms(
  spec: EffectSpec,
  t: number,
  controls: Record<string, unknown> = {},
): BoundUniform[] {
  const values = controlValues(spec, controls);
  const out: BoundUniform[] = [];
  const boundNames = new Set<string>();
  for (const u of spec.shader?.uniforms ?? []) {
    const coerced = coerceUniformValue(values.get(u.controlId));
    boundNames.add(u.name);
    if (coerced) out.push({ name: u.name, value: coerced });
  }
  const frame = Math.round(t * spec.fps);
  const builtins: BoundUniform[] = [
    { name: "u_time", value: { kind: "float", value: t } },
    { name: "uTime", value: { kind: "float", value: t } },
    { name: "u_frame", value: { kind: "float", value: frame } },
    { name: "u_resolution", value: { kind: "vec2", value: [spec.width, spec.height] } },
    { name: "uResolution", value: { kind: "vec2", value: [spec.width, spec.height] } },
    { name: "u_mouse", value: { kind: "vec2", value: [0.5, 0.5] } },
  ];
  for (const b of builtins) {
    if (!boundNames.has(b.name)) out.push(b);
  }
  return out;
}

const programCache = new WeakMap<WebGL2RenderingContext, Map<string, WebGLProgram | null>>();

function compileOne(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function programFor(gl: WebGL2RenderingContext, source: string): WebGLProgram | null {
  let bySource = programCache.get(gl);
  if (!bySource) {
    bySource = new Map();
    programCache.set(gl, bySource);
  }
  const cached = bySource.get(source);
  if (cached !== undefined) return cached;
  const vs = compileOne(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
  const fs = compileOne(gl, gl.FRAGMENT_SHADER, source);
  let prog: WebGLProgram | null = null;
  if (vs && fs) {
    prog = gl.createProgram();
    if (prog) {
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) prog = null;
    }
  }
  bySource.set(source, prog);
  return prog;
}

function setUniform(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation,
  value: UniformValue,
): void {
  if (value.kind === "float") gl.uniform1f(loc, value.value);
  else if (value.kind === "vec2") gl.uniform2f(loc, value.value[0], value.value[1]);
  else if (value.kind === "vec3") gl.uniform3f(loc, value.value[0], value.value[1], value.value[2]);
  else gl.uniform4f(loc, value.value[0], value.value[1], value.value[2], value.value[3]);
}

/**
 * Paint one frame of the spec's shader on a WebGL2 context sized to the spec.
 * Returns true when anything was drawn; false (never throws) means the caller
 * should show the Canvas2D fallback box instead.
 */
export function paintShader(
  gl: WebGL2RenderingContext,
  spec: EffectSpec,
  t: number,
  controls: Record<string, unknown> = {},
): boolean {
  try {
    const source = spec.shader?.source;
    if (!source) return false;
    const prog = programFor(gl, source);
    if (!prog) return false;
    gl.viewport(0, 0, spec.width, spec.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    for (const u of shaderUniforms(spec, t, controls)) {
      const loc = gl.getUniformLocation(prog, u.name);
      if (!loc) continue;
      setUniform(gl, loc, u.value);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.deleteBuffer(buf);
    return true;
  } catch {
    return false;
  }
}
