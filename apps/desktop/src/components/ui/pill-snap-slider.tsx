"use client";

import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";

/** How close (in track units) before `onApproach` fires toward the next snap. */
const EMBRACE_RADIUS = 0.42;
/** Soft overshoot past the ends, in track units. */
const RUBBER_MAX = 0.55;

export type PillSnapApproach = {
  committed: number;
  toward: number | null;
  heading: -1 | 0 | 1;
  intensity: number;
  dragging: boolean;
};

export type PillSnapSliderProps = {
  value: number;
  min?: number;
  max: number;
  /** Integer step between snaps. Default 1. */
  step?: number;
  onChange: (value: number) => void;
  onApproach?: (approach: PillSnapApproach) => void;
  getAriaLabel?: (value: number) => string;
  getAriaValueText?: (value: number) => string;
  className?: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function snapTo(n: number, min: number, max: number, step: number): number {
  const snapped = Math.round(clamp(n, min, max) / step) * step;
  return clamp(snapped, min, max);
}

function rubberBand(over: number): number {
  // Asymptotic stretch — feels chewy near the wall, never unbounded.
  return (1 - Math.exp(-over * 2.4)) * RUBBER_MAX;
}

function readApproach(
  committed: number,
  live: number,
  dragging: boolean,
  heading: -1 | 0 | 1,
  min: number,
  max: number,
  step: number,
): PillSnapApproach {
  if (!dragging || heading === 0) {
    return { committed, toward: null, heading: 0, intensity: 0, dragging };
  }

  const ahead = clamp(committed + heading * step, min, max);
  if (ahead === committed) {
    return { committed, toward: null, heading, intensity: 0, dragging: true };
  }

  const dist = Math.abs(live - ahead);
  const between =
    heading > 0
      ? live > committed && live <= ahead + 0.02
      : live < committed && live >= ahead - 0.02;

  if (between && dist <= EMBRACE_RADIUS) {
    return {
      committed,
      toward: ahead,
      heading,
      intensity: 1 - dist / EMBRACE_RADIUS,
      dragging: true,
    };
  }

  return { committed, toward: null, heading, intensity: 0, dragging: true };
}

/**
 * Pill-shaped snap slider: silky drag, spring settle, rubber stretch at the
 * ends, and a thumb that grows as the pointer nears it.
 */
export function PillSnapSlider({
  value,
  min = 0,
  max,
  step = 1,
  onChange,
  onApproach,
  getAriaLabel,
  getAriaValueText,
  className,
}: PillSnapSliderProps) {
  const reduceMotion = useReducedMotion();
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const committedRef = useRef(value);
  const liveRef = useRef(value);
  const headingRef = useRef<-1 | 0 | 1>(0);

  // Drive the thumb from `live` directly while dragging so it does not lag
  // behind the pointer; `animate(live, …)` on release still springs to settle.
  const live = useMotionValue(value);

  const proximity = useMotionValue(0);
  const proximitySpring = useSpring(proximity, {
    stiffness: reduceMotion ? 500 : 280,
    damping: reduceMotion ? 36 : 20,
    mass: 0.45,
  });

  const stretch = useMotionValue(0);
  const stretchSpring = useSpring(stretch, {
    stiffness: reduceMotion ? 500 : 260,
    damping: reduceMotion ? 34 : 18,
    mass: 0.5,
  });

  const range = Math.max(step, max - min);
  const thumbLeft = useTransform(live, (v) => {
    const t = (clamp(v, min, max) - min) / range;
    return `${t * 100}%`;
  });
  const thumbScale = useTransform(proximitySpring, [0, 1], [0.72, 1.2]);
  const pillScaleX = useTransform(stretchSpring, (s) => 1 + Math.abs(s) * 0.09);
  const pillScaleY = useTransform(stretchSpring, (s) => 1 - Math.abs(s) * 0.045);
  // Overshoot right → grow from the left edge; overshoot left → from the right.
  const pillOrigin = useTransform(stretchSpring, (s) =>
    s < -0.001 ? "100% 50%" : s > 0.001 ? "0% 50%" : "50% 50%",
  );

  useEffect(() => {
    committedRef.current = value;
    if (!draggingRef.current) {
      live.set(value);
      liveRef.current = value;
      stretch.set(0);
    }
  }, [live, stretch, value]);

  const publishApproach = useCallback(
    (nextLive: number, dragging: boolean) => {
      onApproach?.(
        readApproach(
          committedRef.current,
          nextLive,
          dragging,
          dragging ? headingRef.current : 0,
          min,
          max,
          step,
        ),
      );
    },
    [max, min, onApproach, step],
  );

  const valueFromClientX = useCallback(
    (clientX: number, soft: boolean) => {
      const track = trackRef.current;
      if (!track) return committedRef.current;
      const rect = track.getBoundingClientRect();
      const pad = 6;
      const raw =
        (clientX - rect.left - pad) / Math.max(1, rect.width - pad * 2);
      const unclamped = min + raw * range;

      if (!soft) return clamp(unclamped, min, max);
      if (unclamped < min) return min - rubberBand(min - unclamped);
      if (unclamped > max) return max + rubberBand(unclamped - max);
      return unclamped;
    },
    [max, min, range],
  );

  const updateProximity = useCallback(
    (clientX: number, clientY: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const t = (clamp(liveRef.current, min, max) - min) / range;
      const thumbX = rect.left + t * rect.width;
      const thumbY = rect.top + rect.height / 2;
      const dist = Math.hypot(clientX - thumbX, clientY - thumbY);
      // Grow within ~36px of the knob.
      proximity.set(clamp(1 - dist / 36, 0, 1));
    },
    [min, proximity, range],
  );

  const applyLive = useCallback(
    (next: number) => {
      liveRef.current = next;
      live.set(next);
      const over =
        next < min ? next - min : next > max ? next - max : 0;
      stretch.set(over / RUBBER_MAX);
    },
    [live, max, min, stretch],
  );

  /** Commit as soon as the live value's nearest snap changes — no dead band. */
  const commitNearest = useCallback(
    (liveValue: number) => {
      const nearest = snapTo(liveValue, min, max, step);
      if (nearest === committedRef.current) return nearest;
      committedRef.current = nearest;
      onChange(nearest);
      return nearest;
    },
    [max, min, onChange, step],
  );

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    headingRef.current = 0;

    const target = snapTo(liveRef.current, min, max, step);
    liveRef.current = target;

    if (reduceMotion) {
      live.set(target);
      stretch.set(0);
    } else {
      animate(live, target, {
        type: "spring",
        stiffness: 420,
        damping: 22,
        mass: 0.45,
      });
      animate(stretch, 0, {
        type: "spring",
        stiffness: 380,
        damping: 20,
        mass: 0.45,
      });
    }

    commitNearest(target);
    publishApproach(target, false);
  }, [
    commitNearest,
    live,
    max,
    min,
    publishApproach,
    reduceMotion,
    step,
    stretch,
  ]);

  useEffect(() => {
    const onUp = () => endDrag();
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [endDrag]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Stop any settle animation so a quick re-grab is not fighting the spring.
    live.stop();
    stretch.stop();
    draggingRef.current = true;
    headingRef.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    proximity.set(1);
    const next = valueFromClientX(event.clientX, true);
    applyLive(next);
    commitNearest(next);
    publishApproach(liveRef.current, true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    updateProximity(event.clientX, event.clientY);
    if (!draggingRef.current) return;

    const next = valueFromClientX(event.clientX, true);
    const delta = next - liveRef.current;
    if (Math.abs(delta) > 0.002) {
      headingRef.current = delta > 0 ? 1 : -1;
    }
    applyLive(next);
    commitNearest(next);
    publishApproach(next, true);
  };

  const onPointerLeave = () => {
    if (!draggingRef.current) proximity.set(0);
  };

  const setCommitted = (target: number) => {
    const snapped = snapTo(target, min, max, step);
    committedRef.current = snapped;
    liveRef.current = snapped;
    if (reduceMotion) {
      live.set(snapped);
      stretch.set(0);
    } else {
      animate(live, snapped, {
        type: "spring",
        stiffness: 420,
        damping: 18,
        mass: 0.55,
      });
      animate(stretch, 0, { type: "spring", stiffness: 380, damping: 16 });
    }
    onChange(snapped);
    publishApproach(snapped, false);
  };

  const bump = (delta: number) => {
    setCommitted(committedRef.current + delta * step);
  };

  return (
    <motion.div
      className={cn(
        "flex h-6 w-[7rem] items-center rounded-full px-2",
        "bg-[#1a1a1a]/95 shadow-raised ring-1 ring-white/[0.08] backdrop-blur-md",
        "supports-[backdrop-filter]:bg-[#1a1a1a]/88",
        className,
      )}
      style={{
        scaleX: pillScaleX,
        scaleY: pillScaleY,
        transformOrigin: pillOrigin,
      }}
    >
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={getAriaValueText?.(value)}
        aria-label={getAriaLabel?.(value) ?? "Slider"}
        className="relative h-full w-full touch-none select-none outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            bump(1);
          } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            bump(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            setCommitted(min);
          } else if (event.key === "End") {
            event.preventDefault();
            setCommitted(max);
          }
        }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-white/[0.1]"
        />
        <motion.span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
            "border border-white/15 bg-neutral-100 shadow-raised",
          )}
          style={{ left: thumbLeft, scale: thumbScale }}
        />
      </div>
    </motion.div>
  );
}
