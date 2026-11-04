/**
 * Bake a spec Rig to per-frame keys through the kit spring sim. Same input,
 * same frames: the follower re-simulates from 0..t at a fixed step, so this
 * is the piece sim (simulateFollower) sampled on a frame grid, not a second
 * physics model. The desktop bake and the spec preview share it.
 */
import type { History } from "./types.js";
import { simulateFollower } from "./physics.js";
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
 * Run the expressive-mouse rig: the follower chases the rough input path on a
 * spring (momentum + overshoot), with swing/tilt into velocity and
 * squash-and-stretch. Returns one frame per 1/fps, plus settle time.
 */
export function simulateRig(rig: Rig, fps: number, opts: RigOptions = {}): RigFrame[] {
  const k = rig.stiffness ?? 90;
  const m = rig.mass ?? 1;
  // Overshoot off is exactly critical damping: the fastest settle with no
  // overshoot, whatever the damping slider says.
  const c = rig.overshoot === false ? 2 * Math.sqrt(k * m) : (rig.damping ?? 12);
  const tiltOn = rig.swing !== false || rig.tilt !== false;
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
      tiltGain: tiltOn ? 0.0011 : 0,
      maxTilt: tiltOn ? 0.7 : 0,
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
