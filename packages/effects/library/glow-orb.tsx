/**
 * Glow Orb (gold module): a breathing orb — a shaders.com Circle with a
 * Glow filter — floating on a transparent background.
 *
 * Seeking: the pulse phase is a pure function of t, sampled into the
 * preset on every seek; the adapter rebuilds the renderer and paints
 * [t, 0], byte-identical for the same t in any order. Every prop plus t
 * is mirrored into `data-*` attributes for the determinism probe.
 */
import React from "react";
import { createRendererFromJSON } from "shaders/core";
import type { EffectProps, PropSpec, ShadersComTarget } from "@chair/effects";
import { clamp, createShadersComAdapter, num } from "@chair/effects";

export const meta = {
  id: "glow-orb",
  name: "Glow Orb",
  kind: "overlay",
  durationSec: 6,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  color: { type: "color", default: "#ffdd44", title: "Orb Color" },
  intensity: { type: "number", min: 0, max: 50, default: 6, title: "Glow Intensity" },
  radius: { type: "number", min: 0.05, max: 0.5, default: 0.22, title: "Orb Radius" },
  size: { type: "number", min: 0, max: 100, default: 25, title: "Glow Size" },
  pulse: { type: "number", min: 0, max: 1, default: 0.5, title: "Pulse Amount" },
  rate: { type: "number", min: 0, max: 2, default: 0.5, title: "Breaths Per Second" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  color: string;
  intensity: number;
  radius: number;
  size: number;
  pulse: number;
  rate: number;
}>;

export default function GlowOrb(p: Props): React.ReactElement {
  const { t, width, height, history } = p;
  const color = String(history("color", t) ?? "#ffdd44");
  const intensity = clamp(num(history, "intensity", t, 6), 0, 50);
  const radius = clamp(num(history, "radius", t, 0.22), 0.05, 0.5);
  const size = clamp(num(history, "size", t, 25), 0, 100);
  const pulse = clamp(num(history, "pulse", t, 0.5), 0, 1);
  const rate = clamp(num(history, "rate", t, 0.5), 0, 2);

  // One breath phase drives radius and glow together; pure in t.
  const phase = Math.sin(2 * Math.PI * rate * Math.max(0, t));
  const liveRadius = radius * (1 + pulse * 0.3 * phase);
  const liveIntensity = intensity * (1 + pulse * 0.4 * phase);

  const key = [color, intensity.toFixed(2), radius.toFixed(3), size.toFixed(1), pulse.toFixed(2), rate.toFixed(2)].join("|");
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const adapterRef = React.useRef<ReturnType<typeof createShadersComAdapter> | null>(null);
  // Latest sampled values for the adapter; the render pass never reads it.
  const latest = React.useRef({ color, liveRadius, liveIntensity, size });
  latest.current = { color, liveRadius, liveIntensity, size };

  React.useLayoutEffect(() => {
    const adapter = createShadersComAdapter((): ShadersComTarget | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      return {
        canvas,
        buildPreset: () => {
          const v = latest.current;
          return {
            components: [
              {
                type: "Glow",
                id: "glow",
                props: { intensity: v.liveIntensity, size: v.size },
                children: [{ type: "Circle", id: "orb", props: { color: v.color, radius: v.liveRadius } }],
              },
            ],
          };
        },
        createRenderer: (preset) => createRendererFromJSON(preset),
      };
    });
    adapterRef.current = adapter;
    return () => {
      adapter.dispose();
      adapterRef.current = null;
    };
  }, []);

  React.useLayoutEffect(() => {
    adapterRef.current?.seek(t);
  }, [key, t]);

  return (
    <div
      style={{ position: "absolute", inset: 0 }}
      data-t={t.toFixed(3)}
      data-orb={`${color}|${liveRadius.toFixed(4)}|${liveIntensity.toFixed(3)}`}
      data-motion={`${size.toFixed(1)}:${pulse.toFixed(2)}:${rate.toFixed(2)}`}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
      />
    </div>
  );
}
