/**
 * Bake a spec Rig to per-frame keys through the kit spring sim. Same input,
 * same frames: the follower re-simulates from 0..t at a fixed step, so this
 * is the piece sim (simulateFollower) sampled on a frame grid, not a second
 * physics model. The desktop bake and the spec preview share it.
 */
import type { History } from "./types.js";
import { DEFAULT_MAX_SWING, DEFAULT_SWING_DAMPING, DEFAULT_SWING_LENGTH, simulateFollower } from "./physics.js";
import type { Rig, RigFrame, RigPathKey } from "../types.js";

export interface RigOptions {
  /** Extra seconds holding the last input while the sim settles. Default 1. */
  settleSec?: number;
}

function targetAt(path: RigPathKey[], t: number): { x: number; y: number } {
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
 * Run the expressive-mouse rig: the tip tracks the rough input path (tight by
 * default, momentum + overshoot when asked), the body swings about the tip as
 * a pendulum, with squash-and-stretch. Returns one frame per 1/fps, plus
 * settle time.
 */
export function simulateRig(rig: Rig, fps: number, opts: RigOptions = {}): RigFrame[] {
  const k = rig.stiffness ?? 90;
  const m = rig.mass ?? 1;
  // Overshoot off (the default) is exactly critical damping: the fastest
  // settle with no overshoot, so the tip tracks the target closely.
  const c = rig.overshoot === true ? (rig.damping ?? 12) : 2 * Math.sqrt(k * m);
  const swingOn = rig.swing !== false || rig.tilt !== false;
  const squashOn = rig.squash !== false;
  const history: History = (name, t) => {
    const target = targetAt(rig.inputPath, t);
    return name === "y" ? target.y : target.x;
  };

  const end = Math.max(...rig.inputPath.map((p) => p.time));
  const total = end + (opts.settleSec ?? 1);
  const frames = Math.max(1, Math.round(total * fps));
  const out: RigFrame[] = [];

  for (let f = 0; f <= frames; f++) {
    const t = f / fps;
    const pose = simulateFollower(history, "x", "y", t, {
      stiffness: k,
      damping: c,
      mass: m,
      swingLength: rig.swingLength ?? DEFAULT_SWING_LENGTH,
      swingDamping: rig.swingDamping ?? DEFAULT_SWING_DAMPING,
      maxSwing: swingOn ? (rig.maxSwing ?? DEFAULT_MAX_SWING) : 0,
      stretchGain: squashOn ? 0.00045 : 0,
      maxStretch: squashOn ? 0.45 : 0,
      squashKick: squashOn ? 0.0004 : 0,
    });
    out.push({
      time: t,
      x: pose.x,
      y: pose.y,
      rotation: pose.tilt,
      // Axis bake: stretch reads as wider, squash as flatter, and the
      // rotation channel carries the orientation (same as the old sim).
      scaleX: pose.scaleAlong,
      scaleY: pose.scaleAcross,
    });
  }
  return out;
}
