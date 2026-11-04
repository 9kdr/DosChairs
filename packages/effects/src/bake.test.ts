import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bakeError, bakeKeyframes } from "./bake.js";
import { evaluateCurve } from "./curves.js";
import type { EffectSpec, Sample } from "./types.js";

function bounceSamples(): { samples: Sample[]; fps: number } {
  const spec = JSON.parse(
    readFileSync(new URL("../../../fixtures/effects/bounce-title.effect.json", import.meta.url), "utf8"),
  ) as EffectSpec;
  const curve = spec.layers.find((l) => l.id === "ball")!.curves!["y"]!;
  const fps = spec.fps;
  const samples: Sample[] = [];
  for (let f = 0; f <= Math.round(spec.durationSec * fps); f++) {
    const t = f / fps;
    samples.push({ t, v: evaluateCurve(curve, t) });
  }
  return { samples, fps };
}

describe("keyframe bake", () => {
  it("keeps error under a tight tolerance on a bouncing path", () => {
    const { samples, fps } = bounceSamples();
    const keys = bakeKeyframes(samples, 2, { fps });
    expect(bakeError(samples, keys)).toBeLessThanOrEqual(2);
  });

  it("reduces key count on a bouncing path", () => {
    const { samples, fps } = bounceSamples();
    const tolerance = 8;
    const keys = bakeKeyframes(samples, tolerance, { fps });
    expect(bakeError(samples, keys)).toBeLessThanOrEqual(tolerance);
    expect(keys.length).toBeLessThan(samples.length / 2);
    // Key count before/after for the report.
    console.log(`bake: ${samples.length} samples -> ${keys.length} keys (tol ${tolerance}px)`);
  });

  it("keeps the endpoints and snaps times to the frame grid", () => {
    const { samples, fps } = bounceSamples();
    const keys = bakeKeyframes(samples, 2, { fps });
    expect(keys[0]!.time).toBe(samples[0]!.t);
    expect(keys[keys.length - 1]!.time).toBe(samples[samples.length - 1]!.t);
    for (const k of keys) {
      expect(Math.abs(k.time * fps - Math.round(k.time * fps))).toBeLessThan(1e-9);
    }
  });

  it("returns no keys for no samples", () => {
    expect(bakeKeyframes([], 1, { fps: 30 })).toEqual([]);
  });

  it("needs only endpoints for a straight ramp", () => {
    const samples: Sample[] = Array.from({ length: 31 }, (_, f) => ({ t: f / 30, v: f * 2 }));
    const keys = bakeKeyframes(samples, 0.5, { fps: 30 });
    expect(keys.length).toBe(2);
  });
});
