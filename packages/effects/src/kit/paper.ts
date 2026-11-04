/**
 * @paper-design/shaders seek adapter (Apache-2.0).
 *
 * Rule: mount with `speed: 0` (or call `setSpeed(0)`) so no rAF loop runs,
 * then pin time with `setFrame(t * 1000)` — frames are milliseconds from
 * zero. Structural typing on purpose: the kit never imports the shader
 * package itself; a module pulls in `ShaderMount` plus a fragment shader
 * (mesh-gradient, metaballs, dithering, grain-gradient, fluted-glass, water,
 * warp, god-rays, ...) and drives it from a layout effect, mirroring the
 * uniforms and frame into SSR-visible markup so the determinism probe sees
 * the animation too.
 */
import type { SeekAdapter } from "./seek.js";

/** The only ShaderMount surface the adapter touches. */
export interface SeekablePaperMount {
  setFrame(frame: number): unknown;
  setSpeed(speed?: number): unknown;
  dispose(): unknown;
}

/** Stop the mount's loop and pin it to `t` seconds (the mount takes milliseconds). Safe no-op when null. */
export function seekPaper(mount: SeekablePaperMount | null | undefined, t: number): void {
  if (!mount) return;
  mount.setSpeed(0);
  mount.setFrame(Math.round(Math.max(0, t) * 1000));
}

/** A SeekAdapter over a Paper ShaderMount fetched with `getMount`. Dispose is the module's (it owns WebGL). */
export function createPaperAdapter(getMount: () => SeekablePaperMount | null | undefined): SeekAdapter {
  return {
    init() {
      getMount()?.setSpeed(0);
    },
    seek(t: number) {
      seekPaper(getMount(), t);
    },
    dispose() {},
  };
}
