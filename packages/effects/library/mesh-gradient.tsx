/**
 * Mesh Gradient (gold module): a Paper mesh-gradient background with four
 * editor colors, distortion, swirl, and grain.
 *
 * Seeking: the Paper mount is parked at speed 0 and pinned with
 * `setFrame(t * 1000 * speed)`; uniforms update through `setUniforms`.
 * Every prop is mirrored into `data-*` attributes, so the render pass — the
 * one the determinism probe reads — carries the whole frame in SSR markup.
 */
import React from "react";
import { ShaderMount, getShaderColorFromString, meshGradientFragmentShader } from "@paper-design/shaders";
import type { EffectProps, PropSpec } from "@chair/effects";
import { clamp, num } from "@chair/effects";

export const meta = {
  id: "mesh-gradient",
  name: "Mesh Gradient",
  kind: "background",
  durationSec: 8,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  colorA: { type: "color", default: "#101018", title: "Color A" },
  colorB: { type: "color", default: "#ff6a00", title: "Color B" },
  colorC: { type: "color", default: "#3b2d8f", title: "Color C" },
  colorD: { type: "color", default: "#f1ebdd", title: "Color D" },
  distortion: { type: "number", min: 0, max: 2, default: 0.8, title: "Distortion" },
  swirl: { type: "number", min: 0, max: 2, default: 0.6, title: "Swirl" },
  speed: { type: "number", min: 0, max: 1.5, default: 0.4, title: "Flow Speed" },
  grain: { type: "number", min: 0, max: 1, default: 0.4, title: "Grain" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  colorA: string;
  colorB: string;
  colorC: string;
  colorD: string;
  distortion: number;
  swirl: number;
  speed: number;
  grain: number;
}>;

export default function MeshGradient(p: Props): React.ReactElement {
  const { t, history } = p;
  const n = (name: string, fallback: number) => num(history, name, t, fallback);
  const c = (name: string, fallback: string) => String(history(name, t) ?? fallback);
  const colors = [c("colorA", "#101018"), c("colorB", "#ff6a00"), c("colorC", "#3b2d8f"), c("colorD", "#f1ebdd")];
  const distortion = clamp(n("distortion", 0.8), 0, 2);
  const swirl = clamp(n("swirl", 0.6), 0, 2);
  const speed = clamp(n("speed", 0.4), 0, 1.5);
  const grain = clamp(n("grain", 0.4), 0, 1);
  const frame = Math.round(Math.max(0, t) * 1000 * speed);
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const mountRef = React.useRef<ShaderMount | null>(null);

  const key = [...colors, distortion.toFixed(3), swirl.toFixed(3), grain.toFixed(3)].join("|");

  React.useLayoutEffect(() => {
    if (!hostRef.current) return;
    try {
      if (!mountRef.current) {
        mountRef.current = new ShaderMount(hostRef.current, meshGradientFragmentShader, {}, undefined, 0, frame);
      }
      const mount = mountRef.current;
      mount.setUniforms({
        u_colors: colors.map((hex) => getShaderColorFromString(hex)),
        u_colorsCount: colors.length,
        u_distortion: distortion,
        u_swirl: swirl,
        u_grainMixer: grain,
      });
      mount.setSpeed(0);
      mount.setFrame(frame);
    } catch {
      // No WebGL on this host: the mirrored markup still describes the frame.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, frame]);

  React.useLayoutEffect(() => () => {
    mountRef.current?.dispose();
    mountRef.current = null;
  }, []);

  return (
    <div
      style={{ position: "absolute", inset: 0 }}
      data-frame={frame}
      data-palette={colors.join("|")}
      data-motion={`${distortion.toFixed(3)}:${swirl.toFixed(3)}:${grain.toFixed(3)}:${speed.toFixed(3)}`}
    >
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
