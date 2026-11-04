/** Reduce per-frame samples to minimal Bezier keyframes within tolerance. */
import { evaluateCurve } from "./curves.js";
import type { Keyframe, Sample } from "./types.js";

export interface BakeOptions {
  /** Frames per second: key times snap to this grid. */
  fps: number;
}

/** Chord error of sample i against the line from a to b. */
function deviation(samples: Sample[], a: number, b: number, i: number): number {
  const A = samples[a]!;
  const B = samples[b]!;
  const P = samples[i]!;
  const span = B.t - A.t;
  const u = span <= 0 ? 0 : (P.t - A.t) / span;
  return Math.abs(P.v - (A.v + (B.v - A.v) * u));
}

function rdp(samples: Sample[], tolerance: number, a: number, b: number, keep: boolean[]): void {
  let worst = 0;
  let idx = -1;
  for (let i = a + 1; i < b; i++) {
    const d = deviation(samples, a, b, i);
    if (d > worst) {
      worst = d;
      idx = i;
    }
  }
  if (worst > tolerance && idx > 0) {
    keep[idx] = true;
    rdp(samples, tolerance, a, idx, keep);
    rdp(samples, tolerance, idx, b, keep);
  }
}

/**
 * Greedy keyframe reduction (Ramer-Douglas-Peucker): keeps endpoints, splits
 * at the worst offender until every sample sits within tolerance of the baked
 * curve. Keys snap to the frame grid; handles carry Catmull-Rom tangents in
 * Resolve Bezierspline [dtSec, dv] form for the export side.
 */
export function bakeKeyframes(samples: Sample[], tolerance: number, opts: BakeOptions): Keyframe[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const keep = new Array<boolean>(sorted.length).fill(false);
  keep[0] = true;
  keep[sorted.length - 1] = true;
  rdp(sorted, tolerance, 0, sorted.length - 1, keep);

  const picked = sorted.filter((_, i) => keep[i]);
  return picked.map((s, i) => {
    const prev = picked[Math.max(0, i - 1)]!;
    const next = picked[Math.min(picked.length - 1, i + 1)]!;
    const tangent = (next.v - prev.v) / Math.max(1e-9, next.t - prev.t);
    const dt = Math.min(s.t - prev.t, next.t - s.t, 1 / opts.fps) / 3 || 1 / opts.fps / 3;
    const key: Keyframe = {
      time: Math.round(s.t * opts.fps) / opts.fps,
      value: s.v,
      easing: "linear",
      inHandle: [-dt, -tangent * dt],
      outHandle: [dt, tangent * dt],
    };
    return key;
  });
}

/** Max absolute error of the baked keys against the original samples. */
export function bakeError(samples: Sample[], keys: Keyframe[]): number {
  if (keys.length === 0) return samples.length === 0 ? 0 : Infinity;
  const curve = { keyframes: keys };
  let worst = 0;
  for (const s of samples) {
    worst = Math.max(worst, Math.abs(s.v - evaluateCurve(curve, s.t)));
  }
  return worst;
}
