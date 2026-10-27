"use client";

import { DitherShader } from "@/lib/dither";
import type { DitherShaderProps } from "@/lib/dither";
import { cn } from "@/lib/utils";

/**
 * The night scene, kept quiet: a solid paper sky, one hard-edged moon with a
 * two-cell dithered ring, and four stepped water bands along the bottom in
 * the Stardew style — blocky terraced edges with broken ink crests, each
 * band a shade quieter toward the viewer. The sky is tone 0, so every cell
 * above the water stays clean paper, and the bottom band fades to
 * near-paper so the composer sits on calm ground. Two theme tones
 * (`--dither-paper` → `--dither-ink`) on `bayer4` keep the dither regular;
 * `stillTime` holds one calm frame for reduced motion.
 */
const NIGHT_FIELD = `
// A wave surface snapped to three levels, sampled per block of cells, so
// every edge is a pixel staircase instead of a smooth slope.
float terrace(float x, float block, float t, float rate, float seed) {
  float bi = floor(x / block);
  float wave = sin(bi * 1.7 + t * rate + seed)
    + 0.5 * sin(bi * 3.3 - t * rate * 1.4 + seed * 2.0);
  return floor(wave + 1.5) - 1.0;
}

// Broken crest dashes: whole blocks of six cells are inked or not, and the
// pattern slides slowly with time.
bool crestOn(float x, float cell, float t, float rate, float seed) {
  float bi = floor(x / (6.0 * cell));
  return fract(bi * 0.618034 + t * rate + seed) < 0.5;
}

float field(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float cell = 1.0 / res.y;
  float block = 4.0 * cell;

  float tone = 0.0;

  // The moon: a hard disc plus a two-cell ring, nothing soft.
  float d = length(p - vec2(aspect * 0.68, 0.72));
  tone = max(1.0 - step(0.048, d), (1.0 - step(0.048 + 2.0 * cell, d)) * 0.31);

  // Water: the first stepped edge the cell falls under wins, and each band
  // under it is quieter, down to near-paper at the bottom edge.
  float top0 = 0.30 + 1.5 * cell * terrace(p.x, block, t, 0.05, 1.7);
  float top1 = 0.22 + 1.5 * cell * terrace(p.x, block, t, 0.07, 4.2);
  float top2 = 0.15 + 1.5 * cell * terrace(p.x, block, t, 0.09, 7.9);
  float top3 = 0.09;

  if (uv.y < top0) {
    tone = 0.36;
    if (uv.y > top0 - cell && crestOn(p.x, cell, t, 0.15, 0.0)) tone = 1.0;
    if (uv.y < top1) {
      tone = 0.24;
      if (uv.y > top1 - cell && crestOn(p.x, cell, t, 0.18, 0.5)) tone = 1.0;
      if (uv.y < top2) {
        tone = 0.13;
        if (uv.y > top2 - cell && crestOn(p.x, cell, t, 0.21, 0.25)) tone = 1.0;
        if (uv.y < top3) {
          tone = 0.05;
        }
      }
    }
  }
  return tone;
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
      palette={["--dither-paper", "--dither-ink"]}
      matrix="bayer4"
      cell={4}
      speed={0.1}
      stillTime={6}
      className={cn("absolute inset-0", className)}
      {...props}
    />
  );
}
