/**
 * Motion seek adapter (motion.dev, MIT).
 *
 * Rule: create animations paused and drive them only through `.time`
 * (seconds). With `MotionGlobalConfig.useManualTiming = true` (set once by
 * the module that imports `motion`) no rAF loop runs at all. Motion does not
 * run in node, so modules compute the same values during render for the
 * determinism probe and let Motion drive the DOM node on the client via this
 * adapter. Structural typing on purpose: the kit never imports `motion`.
 */
import type { SeekAdapter } from "./seek.js";

/** The only Motion controls surface the adapter touches. */
export interface SeekableMotionControls {
  pause(): unknown;
  time: number;
}

/** Pause `controls` and pin them to `t` seconds. Safe no-op when null. */
export function seekMotion(controls: SeekableMotionControls | null | undefined, t: number): void {
  if (!controls) return;
  controls.pause();
  controls.time = Math.max(0, t);
}

/** A SeekAdapter over Motion playback controls fetched with `getControls`. */
export function createMotionAdapter(getControls: () => SeekableMotionControls | null | undefined): SeekAdapter {
  return {
    init() {},
    seek(t: number) {
      seekMotion(getControls(), t);
    },
    dispose() {},
  };
}
