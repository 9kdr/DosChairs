/** Deterministic fixed-timestep spring/secondary-motion sim. Pure: same input, same frames. */
import type { Rig, RigFrame } from "./types.js";

export interface RigOptions {
  /** Extra seconds holding the last input while the sim settles. Default 1. */
  settleSec?: number;
}

function targetAt(path: { time: number; x: number; y: number }[], t: number): { x: number; y: number } {
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

/**
 * Run the expressive-mouse rig: the follower chases the rough input path on a
 * spring (momentum + overshoot), with swing lag, tilt into velocity, and
 * squash-and-stretch on landing. Returns one frame per 1/fps.
 */
export function simulateRig(rig: Rig, fps: number, opts: RigOptions = {}): RigFrame[] {
  const k = rig.stiffness ?? 90;
  const m = rig.mass ?? 1;
  let c = rig.damping ?? 12;
  if (rig.overshoot === false) c = Math.max(c, 2 * Math.sqrt(k * m));
  const swingOn = rig.swing !== false;
  const tiltOn = rig.tilt !== false;
  const squashOn = rig.squash !== false;

  const end = Math.max(...rig.inputPath.map((p) => p.time));
  const total = end + (opts.settleSec ?? 1);
  const frames = Math.max(1, Math.round(total * fps));
  const sub = 4;
  const dt = 1 / fps / sub;

  let x = rig.inputPath[0]!.x;
  let y = rig.inputPath[0]!.y;
  let vx = 0;
  let vy = 0;
  let swing = 0;
  let swingV = 0;
  let squashImpulse = 0;
  let prevVy = 0;
  const out: RigFrame[] = [];

  for (let f = 0; f <= frames; f++) {
    const t = f / fps;
    for (let s = 0; s < sub; s++) {
      const st = Math.min(t + (s / sub) * (1 / fps), total);
      const tgt = targetAt(rig.inputPath, st);
      const ax = (k * (tgt.x - x) - c * vx) / m;
      const ay = (k * (tgt.y - y) - c * vy) / m;
      vx += ax * dt;
      vy += ay * dt;
      x += vx * dt;
      y += vy * dt;
      // Swing: pendulum angle chases lag behind horizontal velocity.
      const swingTarget = swingOn ? clamp(-vx * 0.0009, -0.5, 0.5) : 0;
      const sA = 120 * (swingTarget - swing) - 14 * swingV;
      swingV += sA * dt;
      swing += swingV * dt;
      // Landing: falling fast then velocity flips at the bottom of a bounce.
      if (squashOn && prevVy > 60 && vy <= 0 && st <= end + 0.001) {
        squashImpulse = Math.min(0.35, prevVy * 0.0004);
      }
      squashImpulse *= Math.exp(-6 * dt);
      prevVy = vy;
    }
    const speed = Math.hypot(vx, vy);
    const stretch = squashOn ? Math.min(0.25, speed * 0.00012) : 0;
    const imp = squashOn ? squashImpulse : 0;
    out.push({
      time: t,
      x,
      y,
      rotation: (swingOn ? swing : 0) + (tiltOn ? clamp(vx * 0.00012, -0.3, 0.3) : 0),
      scaleX: 1 + stretch + imp,
      scaleY: 1 - stretch * 0.8 - imp * 0.9,
    });
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
