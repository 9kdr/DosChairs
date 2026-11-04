import { describe, expect, it } from "vitest";
import { evaluateCurve, resolveFrame } from "./curves.js";
import type { Curve, EffectSpec } from "./types.js";

const curve: Curve = {
  keyframes: [
    { time: 0, value: 0, easing: "linear" },
    { time: 1, value: 10, easing: "hold" },
    { time: 2, value: 20 },
  ],
};

describe("curves", () => {
  it("interpolates linear segments", () => {
    expect(evaluateCurve(curve, 0.5)).toBeCloseTo(5, 9);
  });

  it("holds the previous value on hold easing", () => {
    expect(evaluateCurve(curve, 1.5)).toBeCloseTo(10, 9);
  });

  it("clamps outside the key range", () => {
    expect(evaluateCurve(curve, -1)).toBe(0);
    expect(evaluateCurve(curve, 99)).toBe(20);
  });

  it("applies easeIn easing", () => {
    const eased: Curve = { keyframes: [{ time: 0, value: 0, easing: "easeIn" }, { time: 1, value: 4 }] };
    expect(evaluateCurve(eased, 0.5)).toBeCloseTo(1, 9);
  });

  it("lets curves beat static params and controls beat curves", () => {
    const spec: EffectSpec = {
      schemaVersion: "0.1.0",
      id: "s",
      name: "s",
      durationSec: 2,
      fps: 30,
      width: 1920,
      height: 1080,
      layers: [
        {
          id: "ball",
          type: "shape",
          params: { fill: "#ffb000", x: 0 },
          curves: { x: { keyframes: [{ time: 0, value: 0 }, { time: 2, value: 100 }] } },
        },
      ],
      controls: [{ id: "c", label: "C", type: "color", default: "#ffb000", target: { layerId: "ball", param: "fill" } }],
    };
    expect(resolveFrame(spec, 1)[0]!.resolved["x"]).toBeCloseTo(50, 9);
    expect(resolveFrame(spec, 1, { c: "#ff0000" })[0]!.resolved["fill"]).toBe("#ff0000");
  });
});
