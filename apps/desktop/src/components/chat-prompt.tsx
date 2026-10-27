import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** React Bits prompt bar, with the demo's sparks and menus left out. */
const BAR_WIDTH = 452;
const RADIUS = 28;
const PRESS_SCALE = 0.94;
const SQUASH = 0.13;
const MORPH_MS = 400;
const LINE = 22;
const MAX_ROWS = 4;

/** Shorten by the demo squash, and shrink to the demo press scale. */
function pressedScale(): string {
  const sx = PRESS_SCALE * (1 + SQUASH * 0.35);
  const sy = PRESS_SCALE * (1 - SQUASH);
  return `scale(${sx}, ${sy})`;
}

/** Local composer above the project dock. Nothing is sent. */
export function ChatPrompt() {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const max = LINE * MAX_ROWS;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    const release = () => {
      const bar = barRef.current;
      if (bar) bar.style.transform = "";
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  useEffect(() => {
    if (reduce) {
      const bar = barRef.current;
      if (bar) bar.style.transform = "";
    }
  }, [reduce]);

  return (
    <div
      ref={barRef}
      className={cn(
        "flex min-h-12 origin-center items-center",
        "bg-[#1a1a1a]/95 shadow-raised ring-1 ring-white/[0.08] backdrop-blur-md",
        "supports-[backdrop-filter]:bg-[#1a1a1a]/88",
        "focus-within:ring-white/15",
        "motion-reduce:transition-none",
      )}
      style={{
        width: `min(${BAR_WIDTH}px, 100%)`,
        borderRadius: RADIUS,
        transitionProperty: "transform",
        transitionDuration: `${MORPH_MS}ms`,
        transitionTimingFunction: "cubic-bezier(0.77, 0, 0.175, 1)",
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || reduceRef.current) return;
        const bar = barRef.current;
        if (bar) bar.style.transform = pressedScale();
      }}
    >
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        placeholder="Ask Chair for a cut…"
        aria-label="Ask Chair for a cut"
        className="block w-full resize-none border-0 bg-transparent px-4 py-3 text-sm leading-[22px] text-neutral-200 outline-none placeholder:text-neutral-500"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
          }
        }}
      />
    </div>
  );
}
