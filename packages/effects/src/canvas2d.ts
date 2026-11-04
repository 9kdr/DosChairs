/**
 * Framework-free Canvas2D painting of resolved effect layers. Used by the
 * React spec view (packages/effects) and unit-testable with a stub context:
 * every call is a synchronous function of the inputs, so the same
 * (layers, t) always records the same ops.
 */
import { hotspotOf, parseColor } from "./renderer.js";
import type { ResolvedLayer } from "./curves.js";
import type { RigFrame } from "./types.js";

export type DrawImage = CanvasImageSource & {
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
};

export interface DrawOptions {
  width: number;
  height: number;
  images?: Map<string, DrawImage>;
  /** Baked rig table plus the layer it drives (see spec-view). */
  rigTable?: RigFrame[] | null;
  rigTarget?: string | null;
  t: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function compositeFor(blend: string | undefined): GlobalCompositeOperation {
  if (blend === "add") return "lighter";
  if (blend === "multiply") return "multiply";
  if (blend === "screen") return "screen";
  return "source-over";
}

/** Nearest baked rig frame at or before t. Pure lookup. */
export function sampleRigTable(table: RigFrame[] | null | undefined, t: number): RigFrame | null {
  if (!table || table.length === 0) return null;
  let best = table[0]!;
  for (const frame of table) {
    if (frame.time <= t + 1e-9) best = frame;
    else break;
  }
  return best;
}

function drawShape(ctx: CanvasRenderingContext2D, r: Record<string, string | number | boolean>): void {
  const w = num(r["scaleX"], 100);
  const h = num(r["scaleY"], 100);
  const [cr, cg, cb] = parseColor(r["fill"]);
  ctx.save();
  ctx.globalAlpha = num(r["opacity"], 1);
  ctx.fillStyle = `rgb(${Math.round(cr * 255)},${Math.round(cg * 255)},${Math.round(cb * 255)})`;
  if (r["kind"] === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, r: Record<string, string | number | boolean>): void {
  const str = String(r["string"] ?? "");
  if (!str) return;
  const size = num(r["size"], 48);
  ctx.save();
  ctx.globalAlpha = num(r["opacity"], 1);
  ctx.font = `${size}px ${String(r["font"] ?? "sans-serif")}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = String(r["fill"] ?? "#ffffff");
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

function drawImage(
  ctx: CanvasRenderingContext2D,
  r: Record<string, string | number | boolean>,
  img: DrawImage | undefined,
): void {
  if (!img) return;
  const iw = num(img.naturalWidth ?? img.width, 0);
  const ih = num(img.naturalHeight ?? img.height, 0);
  if (!iw || !ih) return;
  const spot = hotspotOf(r);
  const w = num(r["scaleX"], iw);
  const h = num(r["scaleY"], ih);
  ctx.save();
  ctx.globalAlpha = num(r["opacity"], 1);
  ctx.drawImage(img, -spot.hx * w, -spot.hy * h, w, h);
  ctx.restore();
}

/**
 * Labelled placeholder for shader layers when WebGL2 is unavailable. The box
 * says what happened on the canvas itself, so the gap is visible in Resolve.
 */
export function drawShaderFallback(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  count: number,
): void {
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#1a1d24";
  ctx.fillRect(40, height - 132, width - 80, 92);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#f5c542";
  ctx.font = "28px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`WebGL2 unavailable: ${count} shader layer(s) skipped`, width / 2, height - 86);
  ctx.restore();
}

export interface DrawResult {
  shaderLayers: number;
}

/**
 * Paint one frame. Positions every layer at (x, y) with rotation, applies the
 * rig sample to the rig target, and counts shader layers for the caller to
 * route to WebGL or the fallback box. Returns the shader layer count.
 */
export function drawResolvedLayers(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  layers: ResolvedLayer[],
  opts: DrawOptions,
): DrawResult {
  ctx.clearRect(0, 0, width, height);
  const rigSample = opts.rigTarget ? sampleRigTable(opts.rigTable, opts.t) : null;
  let shaderLayers = 0;
  for (const layer of layers) {
    if (layer.visible === false) continue;
    const r = { ...layer.resolved };
    if (rigSample && layer.id === opts.rigTarget) {
      r["x"] = rigSample.x;
      r["y"] = rigSample.y;
      r["rotation"] = num(r["rotation"], 0) + rigSample.rotation;
      r["scaleX"] = num(r["scaleX"], 1) * rigSample.scaleX;
      r["scaleY"] = num(r["scaleY"], 1) * rigSample.scaleY;
    }
    try {
      if (layer.type === "shape") {
        ctx.save();
        ctx.globalCompositeOperation = compositeFor(layer.blend);
        ctx.translate(num(r["x"], width / 2), num(r["y"], height / 2));
        ctx.rotate(num(r["rotation"], 0));
        drawShape(ctx, r);
        ctx.restore();
      } else if (layer.type === "text") {
        ctx.save();
        ctx.globalCompositeOperation = compositeFor(layer.blend);
        ctx.translate(num(r["x"], width / 2), num(r["y"], height / 2));
        ctx.rotate(num(r["rotation"], 0));
        drawText(ctx, r);
        ctx.restore();
      } else if (layer.type === "image") {
        ctx.save();
        ctx.globalCompositeOperation = compositeFor(layer.blend);
        ctx.translate(num(r["x"], width / 2), num(r["y"], height / 2));
        ctx.rotate(num(r["rotation"], 0));
        drawImage(ctx, r, opts.images?.get(String(r["src"] ?? "")));
        ctx.restore();
      } else if (layer.type === "shader") {
        shaderLayers++;
      }
    } catch {
      continue;
    }
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  return { shaderLayers };
}
