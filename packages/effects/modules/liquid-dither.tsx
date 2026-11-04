/**
 * Liquid dither (reference module): a domain-warped liquid field quantized to
 * three inks with an 8x8 Bayer ordered dither, in one WebGL2 pass.
 *
 * Every frame is the shader's output for (uniforms, u_time = t * speed). No
 * state survives between frames, so Resolve can scrub anywhere. Keyframe
 * Lens X / Lens Y to drag the liquid around, or Warp to make it boil.
 */
import React from "react";
import { GLSL_BAYER, GLSL_NOISE, ShaderPass, num } from "@chair/effects";
import type { EffectProps, PropSpec } from "@chair/effects";

export const meta = {
  id: "liquid-dither",
  name: "Liquid Dither",
  kind: "generator",
  durationSec: 8,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  speed: { type: "number", min: 0, max: 3, default: 0.6, title: "Flow Speed" },
  scale: { type: "number", min: 0.5, max: 8, default: 2.4, title: "Scale" },
  warp: { type: "number", min: 0, max: 2, default: 1, title: "Warp" },
  cell: { type: "number", min: 1, max: 12, default: 3, title: "Dither Cell (px)" },
  contrast: { type: "number", min: 0.3, max: 2.5, default: 1.2, title: "Contrast" },
  lensX: { type: "number", min: 0, max: 1, default: 0.5, title: "Lens X" },
  lensY: { type: "number", min: 0, max: 1, default: 0.5, title: "Lens Y" },
  lensPull: { type: "number", min: 0, max: 1, default: 0.35, title: "Lens Pull" },
  ink: { type: "color", default: "#0b0b12", title: "Ink" },
  accent: { type: "color", default: "#ff6a00", title: "Accent" },
  paper: { type: "color", default: "#f1ebdd", title: "Paper" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  speed: number;
  scale: number;
  warp: number;
  cell: number;
  contrast: number;
  lensX: number;
  lensY: number;
  lensPull: number;
  ink: string;
  accent: string;
  paper: string;
}>;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_scale;
uniform float u_warp;
uniform float u_cell;
uniform float u_contrast;
uniform vec2 u_lens;
uniform float u_pull;
uniform vec3 u_ink;
uniform vec3 u_accent;
uniform vec3 u_paper;
${GLSL_NOISE}
${GLSL_BAYER}
void main() {
  vec2 px = vUv * u_resolution;
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0) * u_scale;
  vec2 lens = (u_lens - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0) * u_scale;
  vec2 toLens = p - lens;
  float lensFall = exp(-dot(toLens, toLens) * 1.6);
  p -= toLens * lensFall * u_pull * 1.6;
  vec2 q = vec2(fbm(p + vec2(0.0, u_time * 0.35)), fbm(p + vec2(5.2, 1.3) - u_time * 0.28));
  vec2 r = vec2(fbm(p + u_warp * 2.2 * q + vec2(1.7, 9.2) + u_time * 0.18),
                fbm(p + u_warp * 2.2 * q + vec2(8.3, 2.8) - u_time * 0.14));
  float f = fbm(p + u_warp * 2.6 * r);
  float tone = clamp((f - 0.5) * u_contrast + 0.5 + lensFall * u_pull * 0.4, 0.0, 1.0);
  float thr = bayer8(floor(px / max(u_cell, 1.0)));
  float t2 = tone * 2.0;
  vec3 low = t2 < 1.0 ? mix(u_ink, u_accent, step(thr, t2)) : mix(u_accent, u_paper, step(thr, t2 - 1.0));
  oColor = vec4(low, 1.0);
}`;

export default function LiquidDither(p: Props): React.ReactElement {
  const { t, history, width, height } = p;
  const n = (name: string, fallback: number) => num(history, name, t, fallback);
  const c = (name: string, fallback: string) => String(history(name, t) ?? fallback);
  return (
    <ShaderPass
      frag={FRAG}
      width={width}
      height={height}
      uniforms={{
        u_time: t * n("speed", 0.6),
        u_resolution: [width, height],
        u_scale: n("scale", 2.4),
        u_warp: n("warp", 1),
        u_cell: n("cell", 3),
        u_contrast: n("contrast", 1.2),
        u_lens: [n("lensX", 0.5), n("lensY", 0.5)],
        u_pull: n("lensPull", 0.35),
        u_ink: c("ink", "#0b0b12"),
        u_accent: c("accent", "#ff6a00"),
        u_paper: c("paper", "#f1ebdd"),
      }}
    />
  );
}
