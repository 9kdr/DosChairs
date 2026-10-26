"use client";

import Lenis from "lenis";
import { useEffect } from "react";
import type { RefObject } from "react";

import "lenis/dist/lenis.css";

/**
 * Lenis smooth scrolling for one scroll container, the way dithercn.dev does
 * it: `lerp: 0.1`, automatic frames, nested scroll areas allowed, skipped
 * under reduced motion, destroyed on unmount. The `target` is a scroll
 * viewport, e.g. the chat conversation's.
 */
export function SmoothScrollTarget({
  target,
}: {
  target: RefObject<HTMLElement | null>;
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
      lerp: 0.1,
    });
    return () => lenis.destroy();
  }, [target]);

  return null;
}
