import { describe, expect, it } from "vitest";
import { simulateRig } from "./rig.js";
import type { Rig } from "../types.js";

const rig: Rig = {
  inputPath: [
    { time: 0, x: 240, y: 200 },
    { time: 0.5, x: 700, y: 880 },
    { time: 1, x: 1100, y: 420 },
    { time: 1.5, x: 1500, y: 880 },
  ],
  stiffness: 90,
  damping: 12,
  mass: 1,
  swing: true,
  tilt: true,
  squash: true,
  overshoot: true,
};

describe("rig sim", () => {
  it("is deterministic across runs", () => {
    const a = simulateRig(rig, 30);
    const b = simulateRig(rig, 30);
    expect(a).toEqual(b);
  });

  it("emits one frame per 1/fps plus settle time", () => {
    const frames = simulateRig(rig, 30);
    // 1.5s input + 1s settle at 30fps, inclusive endpoints.
    expect(frames.length).toBe(1 + Math.round(2.5 * 30));
    expect(frames[0]!.time).toBe(0);
  });

  it("settles near the last input after the path ends", () => {
    const frames = simulateRig(rig, 30);
    const last = frames[frames.length - 1]!;
    expect(Math.hypot(last.x - 1500, last.y - 880)).toBeLessThan(5);
    expect(Math.abs(last.rotation)).toBeLessThan(0.05);
  });

  it("produces secondary motion: swing, tilt, and a landing squash", () => {
    const frames = simulateRig(rig, 30);
    const rotations = frames.map((f) => Math.abs(f.rotation));
    expect(Math.max(...rotations)).toBeGreaterThan(0.01);
    const minScaleY = Math.min(...frames.map((f) => f.scaleY));
    expect(minScaleY).toBeLessThan(1);
  });

  it("overshoots less when overshoot is off", () => {
    const over = simulateRig(rig, 30);
    const flat = simulateRig({ ...rig, overshoot: false }, 30);
    const peak = (frames: { x: number }[]) => Math.max(...frames.map((f) => f.x));
    expect(peak(over)).toBeGreaterThanOrEqual(peak(flat));
  });
});

/** Dash right, then hold: the pendulum's swing, forward kick, and settle. */
const dash: Rig = {
  inputPath: [
    { time: 0, x: 200, y: 540 },
    { time: 0.6, x: 1600, y: 540 },
    { time: 1.6, x: 1600, y: 540 },
  ],
};

describe("pendulum swing", () => {
  it("swings opposite to acceleration: left while dashing right", () => {
    const frames = simulateRig(dash, 30);
    const early = frames.filter((f) => f.time > 0 && f.time <= 0.3);
    expect(Math.max(...early.map((f) => f.rotation))).toBeGreaterThan(0.2);
  });

  it("swings forward when the tip stops, then settles to rest", () => {
    const frames = simulateRig(dash, 30);
    const braking = frames.filter((f) => f.time >= 0.6 && f.time <= 1.2);
    expect(Math.min(...braking.map((f) => f.rotation))).toBeLessThan(-0.1);
    const last = frames[frames.length - 1]!;
    expect(Math.abs(last.rotation)).toBeLessThan(0.05);
  });

  it("lands the tip on the target", () => {
    const frames = simulateRig(dash, 30);
    const last = frames[frames.length - 1]!;
    expect(Math.hypot(last.x - 1600, last.y - 540)).toBeLessThan(5);
  });

  it("stays flat when swing and tilt are both off", () => {
    const frames = simulateRig({ ...dash, swing: false, tilt: false }, 30);
    expect(frames.every((f) => f.rotation === 0)).toBe(true);
  });

  it("clamps the swing to maxSwing", () => {
    const frames = simulateRig({ ...dash, maxSwing: 0.2 }, 30);
    expect(Math.max(...frames.map((f) => Math.abs(f.rotation)))).toBeLessThanOrEqual(0.200001);
  });

  it("tracks the target closely by default, overshoot only when asked", () => {
    const peak = (frames: { x: number }[]) => Math.max(...frames.map((f) => f.x));
    expect(peak(simulateRig(dash, 30))).toBeLessThanOrEqual(peak(simulateRig({ ...dash, overshoot: true }, 30)));
    expect(simulateRig(dash, 30)).toEqual(simulateRig({ ...dash, overshoot: false }, 30));
  });
});
