import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bakeLookFrames, encodePng, renderLookFrame, writePngSequence } from "./sequence.js";
import type { EffectSpec } from "./types.js";

function bakeSpec(): EffectSpec {
  return {
    schemaVersion: "0.1.0",
    id: "bake",
    name: "Bake",
    durationSec: 0.5,
    fps: 10,
    width: 16,
    height: 8,
    layers: [
      {
        id: "wash",
        type: "shader",
        params: { look: "gradient", colors: ["#ffffff", "#000000"], angle: 180 },
      },
    ],
  };
}

/** Minimal decoder for our own filter-0 output: signature, IHDR, one IDAT. */
function decodePng(png: Uint8Array): { width: number; height: number; data: Uint8Array } {
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: number[] = [];
  while (at < png.length) {
    const len =
      (png[at]! << 24) | (png[at + 1]! << 16) | (png[at + 2]! << 8) | png[at + 3]!;
    const kind = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    const payload = png.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") {
      width = (payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!;
      height = (payload[4]! << 24) | (payload[5]! << 16) | (payload[6]! << 8) | payload[7]!;
      expect(payload[8]).toBe(8);
      expect(payload[9]).toBe(6);
    }
    if (kind === "IDAT") idat.push(...payload);
    at += 12 + len;
  }
  const raw = inflateSync(Uint8Array.from(idat));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (1 + width * 4)]).toBe(0);
    data.set(raw.subarray(y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4)), y * width * 4);
  }
  return { width, height, data };
}

describe("png sequence bake", () => {
  it("round-trips pixels through the encoder", () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]);
    const first = encodePng(2, 2, rgba);
    expect(encodePng(2, 2, rgba)).toEqual(first);
    const back = decodePng(first);
    expect(back.width).toBe(2);
    expect(back.height).toBe(2);
    expect(back.data).toEqual(rgba);
  });

  it("bakes a horizontal gradient wash deterministically", () => {
    const a = renderLookFrame(bakeSpec(), 0);
    expect(a.width).toBe(16);
    expect(a.height).toBe(8);
    expect(renderLookFrame(bakeSpec(), 0).data).toEqual(a.data);
    const left = a.data[3 * 4];
    const right = a.data[(3 * 16 + 15) * 4];
    expect(left!).toBeLessThan(55);
    expect(right!).toBeGreaterThan(200);
  });

  it("counts frames from duration and fps, and refuses footage looks", () => {
    expect(bakeLookFrames(bakeSpec())).toHaveLength(5);
    const dither = bakeSpec();
    dither.layers = [{ id: "d", type: "shader", params: { look: "dither", levels: 4 } }];
    expect(() => bakeLookFrames(dither)).toThrow("needs footage");
  });

  it("writes zero-padded files the Loader can sequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "chair-bake-"));
    const files = writePngSequence(dir, "take", bakeLookFrames(bakeSpec()));
    expect(files).toHaveLength(5);
    expect(files[0]!.endsWith("take_00000.png")).toBe(true);
    const back = decodePng(new Uint8Array(readFileSync(files[3]!)));
    expect(back.width).toBe(16);
  });
});
