/**
 * OGL seek adapter (Unlicense): the host for custom GLSL, e.g. smooth-min
 * (SDF) liquid boxes. OGL needs WebGL, so modules use it only inside a
 * layout effect; the render still mirrors `u_time` and driven values into
 * SSR-visible markup. Seeking is two lines: set `u_time` to `t` and render
 * one frame. Structural typing on purpose: the kit never imports `ogl`.
 */
import type { SeekAdapter } from "./seek.js";

/** The only OGL surface the adapter touches: a program carrying `u_time`. */
export interface SeekableOglProgram {
  uniforms: Record<string, { value: unknown }>;
}

/** Set `u_time` to `t` seconds and paint exactly one frame. Safe no-op when null. */
export function seekOgl(
  program: SeekableOglProgram | null | undefined,
  render: () => unknown,
  t: number,
): void {
  if (!program) return;
  const u = program.uniforms["u_time"];
  if (u) u.value = Math.max(0, t);
  render();
}

/** A SeekAdapter over an OGL program fetched with `getProgram`. */
export function createOglAdapter(
  getProgram: () => SeekableOglProgram | null | undefined,
  render: () => unknown,
): SeekAdapter {
  return {
    init() {},
    seek(t: number) {
      seekOgl(getProgram(), render, t);
    },
    dispose() {},
  };
}
