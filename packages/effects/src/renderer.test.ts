import { describe, expect, it } from "vitest";
import { hotspotOf, quadCorners } from "./renderer.js";

describe("quadCorners hotspot", () => {
  it("lands the hotspot on x,y under any rotation", () => {
    for (const rot of [0, 0.5, -1.2, Math.PI]) {
      const { px } = quadCorners(300, 200, 100, 100, rot, 0.14, 0.08);
      // Corner 0 is uv (0,0); de-rotated it must sit exactly -hotspot away.
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const dx = px[0]! - 300;
      const dy = px[1]! - 200;
      expect(dx * c + dy * s).toBeCloseTo(-14, 6);
      expect(-dx * s + dy * c).toBeCloseTo(-8, 6);
    }
  });

  it("defaults to the centre", () => {
    expect(quadCorners(10, 20, 40, 60, 0.3)).toEqual(quadCorners(10, 20, 40, 60, 0.3, 0.5, 0.5));
  });
});

describe("hotspotOf", () => {
  it("reads hotspotX/hotspotY", () => {
    expect(hotspotOf({ hotspotX: 0.14, hotspotY: 0.08 })).toEqual({ hx: 0.14, hy: 0.08 });
  });

  it("falls back to the centre when missing or out of range", () => {
    expect(hotspotOf({})).toEqual({ hx: 0.5, hy: 0.5 });
    expect(hotspotOf({ hotspotX: 2, hotspotY: -1 })).toEqual({ hx: 0.5, hy: 0.5 });
  });
});
