/**
 * gl-transitions seek adapter (MIT; check the header of the transition you
 * bundle, a few carry their own notice). A transition is stateless GLSL over
 * a `progress` uniform, so seeking is one line: `progress = t / duration`.
 * Modules paste the transition GLSL into a ShaderPass (or OGL program) over
 * two painted inputs and drive `u_progress` from here. Structural typing on
 * purpose: the kit never imports `gl-transitions` itself.
 */
import { clamp } from "./easing.js";
import type { SeekAdapter } from "./seek.js";

/** Progress 0..1 of a `duration`-second transition at time `t`. */
export function transitionProgress(t: number, duration = 1): number {
  const d = duration > 0 && Number.isFinite(duration) ? duration : 1;
  return clamp(Math.max(0, t) / d, 0, 1);
}

/** Paint one transition frame at time `t` through `draw(progress)`. */
export function seekTransition(draw: (progress: number) => unknown, t: number, duration = 1): void {
  draw(transitionProgress(t, duration));
}

/** A SeekAdapter that repaints a transition at every seek. */
export function createTransitionAdapter(draw: (progress: number) => unknown, duration = 1): SeekAdapter {
  return {
    init() {},
    seek(t: number) {
      seekTransition(draw, t, duration);
    },
    dispose() {},
  };
}
