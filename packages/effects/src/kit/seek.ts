/**
 * The seek-adapter contract: one tiny interface so any animation library
 * plugs into Chair the same way.
 *
 * A frame is a pure function of (props, t). The host (Resolve, the preview
 * page) owns the clock and calls `seek(t)` whenever time moves, in any
 * order. Adapters must therefore never start their own clock: no autoplay,
 * no requestAnimationFrame loops, no setTimeout. Build paused, seek with t.
 *
 * Server rendering has no DOM, so `init`/`seek` must be safe no-ops when
 * `root` is null or animations are unavailable. Gold modules mirror every
 * driven value into SSR-visible markup (inline styles, data attributes) so
 * the determinism probe sees the animation too.
 */
export interface SeekAdapter {
  /** Remember the root whose animations this adapter drives (null detaches). */
  init(root: Element | null, props: Record<string, unknown>): void;
  /** Pin every driven animation to `t` seconds. Pure: same t, same frame. */
  seek(t: number): void;
  /** Release listeners and references; never touches source media. */
  dispose(): void;
}

/**
 * A virtual clock: `init` installs it over `requestAnimationFrame`,
 * `performance.now`, `Date.now`, and a seeded `Math.random`; `seek` steps it;
 * `dispose` restores the real globals. Nested installs stack and unwind in
 * order. Scrubbing backwards replays from 0 (the nearest honest checkpoint
 * for state no one snapshotted), so every seek lands deterministically.
 */
export interface VirtualClock {
  /** Virtual milliseconds since install (or the last reset). */
  now(): number;
  /** Run due rAF callbacks forward by `ms` in fixed steps. */
  advance(ms: number): void;
  /** Forget queued callbacks and return to time 0. */
  reset(): void;
  /** Put the real globals back. */
  restore(): void;
}

export function installVirtualClock(seed = 1, stepMs: number = 1000 / 60): VirtualClock {
  const g = globalThis as Record<string, unknown>;
  const savedRaf = g["requestAnimationFrame"];
  const savedCaf = g["cancelAnimationFrame"];
  const savedPerf = typeof performance !== "undefined" ? performance.now.bind(performance) : undefined;
  const savedDateNow = Date.now;
  const savedRandom = Math.random;

  let vnow = 0;
  let nextId = 1;
  let queue = new Map<number, FrameRequestCallback>();
  let s = seed | 0;
  const step = stepMs > 0 && Number.isFinite(stepMs) ? stepMs : 1000 / 60;
  const epoch = savedDateNow();

  const tick = (ms: number): void => {
    const due = [...queue];
    queue = new Map();
    for (const [, cb] of due) {
      try {
        cb(ms);
      } catch {
        // A throwing animation callback must not wedge the clock; the next frame retries.
      }
    }
  };

  g["requestAnimationFrame"] = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  g["cancelAnimationFrame"] = (id: number): void => {
    queue.delete(id);
  };
  if (typeof performance !== "undefined") {
    try {
      performance.now = (): number => vnow;
    } catch {
      // A frozen performance object keeps the real clock; rAF stepping still applies.
    }
  }
  Date.now = (): number => epoch + vnow;
  Math.random = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    now: () => vnow,
    advance(ms: number) {
      let left = Math.max(0, ms);
      while (left > 1e-9) {
        const hop = Math.min(step, left);
        vnow += hop;
        left -= hop;
        tick(vnow);
      }
    },
    reset() {
      vnow = 0;
      queue = new Map();
    },
    restore() {
      if (savedRaf === undefined) delete g["requestAnimationFrame"];
      else g["requestAnimationFrame"] = savedRaf;
      if (savedCaf === undefined) delete g["cancelAnimationFrame"];
      else g["cancelAnimationFrame"] = savedCaf;
      if (savedPerf !== undefined && typeof performance !== "undefined") {
        try {
          performance.now = savedPerf;
        } catch {
          // Keep the virtual binding when the host object is frozen.
        }
      }
      Date.now = savedDateNow;
      Math.random = savedRandom;
    },
  };
}
