// Sample a generated cursor piece's feel: run the kit follower sim
// (packages/effects/src/kit/physics.ts, the same spring the bundled piece
// uses) over the demo's swing-in target path with the generated prop
// values, and print the follower poses. Reads one JSON file, prints poses.
// Run: node --import ./ts-register.mjs ./sim-rig.ts values.json
import { DEFAULT_SWING_LENGTH, simulateFollower } from "../../packages/effects/src/kit/physics.js";
import { readFileSync } from "node:fs";

type PathKey = { time: number; x: number; y: number };
type Values = {
  xName: string;
  yName: string;
  path: PathKey[];
  stiffness: number;
  damping: number;
  mass: number;
  swing: number;
  squash: number;
  overshoot: boolean;
  durationSec: number;
  samples: number;
};

const [valuesPath] = process.argv.slice(2);
const values = JSON.parse(readFileSync(valuesPath!, "utf8")) as Values;

function atPath(path: PathKey[], t: number): { x: number; y: number } {
  const keys = [...path].sort((a, b) => a.time - b.time);
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.time) return { x: first.x, y: first.y };
  if (t >= last.time) return { x: last.x, y: last.y };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= a.time && t <= b.time) {
      const u = (t - a.time) / Math.max(1e-9, b.time - a.time);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return { x: last.x, y: last.y };
}

const consts: Record<string, number | boolean> = {
  stiffness: values.stiffness,
  damping: values.damping,
  mass: values.mass,
  swing: values.swing,
  squash: values.squash,
  overshoot: values.overshoot,
};

function history(name: string, t: number): number | string | boolean | undefined {
  if (name === values.xName) return atPath(values.path, t).x;
  if (name === values.yName) return atPath(values.path, t).y;
  return consts[name];
}

// Same mapping as the expressive-mouse reference module: overshoot off is
// exactly critical damping; swing scales the pendulum's length and max swing.
const damping =
  values.overshoot === false
    ? 2 * Math.sqrt(values.stiffness * Math.max(values.mass, 1e-6))
    : values.damping;
const opts = {
  stiffness: values.stiffness,
  damping,
  mass: values.mass,
  swingLength: DEFAULT_SWING_LENGTH / Math.min(Math.max(values.swing, 0.01), 2),
  maxSwing: 0.7 * Math.max(values.swing, 0),
  stretchGain: 0.00045 * values.squash,
  maxStretch: 0.45 * Math.max(values.squash, 0.01),
};

const poses = [];
for (let i = 0; i < values.samples; i++) {
  const t = (i * values.durationSec) / Math.max(values.samples - 1, 1);
  const pose = simulateFollower(history, values.xName, values.yName, t, opts);
  poses.push({ t: Math.round(t * 1000) / 1000, x: pose.x, y: pose.y, tilt: pose.tilt });
}
console.log(JSON.stringify({ poses }));
