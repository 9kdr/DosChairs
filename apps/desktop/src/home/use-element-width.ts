import { useEffect, useState, type RefObject } from "react";

/** Live content-box width for ratio-aware layouts. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const update = () => {
      // Round so sub-pixel observer noise does not flip column counts.
      const next = Math.round(node.getBoundingClientRect().width);
      setWidth((prev) => (prev === next ? prev : next));
    };
    update();

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = Math.round(entry.contentRect.width);
      setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
