/** Shape checks for an effect module's `meta` and `props` exports, and the static source scan. */
import type { OgrafProp } from "@chair/ograf";
import type { EffectMeta, ModuleKind } from "../kit/types.js";

export const MODULE_KINDS: ModuleKind[] = ["generator", "overlay", "rig", "transition", "background"];
/** Names the wrapper passes to every frame; a prop may not shadow them. */
export const RESERVED_PROPS = ["t", "frame", "fps", "width", "height", "history", "data", "children", "key", "ref"];
export const MAX_PROPS = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface Shape<T> {
  value: T | null;
  errors: string[];
  warnings: string[];
}

export function validateMeta(raw: unknown): Shape<EffectMeta> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { value: null, errors: ["`export const meta` must be an object"], warnings };
  const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
  if (!id) errors.push("meta.id must be a non-empty string");
  const name = typeof raw["name"] === "string" && raw["name"].trim() ? raw["name"].trim() : "";
  if (!name) errors.push("meta.name must be a non-empty string");
  const durationSec = raw["durationSec"];
  if (!finite(durationSec) || durationSec <= 0 || durationSec > 600) {
    errors.push("meta.durationSec must be a number in (0, 600]");
  }
  let kind = raw["kind"] as ModuleKind;
  if (!MODULE_KINDS.includes(kind)) {
    if (raw["kind"] !== undefined) errors.push(`meta.kind must be one of ${MODULE_KINDS.join(", ")}`);
    else warnings.push("meta.kind missing; assuming 'generator'");
    kind = "generator";
  }
  const dim = (key: "fps" | "width" | "height", fallback: number, lo: number, hi: number): number => {
    const v = raw[key];
    if (v === undefined) {
      warnings.push(`meta.${key} missing; assuming ${fallback}`);
      return fallback;
    }
    if (!finite(v) || v < lo || v > hi) {
      errors.push(`meta.${key} must be a number in [${lo}, ${hi}]`);
      return fallback;
    }
    return v;
  };
  const fps = dim("fps", 30, 1, 120);
  const width = dim("width", 1920, 16, 7680);
  const height = dim("height", 1080, 16, 7680);
  if (errors.length > 0) return { value: null, errors, warnings };
  return {
    value: { id, name, kind, durationSec: durationSec as number, fps, width: Math.round(width), height: Math.round(height) },
    errors,
    warnings,
  };
}

export function validateProps(raw: unknown): Shape<OgrafProp[]> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { value: null, errors: ["`export const props` must be an object"], warnings };
  const ids = Object.keys(raw);
  if (ids.length === 0) errors.push("`props` is empty: expose at least one Inspector control");
  if (ids.length > MAX_PROPS) errors.push(`props has ${ids.length} entries; Fusion allows at most ${MAX_PROPS}`);
  const out: OgrafProp[] = [];
  for (const id of ids) {
    const spec = raw[id];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
      errors.push(`prop '${id}': id must be a plain identifier`);
      continue;
    }
    if (RESERVED_PROPS.includes(id)) {
      errors.push(`prop '${id}': name is reserved by the host (${RESERVED_PROPS.join(", ")})`);
      continue;
    }
    if (!isRecord(spec)) {
      errors.push(`prop '${id}': must be an object with type and default`);
      continue;
    }
    const label = typeof spec["title"] === "string" && spec["title"].trim() ? spec["title"].trim() : id;
    const type = spec["type"];
    const def = spec["default"];
    if (type === "number") {
      if (!finite(def)) {
        errors.push(`prop '${id}': number default must be a finite number`);
        continue;
      }
      const min = finite(spec["min"]) ? spec["min"] : undefined;
      const max = finite(spec["max"]) ? spec["max"] : undefined;
      if (min === undefined || max === undefined) {
        warnings.push(`prop '${id}': give a min and max so the Inspector slider has a range`);
      }
      if ((min !== undefined && def < min) || (max !== undefined && def > max) || (min !== undefined && max !== undefined && min >= max)) {
        errors.push(`prop '${id}': default ${def} must sit inside [min, max]`);
        continue;
      }
      out.push({ id, label, type: "number", default: def, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
    } else if (type === "color") {
      if (typeof def !== "string" || !/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(def)) {
        errors.push(`prop '${id}': color default must be a '#rrggbb' string`);
        continue;
      }
      out.push({ id, label, type: "color", default: def });
    } else if (type === "string" || type === "text") {
      if (typeof def !== "string") {
        errors.push(`prop '${id}': string default must be a string`);
        continue;
      }
      out.push({ id, label, type: "text", default: def });
    } else if (type === "boolean" || type === "bool") {
      if (typeof def !== "boolean") {
        errors.push(`prop '${id}': boolean default must be true or false`);
        continue;
      }
      out.push({ id, label, type: "bool", default: def });
    } else {
      errors.push(`prop '${id}': type must be number, color, string, or boolean`);
    }
  }
  if (errors.length > 0) return { value: null, errors, warnings };
  const keyframable = out.filter((p) => p.type === "number" || p.type === "color").length;
  if (keyframable === 0) warnings.push("no number or color props: nothing here can be keyframed in Fusion");
  return { value: out, errors, warnings };
}

/** APIs a frame must never touch: a clock, randomness, timers, or the network. */
const BANNED: { re: RegExp; why: string }[] = [
  { re: /\bDate\s*\.\s*now\b|\bnew\s+Date\b|\bDate\s*\(/, why: "reads the clock (use t)" },
  { re: /\bperformance\s*\.\s*now\b/, why: "reads the clock (use t)" },
  { re: /\bMath\s*\.\s*random\b/, why: "unseeded random (use mulberry32 / hash2)" },
  { re: /\brequestAnimationFrame\b|\bcancelAnimationFrame\b/, why: "animation loop (Resolve drives time through goToTime)" },
  { re: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/, why: "timer" },
  { re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, why: "network access (renders are offline)" },
  { re: /\beval\s*\(|\bnew\s+Function\b|\bimport\s*\(/, why: "dynamic code loading" },
  { re: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bdocument\s*\.\s*cookie\b/, why: "persistent state" },
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

/** Line-numbered hits of banned APIs in module source (comments ignored). */
export function scanSource(source: string): string[] {
  const hits: string[] = [];
  const lines = stripComments(source).split("\n");
  lines.forEach((line, i) => {
    for (const { re, why } of BANNED) {
      const m = re.exec(line);
      if (m) hits.push(`line ${i + 1}: \`${m[0].trim()}\` ${why}`);
    }
  });
  return hits;
}
