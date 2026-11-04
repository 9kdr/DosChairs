/** Inspector prop definitions: what becomes an OGraf manifest schema property. */
export type OgrafPropType = "number" | "color" | "text" | "bool";

export interface OgrafProp {
  id: string;
  label: string;
  type: OgrafPropType;
  default: string | number | boolean;
  min?: number;
  max?: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Normalize to lowercase `#rrggbb`; fall back to white when unparseable. */
export function normalizeHexColor(v: unknown): string {
  if (typeof v !== "string") return "#ffffff";
  let h = v.startsWith("#") ? v.slice(1) : v;
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (/^[0-9a-fA-F]{6}$/.test(h)) return `#${h.toLowerCase()}`;
  return "#ffffff";
}

function titleCase(id: string): string {
  return id
    .split(/[-_]+/)
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * One prop to one OGraf schema property (Inspector control). Fusion renders
 * at most 20 dynamic parameters; the manifest builder slices there.
 */
export function propToSchema(prop: OgrafProp): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: prop.label || titleCase(prop.id),
    default: prop.default,
  };
  switch (prop.type) {
    case "color":
      return {
        ...base,
        type: "string",
        gddType: "color-rrggbb",
        pattern: "^#[0-9a-f]{6}$",
        default: normalizeHexColor(prop.default),
      };
    case "text":
      return { ...base, type: "string", default: String(prop.default ?? "") };
    case "bool":
      return { ...base, type: "boolean", default: Boolean(prop.default) };
    case "number":
    default: {
      const schema: Record<string, unknown> = {
        ...base,
        type: "number",
        default: isFiniteNumber(prop.default) ? prop.default : 0,
      };
      if (isFiniteNumber(prop.min)) schema["minimum"] = prop.min;
      if (isFiniteNumber(prop.max)) schema["maximum"] = prop.max;
      return schema;
    }
  }
}

/** Defaults object injected into the bundle: every prop id to its default. */
export function propDefaults(props: OgrafProp[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const prop of props) {
    const schema = propToSchema(prop);
    out[prop.id] = schema["default"] as string | number | boolean;
  }
  return out;
}
