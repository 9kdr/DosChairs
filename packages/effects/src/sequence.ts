/**
 * Node-only bake: CPU raster of generator shader looks plus a dependency-free
 * PNG sequence writer. Browser bundle stays free of node: imports: import
 * this file (or the `./sequence` subpath) only from node scripts.
 *
 * What it covers: generator looks (gradient washes, fast-noise grain) that
 * need no footage. Processing looks (film-grain, dither, halftone, glow)
 * read the timeline clip, so they only exist as native Fusion nodes (see
 * adapters/resolve) and throw here. The PNGs land next to the project and
 * the generated .comp loads them with a Loader node.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { resolveFrame } from "./curves.js";
import { fbm2 } from "./kit/noise.js";
import { parseColor } from "./renderer.js";
import type { EffectSpec } from "./types.js";

export interface BakedFrame {
  width: number;
  height: number;
  /** RGBA, y-down rows, one byte per channel. */
  data: Uint8Array;
}

function chunk(kind: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = kind.charCodeAt(i);
  out.set(payload, 8);
  const check = new Uint8Array(4 + payload.length);
  check.set(out.subarray(4, 8 + payload.length));
  view.setUint32(8 + payload.length, crc32(check));
  return out;
}

/** Minimal RGBA PNG encoder (8-bit, filter 0). No native dependencies. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("encodePng needs positive integer dimensions");
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: ${rgba.length} bytes is not ${width}x${height} RGBA`);
  }
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Write frames as `<stem>_00000.png`, ... Zero-padded so Fusion sees one sequence. */
export function writePngSequence(dir: string, stem: string, frames: BakedFrame[]): string[] {
  if (frames.length === 0) throw new Error("writePngSequence needs at least one frame");
  mkdirSync(dir, { recursive: true });
  return frames.map((frame, i) => {
    const name = `${stem}_${String(i).padStart(5, "0")}.png`;
    const path = `${dir.replace(/\/$/, "")}/${name}`;
    writeFileSync(path, encodePng(frame.width, frame.height, frame.data));
    return path;
  });
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function blendPixel(
  dst: Uint8Array,
  at: number,
  r: number,
  g: number,
  b: number,
  a: number,
  mode: string | undefined,
): void {
  const dr = dst[at]! / 255;
  const dg = dst[at + 1]! / 255;
  const db = dst[at + 2]! / 255;
  const da = dst[at + 3]! / 255;
  const sa = Math.min(1, Math.max(0, a));
  let sr = r;
  let sg = g;
  let sb = b;
  if (mode === "screen") {
    sr = 1 - (1 - r) * (1 - dr);
    sg = 1 - (1 - g) * (1 - dg);
    sb = 1 - (1 - b) * (1 - db);
  } else if (mode === "multiply") {
    sr = r * dr;
    sg = g * dg;
    sb = b * db;
  } else if (mode === "add") {
    sr = Math.min(1, r + dr);
    sg = Math.min(1, g + dg);
    sb = Math.min(1, b + db);
  }
  const outA = sa + da * (1 - sa);
  const mix = (s: number, d: number): number =>
    outA <= 0 ? 0 : (s * sa + d * da * (1 - sa)) / outA;
  dst[at] = Math.round(mix(sr, dr) * 255);
  dst[at + 1] = Math.round(mix(sg, dg) * 255);
  dst[at + 2] = Math.round(mix(sb, db) * 255);
  dst[at + 3] = Math.round(outA * 255);
}

/**
 * Raster one frame of the generator looks. Mirrors the Fusion Background
 * gradient in y-down space (the web renderer's convention); a vertical
 * gradient may flip against Fusion's y-up gradient, so the demo bake stays
 * horizontal. Throws on anything that needs footage.
 */
export function renderLookFrame(
  spec: EffectSpec,
  t: number,
  controls: Record<string, unknown> = {},
): BakedFrame {
  const { width, height } = spec;
  const data = new Uint8Array(width * height * 4);
  for (const layer of resolveFrame(spec, t, controls)) {
    if (layer.visible === false) continue;
    if (layer.type !== "shader") {
      throw new Error(`layer ${layer.id}: type ${layer.type} cannot bake on CPU`);
    }
    const r = layer.resolved;
    const look = String(r["look"] ?? "");
    const opacity = num(r["opacity"], 1);
    if (look === "gradient") {
      const colors = Array.isArray(r["colors"]) ? (r["colors"] as unknown[]) : [];
      const [tr, tg, tb] = parseColor(colors[0]);
      const [br, bg, bb] = parseColor(colors[1] ?? colors[0]);
      const angle = ((num(r["angle"], 180) * Math.PI) / 180);
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const u =
            ((x - width / 2) * dx + (y - height / 2) * dy) / Math.max(width, height) + 0.5;
          const c = Math.min(1, Math.max(0, u));
          blendPixel(
            data, (y * width + x) * 4,
            lerp(tr, br, c), lerp(tg, bg, c), lerp(tb, bb, c),
            opacity, layer.blend,
          );
        }
      }
    } else if (look === "fast-noise") {
      const detail = Math.min(5, Math.max(1, Math.round(num(r["detail"], 5))));
      const contrast = num(r["contrast"], 1);
      const brightness = num(r["brightness"], 0.5);
      const scale = num(r["scale"], 3) * 0.02;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = (fbm2(x * scale, y * scale, detail) - 0.5) * contrast + brightness;
          const c = Math.min(1, Math.max(0, v));
          blendPixel(data, (y * width + x) * 4, c, c, c, opacity, layer.blend);
        }
      }
    } else {
      throw new Error(
        `layer ${layer.id}: look ${look || "(untagged)"} needs footage and cannot bake on CPU`,
      );
    }
  }
  return { width, height, data };
}

/** Every frame of the spec at its own fps. Generator looks only (see above). */
export function bakeLookFrames(spec: EffectSpec): BakedFrame[] {
  const total = Math.max(1, Math.round(spec.durationSec * spec.fps));
  const frames: BakedFrame[] = [];
  for (let f = 0; f < total; f++) frames.push(renderLookFrame(spec, f / spec.fps));
  return frames;
}
