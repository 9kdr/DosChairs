/**
 * Effect Maker model: pure helpers between an effect spec and the screen.
 * The rig re-simulates and bakes in the browser, so tweaking a spring
 * never calls the agent. Nothing here touches the timeline; `effectItem`
 * only builds the proposed edit the apply pipeline takes.
 */
import {
  bakeKeyframes,
  simulateRig,
  type Control,
  type Curve,
  type EffectSpec,
  type Keyframe,
  type Rig,
  type Sample,
} from "@chair/effects";
import type { ChangesetItem } from "@chair/timeline-ir";

export type ControlValue = string | number | boolean;
export type ControlValues = Record<string, ControlValue>;

/** The rig fields a person can turn. Ranges sit around the sim's defaults. */
export const RIG_SLIDERS = [
  { key: "stiffness", label: "Stiffness", min: 10, max: 400, step: 1, fallback: 90 },
  { key: "damping", label: "Damping", min: 1, max: 60, step: 0.5, fallback: 12 },
  { key: "mass", label: "Mass", min: 0.2, max: 4, step: 0.1, fallback: 1 },
] as const;

export const RIG_TOGGLES = [
  { key: "swing", label: "Swing" },
  { key: "tilt", label: "Tilt" },
  { key: "squash", label: "Squash" },
  { key: "overshoot", label: "Overshoot" },
] as const;

export type RigSliderKey = (typeof RIG_SLIDERS)[number]["key"];
export type RigToggleKey = (typeof RIG_TOGGLES)[number]["key"];

/** Starter chips: a tap fills the prompt. */
export const STARTER_PROMPTS = [
  { label: "Bouncy title", prompt: "A bouncy title with overshoot that settles with a little squash" },
  { label: "Dither on footage", prompt: "An ordered dither look over footage, chunky 1-bit pixels, adjustable amount" },
  { label: "Expressive cursor", prompt: "An expressive cursor with swing, tilt and a springy catch-up" },
  { label: "Glow lower third", prompt: "A lower third that slides in with a soft glow and a staggered subtitle" },
] as const;

/** Every control starts at its published default. */
export function defaultControls(spec: EffectSpec): ControlValues {
  const values: ControlValues = {};
  for (const control of spec.controls ?? []) values[control.id] = control.default;
  return values;
}

/** Slider bounds for a number control; unbounded controls get a range around the default. */
export function controlRange(control: Control): { min: number; max: number; step: number } {
  const base = typeof control.default === "number" ? control.default : 0;
  const min = control.min ?? Math.min(0, base);
  const max = control.max ?? (base > 0 ? base * 2 : 1);
  const span = max - min;
  return { min, max, step: span > 20 ? 1 : span > 2 ? 0.1 : 0.01 };
}

/** The layer the rig moves: the first one already animating x or y, else the last text/shape. */
export function rigTargetId(spec: EffectSpec): string | null {
  const moving = spec.layers.find((layer) => layer.curves?.["x"] || layer.curves?.["y"]);
  if (moving) return moving.id;
  const drawn = spec.layers.filter((layer) => layer.type === "text" || layer.type === "shape");
  return drawn.length > 1 ? drawn[drawn.length - 1]!.id : (drawn[0]?.id ?? null);
}

export function rigOf(spec: EffectSpec): Rig | null {
  return spec.rig && spec.rig.inputPath.length > 0 ? spec.rig : null;
}

const CHANNELS = [
  { prop: "x", tolerance: 1.5, pick: (f: { x: number }) => f.x },
  { prop: "y", tolerance: 1.5, pick: (f: { y: number }) => f.y },
  { prop: "rotation", tolerance: 0.004, pick: (f: { rotation: number }) => f.rotation },
] as const;

function flat(samples: Sample[]): boolean {
  const first = samples[0]?.v ?? 0;
  return samples.every((sample) => Math.abs(sample.v - first) < 1e-6);
}

export type RigBake = {
  /** The spec with the target layer's curves replaced by the baked rig. */
  spec: EffectSpec;
  /** Total baked keyframes across every moved channel. */
  keys: number;
  /** Frames the sim ran for, before reduction. */
  frames: number;
};

/**
 * Re-simulate the rig and bake it onto its target layer. Flat channels
 * (a rotation that never moves) stay out so the key count stays honest.
 */
export function bakeRig(spec: EffectSpec, rig: Rig | null): RigBake {
  const targetId = rigTargetId(spec);
  if (!rig || rig.inputPath.length === 0 || !targetId) return { spec, keys: 0, frames: 0 };
  const frames = simulateRig(rig, spec.fps);
  const target = spec.layers.find((layer) => layer.id === targetId)!;
  const baseW = typeof target.params?.["scaleX"] === "number" ? target.params["scaleX"] : 0;
  const baseH = typeof target.params?.["scaleY"] === "number" ? target.params["scaleY"] : 0;
  const curves: Record<string, Curve> = { ...(target.curves ?? {}) };
  let keys = 0;

  const channels = [
    ...CHANNELS.map((channel) => ({
      prop: channel.prop,
      tolerance: channel.tolerance,
      samples: frames.map((frame): Sample => ({ t: frame.time, v: channel.pick(frame) })),
    })),
    // Squash and stretch scale a shape's own size; text has no size param to scale.
    ...(target.type === "shape" && baseW > 0 && baseH > 0
      ? [
          { prop: "scaleX", tolerance: baseW * 0.01, samples: frames.map((f): Sample => ({ t: f.time, v: baseW * f.scaleX })) },
          { prop: "scaleY", tolerance: baseH * 0.01, samples: frames.map((f): Sample => ({ t: f.time, v: baseH * f.scaleY })) },
        ]
      : []),
  ];
  for (const channel of channels) {
    if (flat(channel.samples)) {
      delete curves[channel.prop];
      continue;
    }
    const baked: Keyframe[] = bakeKeyframes(channel.samples, channel.tolerance, { fps: spec.fps });
    curves[channel.prop] = { keyframes: baked };
    keys += baked.length;
  }

  return {
    spec: {
      ...spec,
      rig,
      layers: spec.layers.map((layer) => (layer.id === targetId ? { ...layer, curves } : layer)),
    },
    keys,
    frames: frames.length,
  };
}

/** Layer id to prop key lists: the shape POST /effects/rig/apply reads as `baked`. */
export type BakedPayload = Record<string, Record<string, Keyframe[]>>;

/**
 * The baked curves for the apply call: the target layer's live curves,
 * verbatim. Undefined when the layer has no keys, so the call sends the
 * spec alone and Resolve reads its own curves.
 */
export function bakedPayload(spec: EffectSpec, targetId: string | null): BakedPayload | undefined {
  const layer = targetId ? spec.layers.find((entry) => entry.id === targetId) : undefined;
  if (!layer?.curves) return undefined;
  const props: Record<string, Keyframe[]> = {};
  for (const [prop, curve] of Object.entries(layer.curves)) {
    if (curve.keyframes.length > 0) props[prop] = curve.keyframes;
  }
  return Object.keys(props).length > 0 ? { [layer.id]: props } : undefined;
}

/** Where an applied piece landed in Resolve, so a re-apply finds the same clip. */
export type PieceLanding = {
  project: string;
  timeline: string;
  trackIndex: number;
  clipIndex: number;
  trackType: "video" | "audio";
  compName: string | null;
  prevCompName: string | null;
};

export type ExportInfo = { target: string; label: string; reason: string; fallback: boolean };

const TARGET_LABELS: Record<string, string> = {
  "fusion-macro": "Fusion macro",
  "fusion-fuse": "Fusion Fuse",
  ograf: "OGraf title",
  "rendered-clip": "Rendered clip",
};

/** Where the effect lands in Resolve and, in plain words, why. */
export function exportInfo(spec: EffectSpec): ExportInfo {
  const target = spec.export?.target ?? "fusion-macro";
  const label = TARGET_LABELS[target] ?? target;
  const fallback = spec.export?.fallback;
  if (fallback) return { target, label, reason: fallback.reason, fallback: true };
  const reasons: Record<string, string> = {
    "fusion-macro": "Every layer maps to a native Fusion node, so it stays an editable macro.",
    "fusion-fuse": "Custom code runs as a Fuse inside Fusion, still live in Resolve.",
    ograf: "It lands as a native title with live parameters.",
    "rendered-clip": "It ships as a pre-rendered clip with alpha.",
  };
  return { target, label, reason: reasons[target] ?? "", fallback: false };
}

/** Time as m:ss.cc for the transport readout. */
export function stamp(seconds: number): string {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = (whole - minutes * 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${rest}`;
}

/**
 * The proposed edit for "Apply to Resolve": an add_effect item that
 * points at the spec by id. The patch carries the tweaks (controls and
 * rig) so history shows them, and the export fallback rides along so the
 * same plain-words line shows there. Recorded only after Resolve
 * answers: `resolve` carries the comp it landed as and the previous
 * comp name, which is the undo back.
 */
export function effectItem(input: {
  spec: EffectSpec;
  controls: ControlValues;
  targetId: string;
  bakedKeys: number;
  resolve?: { compName: string | null; prevCompName: string | null };
  now?: number;
}): ChangesetItem {
  const { spec, controls, targetId, bakedKeys } = input;
  const id = `fx-${spec.id}-${(input.now ?? Date.now()).toString(36)}`;
  const info = exportInfo(spec);
  const params: Record<string, unknown> = {
    ...controls,
    exportTarget: info.target,
    ...(bakedKeys > 0 ? { rigKeys: bakedKeys } : {}),
  };
  return {
    id,
    op: "add_effect",
    targetId,
    specRef: spec.id,
    rationale: `Effect Maker: ${spec.name}, lands as ${info.label.toLowerCase()}.`,
    patch: {
      effectId: id,
      presetName: spec.name,
      specRef: spec.id,
      params,
      ...(spec.rig ? { rig: spec.rig } : {}),
      ...(input.resolve ? { resolve: { ...input.resolve } } : {}),
    },
    ...(spec.export?.fallback ? { fallback: { ...spec.export.fallback } } : {}),
    status: "pending",
  };
}
