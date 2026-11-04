/** The Chair effect module contract: what a generated or hand-written TSX file exports. */

export type PropValue = number | string | boolean | undefined;

/**
 * A prop's value at any time (seconds since the effect started). Backed by the
 * OGraf action schedule's timestamped updateAction events, or by a baked
 * keyframe table when the host sends none. Pure: it never depends on call order.
 */
export type History = (name: string, t: number) => PropValue;

export type PropSpec =
  | { type: "number"; default: number; min?: number; max?: number; title?: string }
  | { type: "color"; default: string; title?: string }
  | { type: "string"; default: string; title?: string }
  | { type: "boolean"; default: boolean; title?: string };

export type ModuleKind = "generator" | "overlay" | "rig" | "transition";

export interface EffectMeta {
  id: string;
  name: string;
  kind: ModuleKind;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
}

/** What the wrapper hands the default export every frame, next to the module's own props. */
export interface FrameProps {
  /** Seconds since the effect started. The only clock. */
  t: number;
  frame: number;
  fps: number;
  width: number;
  height: number;
  history: History;
  /** Bundle-time JSON payload (`data.keyframes` is the baked history table). */
  data?: unknown;
}

export type EffectProps<P = Record<string, never>> = FrameProps & P;

/** Numeric history read with a fallback, so a missing or non-numeric value never yields NaN. */
export function num(history: History, name: string, t: number, fallback = 0): number {
  const v = history(name, t);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
