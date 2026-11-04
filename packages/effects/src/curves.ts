/** Pure curve evaluation and per-frame layer resolution. No GL: testable in node. */
import type { Curve, EffectSpec, Layer } from "./types.js";

export function ease(u: number, kind: string | undefined): number {
  const t = Math.min(1, Math.max(0, u));
  switch (kind) {
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    case "easeInOut": {
      const c = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      return c;
    }
    case "hold":
      return 0;
    default:
      return t;
  }
}

export function evaluateCurve(curve: Curve, t: number): number {
  const keys = [...curve.keyframes].sort((a, b) => a.time - b.time);
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (t <= first.time) return first.value;
  if (t >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span <= 0 ? 0 : (t - a.time) / span;
      return a.value + (b.value - a.value) * ease(u, a.easing);
    }
  }
  return last.value;
}

export type ResolvedLayer = Layer & { resolved: Record<string, string | number | boolean> };

function controlValues(spec: EffectSpec, overrides: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const c of spec.controls ?? []) map.set(c.id, c.default);
  for (const [k, v] of Object.entries(overrides)) map.set(k, v);
  return map;
}

/** Resolve every layer's params at time t: static params, then curves, then published controls. */
export function resolveFrame(
  spec: EffectSpec,
  t: number,
  controls: Record<string, unknown> = {},
): ResolvedLayer[] {
  const values = controlValues(spec, controls);
  const byLayer = new Map<string, { param: string; value: unknown }[]>();
  for (const c of spec.controls ?? []) {
    const v = values.get(c.id) ?? c.default;
    const list = byLayer.get(c.target.layerId) ?? [];
    list.push({ param: c.target.param, value: v });
    byLayer.set(c.target.layerId, list);
  }
  return spec.layers.map((layer) => {
    const resolved: Record<string, string | number | boolean> = { ...(layer.params ?? {}) };
    for (const [prop, curve] of Object.entries(layer.curves ?? {})) {
      resolved[prop] = evaluateCurve(curve, t);
    }
    for (const { param, value } of byLayer.get(layer.id) ?? []) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        resolved[param] = value;
      }
    }
    return { ...layer, resolved };
  });
}
