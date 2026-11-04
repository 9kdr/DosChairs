import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { Control, EffectSpec } from "./types.js";
import { resolveFrame } from "./curves.js";
import { simulateRig } from "./rig.js";
import {
  controlToSchema,
  exportOGraf,
  normalizeHexColor,
  ografClassName,
  ografComponentJS,
  ografId,
  ografManifest,
  ografRigTarget,
  selectExportTarget,
} from "./ograf.js";

const fixtureUrl = new URL(
  "../../../fixtures/effects/bounce-title.effect.json",
  import.meta.url,
);
const ografDir = new URL("../../../fixtures/ograf/", import.meta.url);

function loadSpec(): EffectSpec {
  return JSON.parse(readFileSync(fixtureUrl, "utf8")) as EffectSpec;
}

function ografAjv(): InstanceType<typeof Ajv2020> {
  // Vendored copy of https://ograf.ebu.io/v1/specification/json-schemas/
  // (graphics schema plus every schema it $refs). Third-party schema, so the
  // validator runs non-strict; our own schemas stay strict elsewhere.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const file of [
    "ograf-lib-action.json",
    "ograf-gdd-object.json",
    "ograf-lib-constraints-number.json",
    "ograf-lib-constraints-boolean.json",
    "ograf-gdd-gdd-types.json",
    "ograf-gdd-basic-types.json",
    "ograf-graphics-schema.json",
  ]) {
    ajv.addSchema(JSON.parse(readFileSync(new URL(file, ografDir), "utf8")));
  }
  return ajv;
}

/** Minimal DOM + canvas stand-ins that record every 2D call in order. */
function makeHarness() {
  const log: string[] = [];
  const warns: string[] = [];
  const fmt = (v: unknown): string =>
    typeof v === "number" ? String(Math.round(v * 1000) / 1000) : JSON.stringify(v);
  const makeCtx = (): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get(_t, p: string | symbol) {
          if (p === "canvas") return {};
          if (p === "measureText") return () => ({ width: 10 });
          return (...args: unknown[]) => {
            log.push(`${String(p)}(${args.map(fmt).join(",")})`);
          };
        },
        set(t, p, v) {
          log.push(`set:${String(p)}=${fmt(v)}`);
          (t as Record<string | symbol, unknown>)[p] = v;
          return true;
        },
      },
    );
  const makeElement = (tag: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tag,
      style: { setProperty: (k: string, v: string) => log.push(`style:${k}=${v}`) },
      textContent: "",
      appendChild: (c: unknown) => c,
      append: (..._cs: unknown[]) => undefined,
      remove: () => undefined,
    };
    if (tag === "canvas") {
      el["width"] = 0;
      el["height"] = 0;
      // No WebGL2 in this harness: exercises the Canvas2D fallback paths.
      el["getContext"] = (kind: string) => (kind === "2d" ? makeCtx() : null);
    }
    return el;
  };
  class FakeHTMLElement {
    style = { setProperty: (_k: string, _v: string) => undefined };
    attachShadow(_opts: unknown) {
      return { appendChild: (_c: unknown) => undefined, append: (..._cs: unknown[]) => undefined };
    }
  }
  const fakeDocument = {
    createElement: (tag: string) => makeElement(tag),
    fonts: undefined,
  };
  const fakeConsole = { warn: (...args: unknown[]) => warns.push(args.map(String).join(" ")) };
  return { log, warns, FakeHTMLElement, fakeDocument, fakeConsole };
}

/** Evaluate the shipped JS (not the TS source) with fakes, return instance. */
async function loadComponent(js: string, className: string, harness: ReturnType<typeof makeHarness>) {
  const body = js.replace(`export default ${className};`, "").trim();
  const factory = new Function(
    "HTMLElement",
    "document",
    "Image",
    "console",
    `${body}\nreturn ${className};`,
  );
  const Cls = factory(
    harness.FakeHTMLElement,
    harness.fakeDocument,
    undefined,
    harness.fakeConsole,
  );
  return new Cls() as {
    load(p: unknown): Promise<{ statusCode: number }>;
    goToTime(p: unknown): Promise<{ statusCode: number }>;
    updateAction(p: unknown): Promise<{ statusCode: number }>;
    setActionsSchedule(p: unknown): Promise<{ statusCode: number }>;
    playAction(p: unknown): Promise<{ statusCode: number; currentStep: number }>;
    stopAction(p: unknown): Promise<{ statusCode: number }>;
    dispose(): Promise<{ statusCode: number }>;
  };
}

describe("ograf export", () => {
  it("generates an Inspector schema from every control type", () => {
    const controls: Control[] = [
      { id: "size", label: "Size", type: "number", default: 1.5, min: 0.5, max: 3, target: { layerId: "a", param: "scaleX" } },
      { id: "tint", label: "Tint", type: "color", default: "#FFB000", target: { layerId: "a", param: "fill" } },
      { id: "caption", label: "Caption", type: "text", default: "hi", target: { layerId: "b", param: "string" } },
      { id: "badge", label: "Badge", type: "bool", default: true, target: { layerId: "b", param: "visible" } },
      { id: "plain", label: "Plain", type: "number", default: 2, target: { layerId: "a", param: "x" } },
    ];
    const spec = { ...loadSpec(), controls };
    const manifest = ografManifest(spec);
    const schema = manifest["schema"] as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties["size"]).toMatchObject({ type: "number", minimum: 0.5, maximum: 3, default: 1.5 });
    // Colors become native Fusion pickers; uppercase input is normalized.
    expect(schema.properties["tint"]).toMatchObject({
      type: "string",
      gddType: "color-rrggbb",
      pattern: "^#[0-9a-f]{6}$",
      default: "#ffb000",
    });
    expect(schema.properties["caption"]).toMatchObject({ type: "string", default: "hi" });
    expect(schema.properties["badge"]).toMatchObject({ type: "boolean", default: true });
    // min/max are optional; absent limits stay absent.
    expect(schema.properties["plain"]).not.toHaveProperty("minimum");
  });

  it("normalizes color defaults to lowercase #rrggbb", () => {
    expect(normalizeHexColor("#FFB000")).toBe("#ffb000");
    expect(normalizeHexColor("not-a-color")).toBe("#ffffff");
  });

  it("emits the Resolve-required manifest fields from the spec", () => {
    const spec = loadSpec();
    const manifest = ografManifest(spec);
    expect(manifest["$schema"]).toContain("ograf.ebu.io");
    expect(manifest["id"]).toBe(ografId(spec));
    expect((manifest["id"] as string)).not.toContain("/");
    expect(manifest["main"]).toBe(`${ografId(spec)}.js`);
    expect(manifest["supportsRealTime"]).toBe(false);
    expect(manifest["supportsNonRealTime"]).toBe(true);
    expect(manifest["stepCount"]).toBe(1);
    expect((manifest["v_bmd"] as { duration: number }).duration).toBe(spec.durationSec);
  });

  it("validates the sample manifest against the vendored EBU schema", () => {
    const ajv = ografAjv();
    const validate = ajv.getSchema(
      "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
    );
    expect(validate).toBeDefined();
    const manifest = ografManifest(loadSpec());
    expect(validate!(manifest)).toBe(true);
  });

  it("picks macro, then ograf for shader looks, then rendered clip", () => {
    const base = loadSpec();
    expect(selectExportTarget(base)).toBe("fusion-macro");
    expect(selectExportTarget({ ...base, shader: { source: "void main(){}" } })).toBe("ograf");
    const withShaderLayer = {
      ...base,
      layers: [...base.layers, { id: "fx", type: "shader" as const, params: {} }],
    };
    expect(selectExportTarget(withShaderLayer)).toBe("ograf");
    const withImage = {
      ...base,
      layers: [...base.layers, { id: "pic", type: "image" as const, params: { src: "a.png" } }],
    };
    expect(selectExportTarget(withImage)).toBe("rendered-clip");
  });

  it("binds the rig to the topmost layer without animated x/y", () => {
    // bounce-title: bg static, ball animated, title static -> title wins.
    expect(ografRigTarget(loadSpec())).toBe("title");
    expect(ografRigTarget({ ...loadSpec(), rig: undefined })).toBeNull();
  });

  it("ships a self-contained component implementing all 8 methods", () => {
    const js = ografComponentJS(loadSpec());
    for (const method of [
      "load(",
      "dispose(",
      "playAction(",
      "stopAction(",
      "updateAction(",
      "customAction(",
      "goToTime(",
      "setActionsSchedule(",
    ]) {
      expect(js).toContain(`async ${method}`);
    }
    expect(js).toContain(`export default ${ografClassName(loadSpec())};`);
    expect(js).not.toContain("requestAnimationFrame");
    expect(js).not.toContain("Math.random");
  });

  it("renders deterministically from time in a DOM-less host", async () => {
    const spec = loadSpec();
    const harness = makeHarness();
    const el = await loadComponent(ografComponentJS(spec), ografClassName(spec), harness);
    await el.load({ data: {}, renderType: "non-realtime" });
    await el.setActionsSchedule({ schedule: [{ timestamp: 0, action: { type: "playAction", params: {} } }] });

    harness.log.length = 0;
    await el.goToTime({ timestamp: 1000 });
    const first = [...harness.log];
    expect(first.length).toBeGreaterThan(0);

    harness.log.length = 0;
    await el.goToTime({ timestamp: 1000 });
    expect(harness.log).toEqual(first);

    // Inspector edits stick across seeks and stay deterministic.
    await el.updateAction({ data: { "title-text": "Late title" } });
    harness.log.length = 0;
    await el.goToTime({ timestamp: 1000 });
    const edited = [...harness.log];
    harness.log.length = 0;
    await el.goToTime({ timestamp: 1000 });
    expect(harness.log).toEqual(edited);

    // And time actually moves the picture.
    harness.log.length = 0;
    await el.goToTime({ timestamp: 2000 });
    expect(harness.log).not.toEqual(first);
    await el.dispose();
  });

  it("matches the TS layer resolution at the same timestamp", async () => {
    const harness = makeHarness();
    const spec = loadSpec();
    const el = await loadComponent(ografComponentJS(spec), ografClassName(spec), harness);
    await el.load({ data: {}, renderType: "non-realtime" });
    await el.setActionsSchedule({ schedule: [{ timestamp: 0, action: { type: "playAction", params: {} } }] });
    await el.goToTime({ timestamp: 1200 });
    // The component draws the resolved title layer; the TS resolveFrame
    // agrees on the animated opacity at t=1.2s.
    const resolved = resolveFrame(spec, 1.2, {});
    const title = resolved.find((l) => l.id === "title");
    expect(title?.resolved["opacity"]).toBeGreaterThan(0);
    const ops = harness.log.join("\n");
    expect(ops).toContain("fillText");
    await el.dispose();
  });

  it("bakes the same rig table as the TS sim", async () => {
    const harness = makeHarness();
    const spec = loadSpec();
    const el = await loadComponent(ografComponentJS(spec), ografClassName(spec), harness);
    await el.load({ data: {}, renderType: "non-realtime" });
    const table = (el as unknown as { _rigTable: { t: number; x: number; y: number }[] })._rigTable;
    const expected = simulateRig(spec.rig!, spec.fps);
    expect(table.length).toBe(expected.length);
    for (const i of [0, Math.floor(table.length / 2), table.length - 1]) {
      expect(table[i]!.x).toBeCloseTo(expected[i]!.x, 9);
      expect(table[i]!.y).toBeCloseTo(expected[i]!.y, 9);
    }
    await el.dispose();
  });

  it("falls back to Canvas2D with a clear message when WebGL2 is missing", async () => {
    const spec = {
      ...loadSpec(),
      shader: { source: "#version 300 es\nvoid main(){}" },
      layers: [...loadSpec().layers, { id: "fx", type: "shader" as const, params: {} }],
    };
    const harness = makeHarness();
    const el = await loadComponent(ografComponentJS(spec), ografClassName(spec), harness);
    await el.load({ data: {}, renderType: "non-realtime" });
    await el.setActionsSchedule({ schedule: [{ timestamp: 0, action: { type: "playAction", params: {} } }] });
    const res = await el.goToTime({ timestamp: 500 });
    expect(res.statusCode).toBe(200);
    // The viewer says what happened, on the canvas and once in the log.
    expect(harness.log.join("\n")).toContain("WebGL2 unavailable");
    expect(harness.warns.filter((w) => w.includes("WebGL2")).length).toBe(1);
    harness.log.length = 0;
    await el.goToTime({ timestamp: 500 });
    expect(harness.warns.filter((w) => w.includes("WebGL2")).length).toBe(1);
    await el.dispose();
  });

  it("exportOGraf bundles manifest + js under one id", () => {
    const bundle = exportOGraf(loadSpec());
    expect(bundle.id).toBe(ografId(loadSpec()));
    expect(bundle.manifest["main"]).toBe(`${bundle.id}.js`);
    expect(typeof bundle.js).toBe("string");
    expect(bundle.js.length).toBeGreaterThan(1000);
  });

  it("controlToSchema covers all four control types", () => {
    const target = { layerId: "a", param: "x" };
    expect(controlToSchema({ id: "n", label: "N", type: "number", default: 1, target }).type).toBe("number");
    expect(controlToSchema({ id: "c", label: "C", type: "color", default: "#fff", target }).gddType).toBe(
      "color-rrggbb",
    );
    expect(controlToSchema({ id: "t", label: "T", type: "text", default: "x", target }).type).toBe("string");
    expect(controlToSchema({ id: "b", label: "B", type: "bool", default: false, target }).type).toBe("boolean");
  });

  it("keeps goToTime pure: no timers, seeded-free, in the shipped source", () => {
    const js = ografComponentJS(loadSpec());
    for (const banned of ["setTimeout", "setInterval", "requestAnimationFrame", "Math.random", "Date.now"]) {
      expect(js).not.toContain(banned);
    }
  });
});
