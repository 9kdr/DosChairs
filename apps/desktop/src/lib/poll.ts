/**
 * One visible-gated poller for the window: every repeating re-read (the
 * shelf listing, service health, live task rows) ticks through here so a
 * hidden window makes no requests. Moved from project/assets, which keeps
 * a re-export; the shelf cadence still lives with the shelf.
 */

/** Default tick cadence; callers with their own cadence pass intervalMs. */
export const DEFAULT_POLL_MS = 5000;

export type PollerOptions = {
  intervalMs?: number;
  /** False while the page is hidden: ticks are skipped, never queued. */
  visible?: () => boolean;
  /** Seams for tests; the window uses real timers. */
  schedule?: (tick: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
};

export type Poller = { stop: () => void };

/**
 * Call onTick every intervalMs while visible stays true. Hidden ticks
 * are skipped, never bunched, so a background tab makes no requests.
 */
export function startPolling(onTick: () => void, options: PollerOptions = {}): Poller {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_MS;
  const visible = options.visible ?? (() => true);
  const schedule = options.schedule ?? ((tick, ms) => setInterval(tick, ms));
  const cancel = options.cancel ?? ((timer) => clearInterval(timer as number));
  const timer = schedule(() => {
    if (visible()) onTick();
  }, intervalMs);
  return { stop: () => cancel(timer) };
}

/** True while the window can be seen; true where there is no document (tests). */
export function isWindowVisible(): boolean {
  return typeof document === "undefined" || !document.hidden;
}

/**
 * Run onVisible each time the window returns. No-op where there is no
 * document; returns the unsubscribe for the effect cleanup.
 */
export function onWindowVisible(onVisible: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const listener = () => {
    if (!document.hidden) onVisible();
  };
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
