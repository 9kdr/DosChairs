/**
 * flubber seek adapter (MIT): path morphing as a pure function of `t`.
 * `interpolate(a, b)` is already seekable — this file only pins the recipe
 * (clamp, memoize the interpolator, paint one frame) and adapts it to an
 * SVG path element. Modules import `flubber` themselves; the kit stays
 * dependency-free here. Structural typing on purpose.
 */
import { clamp } from "./easing.js";
import type { SeekAdapter } from "./seek.js";

/** flubber's `interpolate(from, to, options?)` without the untyped options bag. */
export type FlubberInterpolate = (from: string, to: string, options?: Record<string, unknown>) => (u: number) => string;

/** The morphed `d` at blend `u` (0 = `from`, 1 = `to`), clamped. */
export function morphAt(
  interpolate: FlubberInterpolate,
  from: string,
  to: string,
  u: number,
  options?: Record<string, unknown>,
): string {
  return interpolate(from, to, options)(clamp(u, 0, 1));
}

/**
 * A SeekAdapter that morphs one path from `from` to `to` over `duration`
 * seconds, painting through `setPath`. The interpolator is built once.
 */
export function createFlubberAdapter(
  interpolate: FlubberInterpolate,
  setPath: (d: string) => void,
  from: string,
  to: string,
  duration = 1,
  options?: Record<string, unknown>,
): SeekAdapter {
  let morph: ((u: number) => string) | null = null;
  return {
    init() {
      morph = interpolate(from, to, options);
    },
    seek(t: number) {
      if (!morph) morph = interpolate(from, to, options);
      const d = duration > 0 && Number.isFinite(duration) ? duration : 1;
      setPath(morph(clamp(Math.max(0, t) / d, 0, 1)));
    },
    dispose() {
      morph = null;
    },
  };
}
