/**
 * Liquid Boxes (gold module): two boxes orbit, touch, and merge through a
 * smooth-min SDF, rendered by OGL with a Paper grain-gradient over the top.
 *
 * Seeking: OGL paints one frame per seek (`u_time = t`, render once) and the
 * Paper mount is parked with `setFrame(t * 1000)` at speed 0. Per-box phase
 * offsets come from motion's pure `stagger()`, so the render pass — the one
 * the determinism probe reads — computes the exact same centers the client
 * mounts paint. Mirror attributes (`data-c1`, `data-frame`, ...) carry every
 * prop into SSR markup.
 */
import React from "react";
import { Renderer, Program, Mesh, Triangle } from "ogl";
import { stagger } from "motion";
import { ShaderMount, getShaderColorFromString, grainGradientFragmentShader } from "@paper-design/shaders";
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
  speed: { type: "number", min: 0, max: 2, default: 0.6, title: "Orbit Speed" },
  merge: { type: "number", min: 0, max: 1, default: 0.55, title: "Merge" },
  size: { type: "number", min: 40, max: 300, default: 150, title: "Box Size" },
  grain: { type: "number", min: 0, max: 1, default: 0.35, title: "Grain" },
  ink: { type: "color", default: "#101018", title: "Ink" },
  accent: { type: "color", default: "#ff6a00", title: "Accent" },
  paper: { type: "color", default: "#f1ebdd", title: "Paper" },
  backdrop: { type: "boolean", default: false, title: "Backdrop Fill" },
} satisfies Record<string, PropSpec>;

type Props = EffectProps<{
  spread: number;
  speed: number;
  merge: number;
  size: number;
  grain: number;
  ink: string;
  accent: string;
  paper: string;
  backdrop: boolean;
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
uniform vec3 u_ink;
uniform vec3 u_accent;
uniform vec3 u_paper;
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
void main() {
  vec2 px = (vUv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  float wob = 0.06 * sin(u_time * 1.7 + px.x * 4.0) * sin(u_time * 1.3 + px.y * 3.0);
  float d = smin(sdBox(px - u_c1, vec2(u_size)), sdBox(px - u_c2, vec2(u_size)), u_merge * 0.55 + 0.02);
  float edge = smoothstep(0.012 + wob * 0.2, -0.012 + wob * 0.2, d);
  vec3 col = mix(u_paper, u_ink, edge);
  float glow = exp(-max(d, 0.0) * 6.0) * step(0.0, d);
  col = mix(col, u_accent, glow * 0.85);
  oColor = vec4(col, 1.0);
}`;

const delayFor = stagger(0.9, { from: "center" });

function centers(t: number, spread: number, speed: number): [{ x: number; y: number }, { x: number; y: number }] {
  const a = t * speed;
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
  const backdrop = history("backdrop", t) === true;
  const spreadPx = n("spread", 220) / Math.min(width, height);
  const [c1, c2] = centers(t, spreadPx, n("speed", 0.6));
  const size = n("size", 150) / Math.min(width, height) / 2;
  const merge = clamp(n("merge", 0.55), 0, 1);
  const grain = clamp(n("grain", 0.35), 0, 1);
  const oglRef = React.useRef<HTMLDivElement | null>(null);
  const grainRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    if (!oglRef.current || !grainRef.current) return;
    // Client enhancement only; the render pass above is what the probe checks.
    let renderer: Renderer | null = null;
    let mount: ShaderMount | null = null;
    try {
      renderer = new Renderer({ width, height, dpr: 1 });
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
          u_ink: { value: hexToRgb01(c("ink", "#101018")) },
          u_accent: { value: hexToRgb01(c("accent", "#ff6a00")) },
          u_paper: { value: hexToRgb01(c("paper", "#f1ebdd")) },
        },
      });
      renderer.render({ scene: new Mesh(gl, { geometry: new Triangle(gl), program }) });
      mount = new ShaderMount(grainRef.current, grainGradientFragmentShader, {}, undefined, 0, Math.round(t * 1000));
      mount.setUniforms({
        u_colorBack: getShaderColorFromString(c("paper", "#f1ebdd")),
        u_colors: [c("ink", "#101018"), c("accent", "#ff6a00"), c("paper", "#f1ebdd")].map((hex) => getShaderColorFromString(hex)),
        u_colorsCount: 3,
        u_softness: 0.5,
        u_intensity: 0.8,
        u_noise: grain,
        u_shape: 2,
      });
      mount.setSpeed(0);
      mount.setFrame(Math.round(t * 1000));
    } catch {
      // No WebGL on this host: the mirrored markup still describes the frame.
    }
    return () => {
      mount?.dispose();
      renderer?.gl?.canvas?.remove();
    };
    // The probe never runs effects; the client re-seeks on every frame input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, width, height, c1.x, c1.y, c2.x, c2.y, size, merge, grain]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: backdrop ? c("paper", "#f1ebdd") : "transparent",
      }}
      data-frame={Math.round(t * 30)}
      data-c1={`${c1.x.toFixed(4)},${c1.y.toFixed(4)}`}
      data-c2={`${c2.x.toFixed(4)},${c2.y.toFixed(4)}`}
      data-props={[merge.toFixed(3), size.toFixed(4), grain.toFixed(3), c("ink", ""), c("accent", ""), c("paper", "")].join("|")}
    >
      <div ref={oglRef} style={{ position: "absolute", inset: 0 }} />
      <div ref={grainRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.5 }} />
    </div>
  );
}
