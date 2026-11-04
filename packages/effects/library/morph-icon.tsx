/**
 * Morphing Icon (gold module): one path breathes between circle, star, and
 * square on a flubber interpolation, wrapped in the kit glow.
 *
 * Seeking: flubber's `interpolate(a, b)` is already a pure function of the
 * blend, so the render pass calls `morphAt()` directly and the animation
 * lives in the `d` attribute the probe reads. The client re-seeks the same
 * interpolator through `createFlubberAdapter` on the path node.
 */
import React from "react";
import { interpolate } from "flubber";
import type { EffectProps, PropSpec } from "@chair/effects";
import { clamp, createFlubberAdapter, GlowWrap, morphAt, num } from "@chair/effects";
import type { FlubberInterpolate } from "@chair/effects";

const interpolateFn = interpolate as unknown as FlubberInterpolate;

export const meta = {
  id: "morph-icon",
  name: "Morphing Icon",
  kind: "generator",
  durationSec: 8,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  speed: { type: "number", min: 0.2, max: 2, default: 0.8, title: "Morph Speed" },
  size: { type: "number", min: 120, max: 640, default: 360, title: "Icon Size" },
  thickness: { type: "number", min: 2, max: 16, default: 7, title: "Stroke" },
  glow: { type: "number", min: 0, max: 1, default: 0.7, title: "Glow" },
  accent: { type: "color", default: "#ff6a00", title: "Accent" },
  paper: { type: "color", default: "#101018", title: "Paper" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  speed: number;
  size: number;
  thickness: number;
  glow: number;
  accent: string;
  paper: string;
}>;

const CIRCLE = "M50 8 A42 42 0 1 1 49.9 8 Z";
const STAR = "M50 4 L61 36 L95 37 L68 57 L78 91 L50 71 L22 91 L32 57 L5 37 L39 36 Z";
const SQUARE = "M14 14 H86 V86 H14 Z";
const SHAPES = [CIRCLE, STAR, SQUARE];

function shapeAt(t: number, speed: number): { d: string; segment: number; u: number } {
  const cycle = SHAPES.length * 2;
  const raw = (((t * speed) % cycle) + cycle) % cycle;
  const segment = Math.floor(raw / 2) % SHAPES.length;
  const u = (raw % 2) / 2;
  const eased = u * u * (3 - 2 * u);
  const from = SHAPES[segment]!;
  const to = SHAPES[(segment + 1) % SHAPES.length]!;
  return { d: morphAt(interpolateFn, from, to, eased, { maxSegmentLength: 2 }), segment, u: eased };
}

export default function MorphIcon(p: Props): React.ReactElement {
  const { t, history, width, height } = p;
  const n = (name: string, fallback: number) => num(history, name, t, fallback);
  const c = (name: string, fallback: string) => String(history(name, t) ?? fallback);
  const speed = clamp(n("speed", 0.8), 0.2, 2);
  const size = clamp(n("size", 360), 120, 640);
  const thickness = clamp(n("thickness", 7), 2, 16);
  const glow = clamp(n("glow", 0.7), 0, 1);
  const accent = c("accent", "#ff6a00");
  const { d, segment, u } = shapeAt(Math.max(0, t), speed);
  const pathRef = React.useRef<SVGPathElement | null>(null);

  React.useLayoutEffect(() => {
    if (!pathRef.current) return;
    const node = pathRef.current;
    const adapter = createFlubberAdapter(
      interpolateFn,
      (next) => node.setAttribute("d", next),
      SHAPES[segment]!,
      SHAPES[(segment + 1) % SHAPES.length]!,
      1,
      { maxSegmentLength: 2 },
    );
    adapter.init(null, {});
    adapter.seek(u);
    return () => adapter.dispose();
  });

  return (
    <div
      style={{ position: "absolute", inset: 0, background: c("paper", "#101018") }}
      data-seg={`${segment}:${u.toFixed(3)}`}
      data-d-len={d.length}
      data-style={`${size.toFixed(0)}:${thickness.toFixed(1)}:${glow.toFixed(2)}`}
    >
      <GlowWrap color={accent} strength={glow} radius={size * 0.09}>
        <svg
          width={width}
          height={height}
          viewBox="0 0 100 100"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          preserveAspectRatio="xMidYMid meet"
        >
          <g transform={`translate(50 50) scale(${(size / 160).toFixed(3)}) translate(-50 -50)`}>
            <path
              ref={pathRef}
              d={d}
              fill="none"
              stroke={accent}
              strokeWidth={thickness}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        </svg>
      </GlowWrap>
    </div>
  );
}
