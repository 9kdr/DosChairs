/**
 * WAAPI/CSS seek adapter: pins every Web Animations API animation under a
 * root to `t`. This is what makes CSS and component-library animations
 * deterministic: instead of letting them play on their own clock, the host
 * seeks them on every frame.
 *
 * Server-safe: without a DOM element (or without `getAnimations`) every
 * call is a no-op, so the determinism probe can import it freely.
 */
import { installVirtualClock } from "./seek.js";
import type { SeekAdapter, VirtualClock } from "./seek.js";

/** Pause all animations under `root` (inclusive) and pin them to `t` seconds. */
export function seekWaapi(root: Element | null | undefined, t: number): void {
  if (!root || typeof root.getAnimations !== "function") return;
  let anims: Animation[];
  try {
    anims = root.getAnimations({ subtree: true });
  } catch {
    return;
  }
  const ms = Math.max(0, t) * 1000;
  for (const anim of anims) {
    try {
      anim.pause();
      anim.currentTime = ms;
    } catch {
      // A finished or detached animation can refuse the seek; the next frame retries.
    }
  }
}

/** A SeekAdapter that drives whatever WAAPI animations live under its root. */
export function createWaapiAdapter(): SeekAdapter {
  let root: Element | null = null;
  return {
    init(next: Element | null) {
      root = next;
    },
    seek(t: number) {
      seekWaapi(root, t);
    },
    dispose() {
      root = null;
    },
  };
}

export interface SeekClockOptions {
  /** Seed for the virtual Math.random. Default 1. */
  seed?: number;
  /** Fixed virtual step in ms when running queued rAF callbacks. Default one 60 fps frame. */
  stepMs?: number;
}

/**
 * The shared two-layer adapter: `init` installs a virtual clock (rAF,
 * performance.now, Date.now, seeded random) and remembers the root; `seek`
 * pauses WAAPI under the root and steps the clock from the last position
 * (replaying from 0 after a backwards scrub); `dispose` restores everything.
 * This is the 1:1 partner of OGraf `goToTime({ timestamp })`: milliseconds
 * in, same frame out.
 */
export function createSeekClock(opts: SeekClockOptions = {}): SeekAdapter {
  let root: Element | null = null;
  let clock: VirtualClock | null = null;
  let lastMs = 0;
  return {
    init(next: Element | null) {
      root = next;
      if (!clock) clock = installVirtualClock(opts.seed ?? 1, opts.stepMs);
      lastMs = 0;
    },
    seek(t: number) {
      const ms = Math.max(0, t) * 1000;
      seekWaapi(root, t);
      if (!clock) return;
      if (ms < lastMs) {
        clock.reset();
        lastMs = 0;
      }
      clock.advance(ms - lastMs);
      lastMs = ms;
    },
    dispose() {
      clock?.restore();
      clock = null;
      root = null;
    },
  };
}
