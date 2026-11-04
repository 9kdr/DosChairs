/**
 * Effect presets: four house looks every module can compose. Each is a pure
 * function of its props and `t` (no animation hooks, no DOM reads), so
 * server rendering and the client paint the same frame.
 */
import React from "react";
import { clamp } from "./easing.js";
import { hexToRgba } from "./color.js";
import { GLSL_NOISE } from "./noise.js";
import { ShaderPass } from "./shader.js";

const WASH_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_scale;
uniform float u_flow;
uniform vec3 u_ink;
uniform vec3 u_accent;
uniform vec3 u_paper;
${GLSL_NOISE}
void main() {
  vec2 px = vUv * u_resolution;
  vec2 p = (vUv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0) * u_scale;
  float w = fbm(p + vec2(u_time * 0.22, -u_time * 0.16));
  float v = fbm(p * 1.7 + vec2(w * u_flow, -w * u_flow) + u_time * 0.1);
  vec3 col = mix(u_ink, u_accent, smoothstep(0.32, 0.62, v));
  col = mix(col, u_paper, smoothstep(0.62, 0.86, v));
  oColor = vec4(col, 1.0);
}
`;

export interface GradientWashProps {
  t: number;
  width: number;
  height: number;
  ink?: string;
  accent?: string;
  paper?: string;
  flow?: number;
  scale?: number;
  speed?: number;
}

/** Slow domain-warped gradient wash in three inks. `speed` scales the clock. */
export function GradientWash({
  t, width, height,
  ink = "#101018", accent = "#ff6a00", paper = "#f1ebdd",
  flow = 1.6, scale = 2.2, speed = 0.5,
}: GradientWashProps): React.ReactElement {
  return (
    <ShaderPass
      frag={WASH_FRAG}
      width={width}
      height={height}
      uniforms={{
        u_time: Math.max(0, t) * speed,
        u_resolution: [width, height],
        u_scale: scale,
        u_flow: flow,
        u_ink: ink,
        u_accent: accent,
        u_paper: paper,
      }}
    />
  );
}

export interface GrainOverlayProps {
  t: number;
  fps?: number;
  amount?: number;
}

/**
 * Animated film grain: an SVG turbulence field whose seed steps with the
 * frame number, so grain is deterministic per frame and needs no clock.
 */
export function GrainOverlay({ t, fps = 30, amount = 0.45 }: GrainOverlayProps): React.ReactElement {
  const id = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const seed = Math.floor(Math.max(0, t) * Math.max(1, fps));
  return (
    <svg
      data-grain-seed={seed}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    >
      <filter id={id}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#${id})`} opacity={clamp(amount, 0, 1)} />
    </svg>
  );
}

export interface HalftoneLayerProps {
  /** Ink coverage 0..1; the dot radius grows with the square root of tone. */
  tone: number;
  cell?: number;
  ink?: string;
}

/**
 * Round-dot halftone screen as pure CSS. For rotated screens use the GLSL
 * `halftone()` helper in a ShaderPass instead.
 */
export function HalftoneLayer({ tone, cell = 14, ink = "#111111" }: HalftoneLayerProps): React.ReactElement {
  const radius = Math.sqrt(clamp(tone, 0, 1)) * 50;
  const px = Math.max(4, cell);
  return (
    <div
      data-tone={clamp(tone, 0, 1).toFixed(3)}
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: `radial-gradient(circle at center, ${ink} ${radius.toFixed(2)}%, transparent ${(radius + 0.5).toFixed(2)}%)`,
        backgroundSize: `${px}px ${px}px`,
      }}
    />
  );
}

export interface GlowWrapProps {
  color?: string;
  radius?: number;
  strength?: number;
  children?: React.ReactNode;
}

/** Soft outer glow around any children. */
export function GlowWrap({ color = "#ff6a00", radius = 24, strength = 0.8, children }: GlowWrapProps): React.ReactElement {
  return (
    <div
      data-glow={`${radius.toFixed(1)}:${clamp(strength, 0, 1).toFixed(2)}`}
      style={{ position: "absolute", inset: 0, filter: `drop-shadow(0 0 ${Math.max(0, radius)}px ${hexToRgba(color, clamp(strength, 0, 1))})` }}
    >
      {children}
    </div>
  );
}
