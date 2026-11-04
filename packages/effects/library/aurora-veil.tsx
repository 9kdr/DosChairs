/**
 * Aurora Veil (gold module): a shaders.com Aurora background — layered
 * curtains, vertical rays, flowing light — in three editor colors.
 *
 * Seeking: every seek rebuilds the preset renderer and paints [t, 0]
 * (advance, then a zero-delta repaint that settles the first-frame
 * transient), which headless-chromium frames proved byte-identical for the
 * same t in any order. See `createShadersComAdapter`.
 * Every prop plus t is mirrored into `data-*` attributes, so the render
 * pass — the one the determinism probe reads — carries the whole frame in
 * SSR markup.
 */
import React from "react";
import { createRendererFromJSON } from "shaders/core";
import type { EffectProps, PropSpec, ShadersComTarget } from "@chair/effects";
import { clamp, createShadersComAdapter, num } from "@chair/effects";

export const meta = {
  id: "aurora-veil",
  name: "Aurora Veil",
  kind: "background",
  durationSec: 8,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  colorA: { type: "color", default: "#a533f8", title: "Edge Color" },
  colorB: { type: "color", default: "#22ee88", title: "Core Color" },
  colorC: { type: "color", default: "#1694e8", title: "Ray Tip Color" },
  intensity: { type: "number", min: 0, max: 100, default: 80, title: "Brightness" },
  speed: { type: "number", min: -10, max: 10, default: 5, title: "Flow Speed" },
  waviness: { type: "number", min: 0, max: 200, default: 50, title: "Waviness" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  colorA: string;
  colorB: string;
  colorC: string;
  intensity: number;
  speed: number;
  waviness: number;
}>;

export default function AuroraVeil(p: Props): React.ReactElement {
  const { t, width, height, history } = p;
  const c = (name: string, fallback: string) => String(history(name, t) ?? fallback);
  const colorA = c("colorA", "#a533f8");
  const colorB = c("colorB", "#22ee88");
  const colorC = c("colorC", "#1694e8");
  const intensity = clamp(num(history, "intensity", t, 80), 0, 100);
  const speed = clamp(num(history, "speed", t, 5), -10, 10);
  const waviness = clamp(num(history, "waviness", t, 50), 0, 200);

  const key = [colorA, colorB, colorC, intensity.toFixed(2), speed.toFixed(2), waviness.toFixed(2)].join("|");
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const adapterRef = React.useRef<ReturnType<typeof createShadersComAdapter> | null>(null);
  // Latest sampled values for the adapter; the render pass never reads it.
  const latest = React.useRef({ colorA, colorB, colorC, intensity, speed, waviness });
  latest.current = { colorA, colorB, colorC, intensity, speed, waviness };

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
                type: "Aurora",
                id: "aurora",
                props: {
                  colorA: v.colorA,
                  colorB: v.colorB,
                  colorC: v.colorC,
                  intensity: v.intensity,
                  speed: v.speed,
                  waviness: v.waviness,
                },
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
      data-palette={[colorA, colorB, colorC].join("|")}
      data-motion={`${intensity.toFixed(2)}:${speed.toFixed(2)}:${waviness.toFixed(2)}`}
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
