/**
 * anime.js v4 seek adapter (MIT).
 *
 * Rule: animations stay paused and only move through `seek(t)` — anime's
 * `Timer.seek()` takes milliseconds, this adapter takes seconds like
 * everything else in Chair. The module that imports `animejs` sets
 * `engine.useDefaultMainLoop = false` once, so no rAF loop runs at all.
 * `stagger()` is pure (same index, same delay) and safe to call during
 * render; `Timer`/`createTimer` timelines are seeked, never played.
 * Structural typing on purpose: the kit never imports `animejs` itself.
 */
import type { SeekAdapter } from "./seek.js";

/** The only anime.js surface the adapter touches. */
export interface SeekableAnime {
  pause(): unknown;
  seek(position: number): unknown;
}

/** Pause `anim` and pin it to `t` seconds (anime takes milliseconds). Safe no-op when null. */
export function seekAnime(anim: SeekableAnime | null | undefined, t: number): void {
  if (!anim) return;
  anim.pause();
  anim.seek(Math.max(0, t) * 1000);
}

/** A SeekAdapter over one paused anime.js animation or timeline. Dispose pauses; the module owns it. */
export function createAnimeAdapter(getAnim: () => SeekableAnime | null | undefined): SeekAdapter {
  return {
    init() {},
    seek(t: number) {
      seekAnime(getAnim(), t);
    },
    dispose() {
      getAnim()?.pause();
    },
  };
}
