/**
 * Effect-spec export through the generic OGraf wrapper (@chair/ograf).
 *
 * `exportOGraf(spec)` is one consumer of `wrapReactComponent`: the spec's
 * layers/curves/shader/rig travel as the wrapper's `data` payload, the
 * published controls become Inspector props, and `EffectSpecView`
 * (`spec-view.tsx`) paints the frame as a pure function of (props, t) with
 * the shared Canvas2D helpers (`canvas2d.ts`) and the existing curve/rig
 * math from this package.
 */
import { fileURLToPath } from "node:url";
import { wrapReactComponent } from "@chair/ograf";
import type { OgrafBundle, OgrafProp } from "@chair/ograf";
import type { Control, EffectSpec, ExportTarget } from "./types.js";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Recommended export target, cheapest native option first: a shape/text-only
 * spec becomes a Fusion macro; a spec with a custom shader needs the web
 * title path (OGraf); image layers with external files fall back to a
 * rendered clip. A caller-set `spec.export.target` wins over this guess.
 */
export function selectExportTarget(spec: EffectSpec): ExportTarget {
  const layers = spec.layers ?? [];
  if (spec.shader || layers.some((l) => l.type === "shader")) return "ograf";
  if (layers.some((l) => l.type === "image")) return "rendered-clip";
  return "fusion-macro";
}

/** One published control to one wrapper prop (Inspector control). */
export function controlToProp(control: Control): OgrafProp {
  return {
    id: control.id,
    label: control.label,
    type: control.type,
    default: control.default,
    ...(isFiniteNumber(control.min) ? { min: control.min } : {}),
    ...(isFiniteNumber(control.max) ? { max: control.max } : {}),
  };
}

/**
 * Both files Resolve scans: `<id>.ograf.json` manifest + `<id>.js` component.
 * The view entry defaults to the sibling `spec-view.tsx`; pass `entry`
 * explicitly when calling from a bundled script, where `import.meta.url` no
 * longer points at this package's source.
 */
export async function exportOGraf(spec: EffectSpec, opts?: { entry?: string }): Promise<OgrafBundle> {
  const entry = opts?.entry ?? fileURLToPath(new URL("./spec-view.tsx", import.meta.url));
  return wrapReactComponent({
    id: spec.id,
    name: spec.name,
    description: `Chair effect "${spec.name}" exported as an OGraf title.`,
    durationSec: spec.durationSec,
    fps: spec.fps,
    width: spec.width,
    height: spec.height,
    entry,
    props: (spec.controls ?? []).slice(0, 20).map(controlToProp),
    data: {
      spec: {
        schemaVersion: spec.schemaVersion,
        id: spec.id,
        name: spec.name,
        durationSec: spec.durationSec,
        fps: spec.fps,
        width: spec.width,
        height: spec.height,
        layers: spec.layers,
        controls: spec.controls ?? [],
        shader: spec.shader,
        rig: spec.rig,
      },
    },
  });
}
