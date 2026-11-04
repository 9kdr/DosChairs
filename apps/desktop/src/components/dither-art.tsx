"use client";

import type { ComponentProps } from "react";
import { DitherShader } from "@/lib/dither";
import { cn } from "@/lib/utils";

/**
 * One small static dither moment for empty states (#258 batch A).
 * A 96x64 DitherShader at cell 2 that never animates; `seed` picks the
 * wave so different empties don't look identical.
 */
const ART_FIELD = `
float field(vec2 uv, vec2 res, float t) {
  float id = artSeed * 7.0;
  float grain = hash21(floor(uv * res * 0.5) + id);
  float wave = 0.5 + 0.5 * sin(uv.x * 6.28318 * (1.0 + fract(id * 0.13) * 2.0) + id);
  float sea = smoothstep(0.15, 0.85, uv.y * 0.7 + wave * 0.3);
  return clamp(sea * 0.55 + grain * 0.45, 0.0, 1.0);
}`;

export interface DitherArtProps
  extends Omit<
    ComponentProps<typeof DitherShader>,
    "animate" | "cell" | "children" | "field" | "uniforms"
  > {
  /** Picks the wave variant. Default 1. */
  seed?: number;
}

export function DitherArt({
  seed = 1,
  className,
  ...props
}: DitherArtProps): React.ReactElement {
  return (
    <DitherShader
      field={ART_FIELD}
      uniforms={{ artSeed: seed }}
      cell={2}
      animate={false}
      stillTime={0}
      className={cn("h-16 w-24", className)}
      {...props}
    />
  );
}
