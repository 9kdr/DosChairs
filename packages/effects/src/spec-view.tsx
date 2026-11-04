/**
 * EffectSpecView: a React component that renders an effect spec as a pure
 * function of (props, t). Control values arrive as props (one per published
 * control id); the spec itself arrives as the wrapper's `data` payload.
 *
 * Paint happens in the ref callback, which React runs synchronously inside
 * the wrapper's flushSync render — so goToTime(ms) paints that exact frame
 * before it returns. Async work (image/font loading) only fills caches and
 * never affects the math for a given (props, t).
 */
import React from "react";
import { resolveFrame } from "./curves.js";
import { simulateRig } from "./rig.js";
import { drawResolvedLayers, drawShaderFallback } from "./canvas2d.js";
import type { DrawImage } from "./canvas2d.js";
import type { EffectSpec, RigFrame } from "./types.js";

const RESERVED = new Set(["data", "spec", "t", "frame", "children"]);

export interface EffectSpecViewProps {
  /** Wrapper payload: `{ spec }` plus anything the author attached. */
  data?: { spec?: EffectSpec } & Record<string, unknown>;
  /** Direct spec (authoring-time convenience; `data.spec` wins in Resolve). */
  spec?: EffectSpec;
  /** Seconds. Set by the wrapper's goToTime. */
  t?: number;
  /** Frame number at the spec fps. Informational; paint uses `t`. */
  frame?: number;
  [controlId: string]: unknown;
}

export interface SpecPayload {
  spec: EffectSpec;
  t: number;
  controls: Record<string, string | number | boolean>;
}

/** Split wrapper props into the spec, the time, and the control overrides. */
export function specPayloadFromProps(props: EffectSpecViewProps): SpecPayload | null {
  const spec = props.data?.spec ?? props.spec;
  if (!spec) return null;
  const t = typeof props.t === "number" && Number.isFinite(props.t) ? props.t : 0;
  const controls: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (RESERVED.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      controls[key] = value;
    }
  }
  return { spec, t, controls };
}

/**
 * Rig rule shared with the exporter: the baked spring drives the topmost
 * layer with static x/y (no x/y curves). Null when every layer animates x/y
 * or the spec has no rig.
 */
export function specRigTarget(spec: EffectSpec): string | null {
  if (!spec.rig) return null;
  for (let i = spec.layers.length - 1; i >= 0; i--) {
    const layer = spec.layers[i]!;
    if (layer.curves?.["x"] || layer.curves?.["y"]) continue;
    return layer.id;
  }
  return null;
}

const imageCache = new Map<string, DrawImage>();
const fontCache = new Set<string>();

function primeCaches(spec: EffectSpec): void {
  if (typeof document === "undefined") return;
  for (const layer of spec.layers) {
    if (layer.type === "image") {
      const src = String(layer.params?.["src"] ?? "");
      if (src && !imageCache.has(src) && typeof Image !== "undefined") {
        const img = new Image();
        img.onload = () => {
          imageCache.set(src, img as unknown as DrawImage);
        };
        img.onerror = () => {
          imageCache.delete(src);
        };
        img.src = src;
        // Mark pending so a second view does not double-load.
        imageCache.set(src, { width: 0, height: 0 } as unknown as DrawImage);
      }
    } else if (layer.type === "text") {
      const key = `${String(layer.params?.["size"] ?? 48)}px ${String(layer.params?.["font"] ?? "sans-serif")}`;
      if (!fontCache.has(key) && document.fonts?.load) {
        fontCache.add(key);
        document.fonts.load(`"${String(layer.params?.["font"] ?? "sans-serif")}"`).catch(() => undefined);
      }
    }
  }
}

function paint(canvas: HTMLCanvasElement, payload: SpecPayload, rigTable: RigFrame[] | null): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { spec, t, controls } = payload;
  const layers = resolveFrame(spec, t, controls);
  const { shaderLayers } = drawResolvedLayers(ctx, spec.width, spec.height, layers, {
    width: spec.width,
    height: spec.height,
    images: imageCache,
    rigTable,
    rigTarget: specRigTarget(spec),
    t,
  });
  if (shaderLayers > 0) {
    // This view is Canvas2D-only: shader layers are reported, not guessed.
    drawShaderFallback(ctx, spec.width, spec.height, shaderLayers);
  }
}

export function EffectSpecView(props: EffectSpecViewProps): React.ReactElement | null {
  const payload = specPayloadFromProps(props);
  const rigTable = React.useMemo<RigFrame[] | null>(() => {
    if (!payload || !payload.spec.rig) return null;
    try {
      return simulateRig(payload.spec.rig, payload.spec.fps);
    } catch {
      return null;
    }
  }, [payload?.spec]);
  const paintRef = React.useCallback(
    (node: HTMLCanvasElement | null) => {
      if (node && payload) {
        primeCaches(payload.spec);
        paint(node, payload, rigTable);
      }
    },
    [payload, rigTable],
  );
  if (!payload) return null;
  return React.createElement("canvas", {
    ref: paintRef,
    width: payload.spec.width,
    height: payload.spec.height,
    style: { width: "100%", height: "100%", display: "block" },
  });
}

export default EffectSpecView;
