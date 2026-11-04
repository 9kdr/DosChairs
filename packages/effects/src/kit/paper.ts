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

/**
 * Sizing uniforms for a bare `new ShaderMount`. Paper's React components set
 * these; the mount itself never does, so they stay 0 — and the shared vertex
 * shader divides UVs by `u_scale`, which blanks object-UV shaders like
 * mesh-gradient (0/1e-4 weights) and warps pattern-UV ones. Spread into the
 * constructor uniforms of any module whose shader reads `v_objectUV` or
 * `v_patternUV` (mesh, grain, ...). Shaders on `gl_FragCoord` (dithering)
 * must NOT include these: unused names only add "location not found" noise.
 * Values are Paper's own object defaults (`defaultObjectSizing`, fit contain).
 */
export const PAPER_OBJECT_SIZING = {
  u_fit: 1,
  u_scale: 1,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
} as const;

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
