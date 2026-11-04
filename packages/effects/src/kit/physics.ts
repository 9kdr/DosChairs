/**
 * Deterministic fixed-step physics for effect modules.
 *
 * Springs, swing, tilt, and overshoot need the *past* of a keyframed input, so
 * every helper here re-simulates from time 0 to t with a fixed step instead of
 * keeping state between frames. Resolve scrubs in any order; a function of
 * (history, t) gives the same frame whatever was drawn before it.
 */
import { clamp } from "./easing.js";
import type { History } from "./types.js";
import { num } from "./types.js";

/** Simulation step in seconds (240 Hz). Fixed: never derived from frame timing. */
export const PHYSICS_DT = 1 / 240;
/** Longest span simulated per call; later time holds the final state's inputs. */
export const MAX_SIM_SEC = 120;

export interface SpringOptions {
  stiffness?: number;
  damping?: number;
  mass?: number;
}

export interface SpringState {
  x: number;
  v: number;
}

/** One semi-implicit Euler step of a damped spring toward `target`. */
export function springStep(
  s: SpringState,
  target: number,
  dt: number,
  { stiffness = 120, damping = 14, mass = 1 }: SpringOptions = {},
): void {
  const a = (stiffness * (target - s.x) - damping * s.v) / mass;
  s.v += a * dt;
  s.x += s.v * dt;
}

/** Run `step(τ, dt)` over [0, t] in fixed steps; the last step is the fractional remainder. */
function runFixed(t: number, step: (tau: number, dt: number) => void): void {
  const end = clamp(t, 0, MAX_SIM_SEC);
  const n = Math.floor(end / PHYSICS_DT + 1e-9);
  for (let i = 0; i < n; i++) step(i * PHYSICS_DT, PHYSICS_DT);
  const rest = end - n * PHYSICS_DT;
  if (rest > 1e-9) step(n * PHYSICS_DT, rest);
}

/** A spring chasing `target(τ)`, simulated from rest at target(0) up to time t. */
export function simulateSpring(
  target: (tau: number) => number,
  t: number,
  opts: SpringOptions = {},
): SpringState {
  const s: SpringState = { x: target(0), v: 0 };
  runFixed(t, (tau, dt) => springStep(s, target(tau + dt), dt, opts));
  return s;
}

/** A spring following a keyframed numeric prop. */
export function followProp(
  history: History,
  name: string,
  t: number,
  opts: SpringOptions = {},
): SpringState {
  return simulateSpring((tau) => num(history, name, tau), t, opts);
}

export interface FollowerOptions extends SpringOptions {
  /** Radians of tilt per px/s of horizontal velocity. */
  tiltGain?: number;
  maxTilt?: number;
  /** Stretch along motion per px/s of speed. */
  stretchGain?: number;
  maxStretch?: number;
  /** Squash impulse strength when the follower brakes hard. */
  squashKick?: number;
}

export interface FollowerPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radians, positive clockwise. Springy: swings past and settles. */
  tilt: number;
  /** Scale along the motion direction (>1 stretched, <1 squashed). */
  scaleAlong: number;
  /** Scale across the motion direction (volume-preserving partner of scaleAlong). */
  scaleAcross: number;
  /** Direction of travel in radians (0 = +x). Holds its last value while still. */
  heading: number;
}

/**
 * The expressive-mouse rig: a follower chasing the (x, y) target props on a
 * spring (overshoot), tilting into its velocity on a second spring (swing),
 * and squashing when it brakes. Everything integrates at PHYSICS_DT from 0..t.
 */
export function simulateFollower(
  history: History,
  xName: string,
  yName: string,
  t: number,
  opts: FollowerOptions = {},
): FollowerPose {
  const { tiltGain = 0.0011, maxTilt = 0.7, stretchGain = 0.00045, maxStretch = 0.45, squashKick = 0.0004 } = opts;
  const sx: SpringState = { x: num(history, xName, 0), v: 0 };
  const sy: SpringState = { x: num(history, yName, 0), v: 0 };
  const tilt: SpringState = { x: 0, v: 0 };
  const squash: SpringState = { x: 0, v: 0 };
  let prevSpeed = 0;
  let heading = 0;
  runFixed(t, (tau, dt) => {
    springStep(sx, num(history, xName, tau + dt), dt, opts);
    springStep(sy, num(history, yName, tau + dt), dt, opts);
    springStep(tilt, clamp(sx.v * tiltGain, -maxTilt, maxTilt), dt, { stiffness: 140, damping: 9 });
    const speed = Math.hypot(sx.v, sy.v);
    if (speed > 30) heading = Math.atan2(sy.v, sx.v);
    // Braking kicks the squash spring; it then rings and settles.
    const braking = prevSpeed - speed;
    if (braking > 0 && prevSpeed > 120) squash.v -= braking * squashKick * 60;
    springStep(squash, clamp(speed * stretchGain, 0, maxStretch), dt, { stiffness: 220, damping: 16 });
    prevSpeed = speed;
  });
  const s = clamp(squash.x, -0.5, maxStretch);
  return {
    x: sx.x,
    y: sy.x,
    vx: sx.v,
    vy: sy.v,
    tilt: tilt.x,
    scaleAlong: 1 + s,
    scaleAcross: 1 / (1 + s),
    heading,
  };
}

export interface ChainOptions {
  segment?: number;
  gravity?: number;
  damping?: number;
  iterations?: number;
}

/**
 * A verlet rope hanging from `anchor(τ)`: returns `count` points at time t.
 * Text-physics ready: hang one letter per point.
 */
export function verletChain(
  anchor: (tau: number) => { x: number; y: number },
  count: number,
  t: number,
  { segment = 40, gravity = 1800, damping = 0.995, iterations = 8 }: ChainOptions = {},
): { x: number; y: number }[] {
  const a0 = anchor(0);
  const pts = Array.from({ length: Math.max(2, count) }, (_, i) => ({
    x: a0.x,
    y: a0.y + i * segment,
    px: a0.x,
    py: a0.y + i * segment,
  }));
  runFixed(t, (tau, dt) => {
    for (const p of pts) {
      const vx = (p.x - p.px) * damping;
      const vy = (p.y - p.py) * damping;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + gravity * dt * dt;
    }
    const a = anchor(tau + dt);
    for (let it = 0; it < iterations; it++) {
      pts[0]!.x = a.x;
      pts[0]!.y = a.y;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i]!;
        const q = pts[i + 1]!;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const d = Math.hypot(dx, dy) || 1e-9;
        const diff = ((d - segment) / d) * 0.5;
        if (i === 0) {
          q.x -= dx * diff * 2;
          q.y -= dy * diff * 2;
        } else {
          p.x += dx * diff;
          p.y += dy * diff;
          q.x -= dx * diff;
          q.y -= dy * diff;
        }
      }
    }
  });
  return pts.map((p) => ({ x: p.x, y: p.y }));
}
