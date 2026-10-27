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
 * near-paper so the composer sits on calm ground.
 *
 * Layout is measured in fractions of the panel: the moon's position and
 * radius, the band tops, and the wave height offsets are all UV, so the
 * composition scales with the window and with the `cell` prop. One dither
 * cell in UV (`1.0 / res.y`) is reserved for strokes that should stay a
 * fixed number of cells thick — the crest lines and the moon ring — and the
 * terrace blocks stay four cells wide, so the staircase grain matches the
 * dither at any size. Two theme tones (`--dither-paper` → `--dither-ink`)
 * on `bayer4` with one level per matrix rank keep the dither regular;
 * `speed` and the per-band terrace and crest rates give the water a slow
 * drift and bob without stealing the chat's calm, and `stillTime` holds one
 * calm frame for reduced motion.
 */
const NIGHT_FIELD = `
// A wave surface snapped to three levels, sampled per block of cells, so
// every edge is a pixel staircase instead of a smooth slope. The drift
// slides the whole block grid sideways, in blocks per field-second, so the
// terraces travel and not only bob.
float terrace(float x, float block, float t, float rate, float drift, float seed) {
  float bi = floor(x / block + t * drift);
  float wave = sin(bi * 1.7 + t * rate + seed)
    + 0.5 * sin(bi * 2.9 - t * rate * 1.7 + seed * 2.0);
  return floor(wave + 1.5) - 1.0;
}

// Broken crest dashes: whole blocks of six cells are inked or not, and the
// pattern slides with time.
bool crestOn(float x, float cell, float t, float rate, float seed) {
  float bi = floor(x / (6.0 * cell));
  return fract(bi * 0.618034 + t * rate + seed) < 0.5;
}

float field(vec2 uv, vec2 res, float t) {
  float aspect = res.x / res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  // One dither cell in UV — for strokes only, never for layout.
  float cell = 1.0 / res.y;
  // Terrace blocks stay a fixed number of dither cells wide.
  float block = 4.0 * cell;

  float tone = 0.0;

  // The moon: a hard disc at a fixed fraction of the panel, radius in UV so
  // it scales with the window, plus a two-cell ring, nothing soft.
  float moonR = 0.048;
  float d = length(p - vec2(aspect * 0.68, 0.72));
  tone = max(1.0 - step(moonR, d), (1.0 - step(moonR + 2.0 * cell, d)) * 0.3125);

  // Water: the band tops are fractions of the panel height, waved by a
  // terraced field whose height offsets are UV fractions too, so the
  // composition holds its proportions at any size. The first stepped edge
  // the cell falls under wins, and each band under it is quieter, down to
  // near-paper at the bottom edge. Each band bobs and drifts at its own
  // rate for parallax.
  float top0 = 0.30 + 0.016 * terrace(p.x, block, t, 1.0, 0.45, 1.7);
  float top1 = 0.22 + 0.012 * terrace(p.x, block, t, 1.2, 0.60, 4.2);
  float top2 = 0.15 + 0.009 * terrace(p.x, block, t, 1.45, 0.75, 7.9);
  float top3 = 0.09;

  if (uv.y < top0) {
    tone = 0.375;
    if (uv.y > top0 - cell && crestOn(p.x, cell, t, 0.8, 0.0)) tone = 1.0;
    if (uv.y < top1) {
      tone = 0.25;
      if (uv.y > top1 - cell && crestOn(p.x, cell, t, 1.0, 0.5)) tone = 1.0;
      if (uv.y < top2) {
        tone = 0.125;
        if (uv.y > top2 - cell && crestOn(p.x, cell, t, 1.2, 0.25)) tone = 1.0;
        if (uv.y < top3) {
          tone = 0.0625;
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
      levels={17}
      speed={0.35}
      stillTime={6}
      className={cn("absolute inset-0", className)}
      {...props}
    />
  );
}
