"use client";

import { DitherShader } from "@/lib/dither";
import type { DitherShaderProps } from "@/lib/dither";
import { cn } from "@/lib/utils";

/**
 * A warm lamp above the panel fading into faint drifting clouds, drawn by the
 * dithercn engine. Tone stays near zero at the bottom so the composer sits on
 * clean ground, and `stillTime` keeps the reduced-motion frame fully lit.
 */
const BACKDROP_FIELD = `
float chairLamp(vec2 p, float aspect, float t) {
  vec2 lamp = vec2(aspect * 0.5, 1.02);
  lamp += 0.05 * vec2(sin(t * 0.19), cos(t * 0.14));
  float d2 = dot(p - lamp, p - lamp);
  return exp(-d2 * 8.0) * (0.9 + 0.1 * sin(t * 0.27));
}

float field(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float lamp = chairLamp(p, aspect, t);
  float clouds = (fbm(p * 1.7 + vec2(t * 0.05, t * 0.032)) - 0.5) * 0.1;
  return clamp((lamp * 0.85 + clouds) * smoothstep(0.06, 0.4, uv.y), 0.0, 1.0);
}
`;

type DitherBackdropProps = Omit<
  DitherShaderProps,
  "field" | "colorField" | "uniforms" | "fallback"
>;

export function DitherBackdrop({ className, ...props }: DitherBackdropProps) {
  return (
    <DitherShader
      field={BACKDROP_FIELD}
      palette={["--dither-paper", "--dither-color-grey", "--dither-color-orange"]}
      matrix="blue-noise"
      speed={0.4}
      stillTime={6}
      className={cn("absolute inset-0", className)}
      {...props}
    />
  );
}
