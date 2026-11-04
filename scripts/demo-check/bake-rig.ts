// Bake a drafted cursor rig onto its target layer: the demo check's bake
// step. Same channels and tolerances as the app's bakeRig
// (apps/desktop/src/effects/effect-model.ts); flat channels stay out so the
// key count stays honest. Reads spec+rig JSON, prints the baked payload.
import { simulateRig } from "../../packages/effects/src/rig.js";
import { bakeKeyframes } from "../../packages/effects/src/bake.js";
import type { EffectSpec } from "../../packages/effects/src/types.js";
import { readFileSync } from "node:fs";

type Rig = {
  inputPath: { time: number; x: number; y: number }[];
  stiffness?: number;
  damping?: number;
  mass?: number;
  swing?: boolean;
  tilt?: boolean;
  squash?: boolean;
  overshoot?: boolean;
};

type Sample = { t: number; v: number };

const CHANNELS = [
  { prop: "x", tolerance: 1.5, pick: (f: { x: number }) => f.x },
  { prop: "y", tolerance: 1.5, pick: (f: { y: number }) => f.y },
  { prop: "rotation", tolerance: 0.004, pick: (f: { rotation: number }) => f.rotation },
] as const;

function targetId(spec: EffectSpec): string | null {
  const moving = spec.layers.find((layer) => layer.curves?.["x"] || layer.curves?.["y"]);
  if (moving) return moving.id;
  const drawn = spec.layers.filter((layer) => layer.type === "text" || layer.type === "shape");
  return drawn.length > 1 ? drawn[drawn.length - 1]!.id : (drawn[0]?.id ?? null);
}

function flat(samples: Sample[]): boolean {
  const first = samples[0]?.v ?? 0;
  return samples.every((sample) => Math.abs(sample.v - first) < 1e-6);
}

const [specPath, rigPath, fpsArg] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath!, "utf8")) as EffectSpec;
const rig = JSON.parse(readFileSync(rigPath!, "utf8")) as Rig;
const fps = Number(fpsArg);
const target = spec.layers.find((layer) => layer.id === targetId(spec)) ?? null;

if (!target) {
  console.log(JSON.stringify({ targetId: null, baked: null, keys: 0, frames: 0, flat: [] }));
  process.exit(0);
}
const frames = simulateRig(rig, fps);
const baseW = typeof target.params?.["scaleX"] === "number" ? target.params["scaleX"] : 0;
const baseH = typeof target.params?.["scaleY"] === "number" ? target.params["scaleY"] : 0;
const channels: { prop: string; tolerance: number; samples: Sample[] }[] = CHANNELS.map((c) => ({
  prop: c.prop,
  tolerance: c.tolerance,
  samples: frames.map((f) => ({ t: f.time, v: c.pick(f) })),
}));
if (target.type === "shape" && baseW > 0 && baseH > 0) {
  channels.push(
    { prop: "scaleX", tolerance: baseW * 0.01, samples: frames.map((f) => ({ t: f.time, v: baseW * f.scaleX })) },
    { prop: "scaleY", tolerance: baseH * 0.01, samples: frames.map((f) => ({ t: f.time, v: baseH * f.scaleY })) },
  );
}
const props: Record<string, unknown[]> = {};
const dropped: string[] = [];
let keys = 0;
for (const channel of channels) {
  if (flat(channel.samples)) {
    dropped.push(channel.prop);
    continue;
  }
  const baked = bakeKeyframes(channel.samples, channel.tolerance, { fps });
  props[channel.prop] = baked;
  keys += baked.length;
}
console.log(
  JSON.stringify({ targetId: target.id, baked: { [target.id]: props }, keys, frames: frames.length, flat: dropped }),
);
