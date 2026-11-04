/** OGraf manifest generation from wrapper inputs. No runtime imports. */
import type { OgrafProp } from "./props.js";
import { propToSchema } from "./props.js";

export const OGRAF_SCHEMA_URL =
  "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json";

/** Manifest id/file stem: lowercase kebab, no slashes (Resolve scans by file). */
export function ografSlug(id: string): string {
  const slug = String(id || "effect")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `chair-${slug || "effect"}`;
}

/** Web-component class name derived from the id. Always a valid identifier. */
export function ografClassName(id: string): string {
  const parts = String(id || "effect").split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return `Chair${name || "Effect"}Graphic`;
}

export interface OgrafManifestOptions {
  id: string;
  name: string;
  description?: string;
  durationSec: number;
  fps?: number;
  width?: number;
  height?: number;
  props?: OgrafProp[];
}

/** Manifest for one title: the Resolve-required fields generated from inputs. */
export function manifestForOgarf(opts: OgrafManifestOptions): Record<string, unknown> {
  const id = ografSlug(opts.id);
  const properties: Record<string, unknown> = {};
  for (const prop of (opts.props ?? []).slice(0, 20)) {
    properties[prop.id] = propToSchema(prop);
  }
  return {
    $schema: OGRAF_SCHEMA_URL,
    id,
    version: "1.0.0",
    name: opts.name || id,
    description: opts.description ?? `Chair OGraf title "${opts.name || id}".`,
    author: { name: "Chair" },
    main: `${id}.js`,
    v_bmd: { duration: opts.durationSec },
    stepCount: 1,
    supportsRealTime: false,
    supportsNonRealTime: true,
    schema: { type: "object", additionalProperties: false, properties },
    renderRequirements: [
      {
        resolution: {
          width: { ideal: opts.width ?? 1920 },
          height: { ideal: opts.height ?? 1080 },
        },
        frameRate: { ideal: opts.fps ?? 30 },
        accessToPublicInternet: { ideal: false },
      },
    ],
  };
}
