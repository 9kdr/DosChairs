/**
 * Expressive mouse rig (reference module).
 *
 * Keyframe the invisible target (Target X / Target Y) in the Inspector the way
 * you would a rough mouse path. The cursor you see never follows it rigidly:
 * it chases the target on a spring (overshoot), swings and tilts into its own
 * velocity, and squashes when it brakes. Springs, swing, and squash are
 * re-simulated from 0..t at a fixed 240 Hz step from history(), so scrubbing
 * to any frame in any order paints the same frame.
 */
import React from "react";
import { hexToRgba, num, simulateFollower } from "@chair/effects";
import type { EffectProps, PropSpec } from "@chair/effects";

export const meta = {
  id: "expressive-mouse",
  name: "Expressive Mouse",
  kind: "rig",
  durationSec: 10,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  targetX: { type: "number", min: 0, max: 1920, default: 960, title: "Target X" },
  targetY: { type: "number", min: 0, max: 1080, default: 540, title: "Target Y" },
  stiffness: { type: "number", min: 20, max: 400, default: 150, title: "Spring Stiffness" },
  damping: { type: "number", min: 3, max: 40, default: 11, title: "Spring Damping" },
  swing: { type: "number", min: 0, max: 2, default: 1, title: "Swing & Tilt" },
  squash: { type: "number", min: 0, max: 2, default: 1, title: "Squash & Stretch" },
  size: { type: "number", min: 30, max: 400, default: 140, title: "Cursor Size" },
  accent: { type: "color", default: "#ff6a00", title: "Cursor Color" },
  outline: { type: "color", default: "#141414", title: "Outline Color" },
  showTarget: { type: "boolean", default: false, title: "Show Target" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  targetX: number;
  targetY: number;
  stiffness: number;
  damping: number;
  swing: number;
  squash: number;
  size: number;
  accent: string;
  outline: string;
  showTarget: boolean;
}>;

// Arrow in a 100x100 box; the hot spot (the tip) is at (14, 8).
const ARROW = "M14 8 L14 84 L34 66 L48 96 L62 90 L48 60 L76 60 Z";
const TIP = { x: 14, y: 8 };

export default function ExpressiveMouse(p: Props): React.ReactElement {
  const { t, history, width, height } = p;
  const swing = num(history, "swing", t, 1);
  const squash = num(history, "squash", t, 1);
  const size = num(history, "size", t, 140);
  const pose = simulateFollower(history, "targetX", "targetY", t, {
    stiffness: num(history, "stiffness", t, 150),
    damping: num(history, "damping", t, 11),
    tiltGain: 0.0011 * swing,
    maxTilt: 0.7 * Math.max(swing, 0.01),
    stretchGain: 0.00045 * squash,
    maxStretch: 0.45 * Math.max(squash, 0.01),
  });
  const accent = String(history("accent", t) ?? "#ff6a00");
  const outline = String(history("outline", t) ?? "#141414");
  const showTarget = history("showTarget", t) === true;
  const tx = num(history, "targetX", t, 960);
  const ty = num(history, "targetY", t, 540);
  const scale = size / 100;
  const deg = (pose.tilt * 180) / Math.PI;
  const heading = (pose.heading * 180) / Math.PI;
  // Tip-anchored: translate to the follower, tilt about the tip, squash along the heading.
  const transform =
    `translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) rotate(${deg.toFixed(3)}) ` +
    `rotate(${heading.toFixed(3)}) scale(${(pose.scaleAlong * 1).toFixed(4)} ${pose.scaleAcross.toFixed(4)}) rotate(${(-heading).toFixed(3)}) ` +
    `scale(${scale.toFixed(4)}) translate(${-TIP.x} ${-TIP.y})`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    >
      {showTarget ? (
        <g stroke={accent} strokeWidth={3} opacity={0.8} fill="none">
          <circle cx={tx} cy={ty} r={18} />
          <path d={`M${tx - 30} ${ty} H${tx + 30} M${tx} ${ty - 30} V${ty + 30}`} />
        </g>
      ) : null}
      <g transform={transform}>
        <path d={ARROW} fill={hexToRgba("#000000", 0.28)} transform="translate(4 6)" />
        <path d={ARROW} fill={accent} stroke={outline} strokeWidth={5} strokeLinejoin="round" />
      </g>
    </svg>
  );
}
