"use client";

import Lenis from "lenis";
import { useEffect } from "react";
import type { RefObject } from "react";

import "lenis/dist/lenis.css";

/**
 * Lenis smooth scrolling for one scroll container. Automatic frames, nested
 * scroll areas allowed, skipped under reduced motion, destroyed on unmount.
 * Default `lerp` is 0.1; lower values glide longer. `target` is the viewport.
 */
export function SmoothScrollTarget({
  target,
  lerp = 0.1,
}: {
  target: RefObject<HTMLElement | null>;
  /** 0–1 catch-up per frame. Lower = more glide. */
  lerp?: number;
}) {
  useEffect(() => {
    const wrapper = target.current;
    if (!wrapper) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const lenis = new Lenis({
      wrapper,
      content: wrapper.firstElementChild ?? undefined,
      allowNestedScroll: true,
      autoRaf: true,
      lerp,
    });
    return () => lenis.destroy();
  }, [lerp, target]);

  return null;
}
