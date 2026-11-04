import { describe, expect, it } from "vitest";
import {
  CHAIR_BLACK,
  chairBox,
  chairHas,
  createScene,
  hitTest,
  poke,
  render,
  step,
} from "./scene";

const SIZES: Array<[number, number]> = [
  [40, 30],
  [64, 48],
  [120, 60],
  [175, 75],
  [300, 100],
  [520, 110],
];

function paint(w: number, h: number, seconds = 0, reserve = 0) {
  const scene = createScene(w, h, 0, reserve);
  for (let t = 0; t < seconds; t += 0.05) step(scene, 0.05);
  const buf = new Uint32Array(w * h);
  render(scene, buf);
  return { scene, buf };
}

describe("sleepy chair scene", () => {
  it("renders at every size without leaving the grid", () => {
    for (const [w, h] of SIZES) {
      const { scene, buf } = paint(w, h, 6);
      expect(buf.length).toBe(w * h);
      // Every pixel is opaque: no hole in the sky.
      expect(buf.every((p) => p >>> 24 === 255)).toBe(true);
      expect(scene.chair.x).toBeGreaterThanOrEqual(0);
      expect(scene.moon.x + scene.moon.r).toBeLessThan(w + 1);
    }
  });

  it("paints the chair completely black, with nothing over it", () => {
    for (const [w, h] of SIZES) {
      // Snoring and shooting stars running, chair at rest.
      const { scene, buf } = paint(w, h, 9);
      const box = chairBox(scene);
      let black = 0;
      for (let ry = 0; ry < box.h; ry += 1) {
        for (let rx = 0; rx < box.w; rx += 1) {
          if (!chairHas(rx, ry)) continue;
          const y = box.y + ry;
          const x = box.x + rx;
          if (y < 0 || y >= h || x < 0 || x >= w) continue;
          expect(buf[y * w + x]).toBe(CHAIR_BLACK);
          black += 1;
        }
      }
      expect(black).toBeGreaterThan(80);
    }
  });

  it("keeps the chair above the label strip", () => {
    // The banner is at least 144px tall, which is 60+ rows at the largest pixel size.
    for (const [w, h] of SIZES.filter(([, rows]) => rows >= 60)) {
      const { scene } = paint(w, h, 0, 10);
      expect(scene.chair.bottom).toBeLessThanOrEqual(h - 10);
      expect(chairBox(scene).y).toBeGreaterThanOrEqual(0);
    }
  });

  it("is the same sky for the same size", () => {
    const a = paint(175, 75, 2);
    const b = paint(175, 75, 2);
    expect(Array.from(a.buf)).toEqual(Array.from(b.buf));
  });

  it("snores: Zs appear, rise, and leave", () => {
    const scene = createScene(175, 75);
    step(scene, 1);
    expect(scene.zzz.length).toBeGreaterThan(0);
    const first = scene.zzz[0];
    for (let t = 0; t < 5; t += 0.1) step(scene, 0.1);
    expect(scene.zzz.includes(first!)).toBe(false);
    expect(scene.zzz.length).toBeLessThanOrEqual(8);
  });

  it("moves with the clock", () => {
    const early = paint(175, 75, 1);
    const later = paint(175, 75, 3);
    expect(Array.from(early.buf)).not.toEqual(Array.from(later.buf));
  });

  it("reacts to clicks: chair startles, moon launches stars, sky launches one", () => {
    const scene = createScene(175, 75);
    const box = chairBox(scene);
    expect(hitTest(scene, box.x + 5, box.y + 12)).toBe("chair");
    expect(poke(scene, box.x + 5, box.y + 12)).toBe("chair");
    expect(scene.startledAt).toBe(0);
    expect(scene.zzz.length).toBe(3);
    // The chair hops while startled and settles after.
    expect(chairBox(scene).y).toBeLessThan(box.y);
    for (let t = 0; t < 1; t += 0.1) step(scene, 0.1);
    expect(scene.startledAt).toBeNull();

    expect(poke(scene, scene.moon.x, scene.moon.y)).toBe("moon");
    expect(scene.moonPulseAt).toBe(0);
    const before = scene.shooters.length;
    expect(poke(scene, 10, 5)).toBe("sky");
    expect(scene.shooters.length).toBe(before + 1);
  });

  it("brightens stars near the pointer", () => {
    const calm = paint(175, 75, 2);
    const near = createScene(175, 75);
    for (let t = 0; t < 2; t += 0.05) step(near, 0.05);
    near.pointer = { x: 40, y: 20 };
    const buf = new Uint32Array(175 * 75);
    render(near, buf);
    expect(Array.from(buf)).not.toEqual(Array.from(calm.buf));
  });
});
