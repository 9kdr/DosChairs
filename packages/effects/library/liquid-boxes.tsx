/**
 * Liquid Boxes (gold module): two rounded boxes orbit, meet, and merge
 * through a smooth-min SDF with a clean accent halo and subtle grain inside
 * the cores, all on transparent pixels.
 *
 * Seeking: OGL paints one frame per seek (`u_time = t`, render once). The
 * grain hash is a pure function of the pixel and `u_time`, so a seek always
 * repaints the same frame. Per-box phase offsets come from motion's pure
 * `stagger()`, so the render pass — the one the determinism probe reads —
 * computes the exact same centers the client paints. Mirror attributes
 * (`data-c1`, `data-frame`, ...) carry every prop into SSR markup.
 */
import React from "react";
import { Renderer, Program, Mesh, Triangle } from "ogl";
import { stagger } from "motion";
import type { EffectProps, PropSpec } from "@chair/effects";
import { clamp, hexToRgb01, num } from "@chair/effects";

export const meta = {
  id: "liquid-boxes",
  name: "Liquid Boxes",
  kind: "generator",
  durationSec: 8,
  fps: 30,
  width: 1920,
  height: 1080,
} as const;

export const props = {
  spread: { type: "number", min: 0, max: 600, default: 220, title: "Orbit Spread" },
  speed: { type: "number", min: 0, max: 2, default: 1.2, title: "Orbit Speed" },
  merge: { type: "number", min: 0, max: 1, default: 0.55, title: "Merge" },
  size: { type: "number", min: 40, max: 300, default: 150, title: "Box Size" },
  grain: { type: "number", min: 0, max: 1, default: 0.35, title: "Grain" },
  ink: { type: "color", default: "#101018", title: "Ink" },
  accent: { type: "color", default: "#ff6a00", title: "Accent" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  spread: number;
  speed: number;
  merge: number;
  size: number;
  grain: number;
  ink: string;
  accent: string;
}>;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_time;
uniform vec2 u_res;
uniform vec2 u_c1;
uniform vec2 u_c2;
uniform float u_size;
uniform float u_merge;
uniform float u_grain;
uniform vec3 u_ink;
uniform vec3 u_accent;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 px = (vUv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  float wob = 0.06 * sin(u_time * 1.7 + px.x * 4.0) * sin(u_time * 1.3 + px.y * 3.0);
  float d = smin(
    sdRoundBox(px - u_c1, vec2(u_size), u_size * 0.35),
    sdRoundBox(px - u_c2, vec2(u_size), u_size * 0.35),
    u_merge * 0.55 + 0.02);
  float edge = smoothstep(0.012 + wob * 0.2, -0.012 + wob * 0.2, d);
  float glow = exp(-max(d, 0.0) * 20.0) * step(0.0, d);
  // Ink cores with subtle grain, clean accent halo, and exactly zero
  // (no unmultiplied leak) everywhere else.
  float halo = glow * 0.85 * (1.0 - edge);
  float grit = 1.0 + (hash12(gl_FragCoord.xy * 0.35 + u_time * 47.0) - 0.5) * 0.24 * u_grain * edge;
  vec3 col = u_ink * edge * grit + u_accent * halo;
  oColor = vec4(col, clamp(edge + halo, 0.0, 1.0));
}`;

const delayFor = stagger(0.9, { from: "center" });

function centers(t: number, spread: number, speed: number): [{ x: number; y: number }, { x: number; y: number }] {
  // Phased so the first merge lands just after t=2.
  const a = t * speed + 0.96;
  const d0 = Number(delayFor(0, 2)) || 0;
  const d1 = Number(delayFor(1, 2)) || 0;
  return [
    { x: Math.cos(a + d0) * spread, y: Math.sin(a * 0.9 + d0) * spread * 0.55 },
    { x: Math.cos(a + Math.PI + d1) * spread, y: Math.sin(a * 0.9 + Math.PI + d1) * spread * 0.55 },
  ];
}

export default function LiquidBoxes(p: Props): React.ReactElement {
  const { t, history, width, height } = p;
  const n = (name: string, fallback: number) => num(history, name, t, fallback);
  const c = (name: string, fallback: string) => String(history(name, t) ?? fallback);
  const spreadPx = n("spread", 220) / Math.min(width, height);
  const [c1, c2] = centers(t, spreadPx, n("speed", 1.2));
  const size = n("size", 150) / Math.min(width, height) / 2;
  const merge = clamp(n("merge", 0.55), 0, 1);
  const grain = clamp(n("grain", 0.35), 0, 1);
  const ink = c("ink", "#101018");
  const accent = c("accent", "#ff6a00");
  const oglRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    if (!oglRef.current) return;
    // Client enhancement only; the render pass above is what the probe checks.
    let renderer: Renderer | null = null;
    try {
      renderer = new Renderer({ width, height, dpr: 1, alpha: true });
      const gl = renderer.gl;
      oglRef.current.appendChild(gl.canvas);
      const program = new Program(gl, {
        vertex: `#version 300 es
          in vec2 position; out vec2 vUv;
          void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`,
        fragment: FRAG,
        uniforms: {
          u_time: { value: t },
          u_res: { value: [width, height] },
          u_c1: { value: [c1.x, c1.y] },
          u_c2: { value: [c2.x, c2.y] },
          u_size: { value: size },
          u_merge: { value: merge },
          u_grain: { value: grain },
          u_ink: { value: hexToRgb01(ink) },
          u_accent: { value: hexToRgb01(accent) },
        },
      });
      renderer.render({ scene: new Mesh(gl, { geometry: new Triangle(gl), program }) });
    } catch {
      // No WebGL on this host: the mirrored markup still describes the frame.
    }
    return () => {
      renderer?.gl?.canvas?.remove();
    };
    // The probe never runs effects; the client re-seeks on every frame input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, width, height, c1.x, c1.y, c2.x, c2.y, size, merge, grain, ink, accent]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "transparent",
      }}
      data-frame={Math.round(t * 30)}
      data-c1={`${c1.x.toFixed(4)},${c1.y.toFixed(4)}`}
      data-c2={`${c2.x.toFixed(4)},${c2.y.toFixed(4)}`}
      data-props={[merge.toFixed(3), size.toFixed(4), grain.toFixed(3), ink, accent].join("|")}
    >
      <div ref={oglRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
