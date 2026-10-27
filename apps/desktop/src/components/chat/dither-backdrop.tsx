"use client";

import { Button } from "@/components/ui/button";
import { DitherShader, DITHER_MATRICES } from "@/lib/dither";
import type { DitherMatrix, DitherShaderProps } from "@/lib/dither";
import { cn } from "@/lib/utils";

/**
 * Mono paper → ink, and only those two tones. Every scene returns 0 or 1,
 * so the matrix never stipples a mid-grey. The default is a still wash:
 * three solid ink shelves, paper everywhere else, including under the
 * composer. `speed` 0 and `stillTime` hold one frame; reduced motion uses
 * that same still frame.
 */
const WASH_FIELD = `
float field(vec2 uv, vec2 res, float t) {
  float y = uv.y;
  float top = step(0.86, y);
  float mid = step(0.50, y) * (1.0 - step(0.58, y));
  float low = step(0.18, y) * (1.0 - step(0.24, y));
  return max(top, max(mid, low));
}
`;

/** One hard ring and a hard outer frame. The centre stays paper. */
const VIGNETTE_FIELD = `
float field(vec2 uv, vec2 res, float t) {
  vec2 p = uv - vec2(0.5, 0.5);
  p.x *= res.x / max(res.y, 1.0);
  float r = length(p);
  float ring = step(0.64, r) * (1.0 - step(0.70, r));
  float frame = step(0.82, r);
  return max(ring, frame);
}
`;

/** Sparse ink cells. Each cell is fully paper or fully ink. */
const NOISE_FIELD = `
float field(vec2 uv, vec2 res, float t) {
  vec2 id = floor(uv * max(res, vec2(1.0)));
  float n = fract(sin(dot(id, vec2(127.1, 311.7))) * 43758.5453);
  return step(0.92, n);
}
`;

const OFF_FIELD = `
float field(vec2 uv, vec2 res, float t) {
  return 0.0;
}
`;

export const DITHER_SCENES = ["off", "wash", "vignette", "noise"] as const;
export type DitherScene = (typeof DITHER_SCENES)[number];

export const DITHER_CELLS = [3, 4, 6] as const;
export type DitherCell = (typeof DITHER_CELLS)[number];

export type DitherLook = {
  matrix: DitherMatrix;
  cell: DitherCell;
  scene: DitherScene;
};

const SCENE_FIELDS: Record<DitherScene, string> = {
  off: OFF_FIELD,
  wash: WASH_FIELD,
  vignette: VIGNETTE_FIELD,
  noise: NOISE_FIELD,
};

const SCENE_LABEL: Record<DitherScene, string> = {
  off: "Off",
  wash: "Wash",
  vignette: "Vignette",
  noise: "Noise",
};

const MATRIX_LABEL: Record<DitherMatrix, string> = {
  bayer2: "2",
  bayer4: "4",
  bayer8: "8",
  "blue-noise": "BN",
};

const MATRIX_NAME: Record<DitherMatrix, string> = {
  bayer2: "Bayer 2",
  bayer4: "Bayer 4",
  bayer8: "Bayer 8",
  "blue-noise": "Blue noise",
};

type DitherBackdropProps = Omit<
  DitherShaderProps,
  "field" | "colorField" | "uniforms" | "fallback" | "palette"
> & {
  scene?: DitherScene;
};

export function DitherBackdrop({
  className,
  scene = "wash",
  speed = 0,
  animate,
  ...props
}: DitherBackdropProps) {
  return (
    <DitherShader
      palette={["--dither-paper", "--dither-ink"]}
      matrix="bayer4"
      cell={4}
      stillTime={0}
      {...props}
      field={SCENE_FIELDS[scene]}
      speed={speed}
      animate={animate ?? speed !== 0}
      className={cn("absolute inset-0", className)}
    />
  );
}

function DitherChoice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; name?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="text-[11px] text-subtle">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="inline-flex rounded-lg border border-edge bg-surface p-0.5 shadow-rim"
      >
        {options.map((option) => {
          const pressed = option.value === value;
          return (
            <Button
              key={String(option.value)}
              type="button"
              size="xs"
              variant="ghost"
              aria-pressed={pressed}
              aria-label={option.name ?? option.label}
              data-pressed={pressed ? "" : undefined}
              className={cn(
                "rounded-md px-1.5 text-subtle",
                pressed && "bg-foreground/10 text-foreground",
              )}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function DitherControlStrip({
  matrix,
  cell,
  scene,
  onMatrix,
  onCell,
  onScene,
}: {
  matrix: DitherMatrix;
  cell: DitherCell;
  scene: DitherScene;
  onMatrix: (matrix: DitherMatrix) => void;
  onCell: (cell: DitherCell) => void;
  onScene: (scene: DitherScene) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <DitherChoice
        label="Matrix"
        value={matrix}
        onChange={onMatrix}
        options={DITHER_MATRICES.map((id) => ({
          value: id,
          label: MATRIX_LABEL[id],
          name: MATRIX_NAME[id],
        }))}
      />
      <DitherChoice
        label="Cell"
        value={cell}
        onChange={onCell}
        options={DITHER_CELLS.map((size) => ({
          value: size,
          label: String(size),
          name: `${size} pixel cells`,
        }))}
      />
      <DitherChoice
        label="Field"
        value={scene}
        onChange={onScene}
        options={DITHER_SCENES.map((id) => ({
          value: id,
          label: SCENE_LABEL[id],
        }))}
      />
    </div>
  );
}
