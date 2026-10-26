"use client";

import { DitherShader } from "@/lib/dither";
import type { DitherShaderProps } from "@/lib/dither";
import { cn } from "@/lib/utils";

/**
 * The night scene: a full moon centred two thirds up, three drifting wave
 * bands along the bottom, and a shimmering moon path between them. Waves stay
 * in the low tones so the composer keeps contrast at the bottom edge, and
 * `stillTime` holds one calm frame for reduced motion. Tone 1 is the theme's
 * `--dither-ink`, so the disc reads bright in dark mode and dark in light
 * mode — the scene follows the theme instead of forcing one.
 */
const NIGHT_FIELD = `
float waveLine(float x, float t, float freq, float amp, float drift) {
  return amp * (
    sin(x * freq + t * drift) +
    0.5 * sin(x * freq * 2.17 - t * drift * 1.6) +
    0.25 * sin(x * freq * 4.31 + t * drift * 2.3)
  );
}

float field(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  float tone = 0.05 + 0.08 * smoothstep(0.0, 0.6, uv.y);

  vec2 moon = vec2(aspect * 0.5, 0.64);
  float d = length(p - moon);
  tone += 1.0 - smoothstep(0.082, 0.092, d);
  tone += exp(-d * d * 30.0) * 0.28;

  float dx = (p.x - moon.x) * 2.4;
  float path = exp(-dx * dx);
  float shimmer = fbm(vec2(p.x * 9.0, uv.y * 22.0) + t * 0.12);

  float h1 = 0.34 + waveLine(p.x, t, 4.5, 0.018, 0.40);
  float h2 = 0.24 + waveLine(p.x + 3.1, t, 6.3, 0.014, 0.55);
  float h3 = 0.15 + waveLine(p.x + 7.7, t, 8.4, 0.011, 0.70);

  float far = 0.34 + 0.20 * path * shimmer + 0.08 * smoothstep(h1 - 0.025, h1, uv.y);
  float mid = 0.24 + 0.12 * path * shimmer + 0.07 * smoothstep(h2 - 0.02, h2, uv.y);
  float near = 0.16 + 0.06 * path * shimmer;

  tone = mix(tone, far, step(uv.y, h1));
  tone = mix(tone, mid, step(uv.y, h2));
  tone = mix(tone, near, step(uv.y, h3));
  return clamp(tone, 0.0, 1.0);
}
`;

type DitherBackdropProps = Omit<
  DitherShaderProps,
  "field" | "colorField" | "uniforms" | "fallback"
>;

export function DitherBackdrop({ className, ...props }: DitherBackdropProps) {
  return (
    <DitherShader
      field={NIGHT_FIELD}
      palette={["--dither-paper", "--dither-color-grey", "--dither-ink"]}
      matrix="blue-noise"
      speed={0.25}
      stillTime={6}
      className={cn("absolute inset-0", className)}
      {...props}
    />
  );
}
