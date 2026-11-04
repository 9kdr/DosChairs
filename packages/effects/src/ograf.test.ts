import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { resolveFrame } from "./curves.js";
import { drawResolvedLayers, drawShaderFallback, sampleRigTable } from "./canvas2d.js";
import type { Control, EffectSpec } from "./types.js";
import type { RigFrame } from "./types.js";
import { controlToProp, exportOGraf, selectExportTarget } from "./ograf.js";
import { specPayloadFromProps, specRigTarget } from "./spec-view.js";

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

/** Record every Canvas2D call in order; reads return dummies. */
function stubCtx(log: string[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, p: string | symbol) {
        if (p === "canvas") return {};
        if (p === "measureText") return () => ({ width: 10 });
        return (...args: unknown[]) => {
          log.push(`${String(p)}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        };
      },
      set(t, p, v) {
        log.push(`set:${String(p)}=${JSON.stringify(v)}`);
        (t as Record<string | symbol, unknown>)[p] = v;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function sampleRig(): RigFrame[] {
  return [
    { time: 0, x: 100, y: 100, rotation: 0, scaleX: 1, scaleY: 1 },
    { time: 1, x: 300, y: 400, rotation: 0.1, scaleX: 1.1, scaleY: 0.9 },
  ];
}

describe("ograf spec export", () => {
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

  it("maps every control type to a wrapper prop", () => {
    const target = { layerId: "a", param: "x" };
    expect(
      controlToProp({ id: "n", label: "N", type: "number", default: 1, min: 0, max: 2, target }),
    ).toEqual({ id: "n", label: "N", type: "number", default: 1, min: 0, max: 2 });
    expect(controlToProp({ id: "c", label: "C", type: "color", default: "#fff", target }).type).toBe(
      "color",
    );
    expect(controlToProp({ id: "t", label: "T", type: "text", default: "x", target }).type).toBe(
      "text",
    );
    expect(controlToProp({ id: "b", label: "B", type: "bool", default: false, target }).type).toBe(
      "bool",
    );
  });

  it("splits wrapper props into spec, time, and control overrides", () => {
    const spec = loadSpec();
    const payload = specPayloadFromProps({
      spec,
      t: 1.25,
      frame: 37,
      data: { spec },
      "ball-color": "#00ff00",
      junk: ["not", "a", "control"],
    });
    expect(payload?.t).toBe(1.25);
    expect(payload?.spec.id).toBe(spec.id);
    expect(payload?.controls).toEqual({ "ball-color": "#00ff00" });
    expect(specPayloadFromProps({ t: 1 })).toBeNull();
  });

  it("binds the rig to the topmost layer without animated x/y", () => {
    // bounce-title: bg static, ball animated, title static -> title wins.
    expect(specRigTarget(loadSpec())).toBe("title");
    expect(specRigTarget({ ...loadSpec(), rig: undefined })).toBeNull();
  });

  it("paints deterministically from resolved layers", () => {
    const spec = loadSpec();
    const layers = resolveFrame(spec, 1.2, {});
    const run = (): string[] => {
      const log: string[] = [];
      drawResolvedLayers(stubCtx(log), spec.width, spec.height, layers, {
        width: spec.width,
        height: spec.height,
        rigTable: sampleRig(),
        rigTarget: "title",
        t: 1.2,
      });
      return log;
    };
    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(run()).toEqual(first);
    const moved = resolveFrame(spec, 2.0, {});
    const log: string[] = [];
    drawResolvedLayers(stubCtx(log), spec.width, spec.height, moved, {
      width: spec.width,
      height: spec.height,
      t: 2.0,
    });
    expect(log).not.toEqual(first);
  });

  it("falls back to a labelled box for shader layers", () => {
    const log: string[] = [];
    drawShaderFallback(stubCtx(log), 1920, 1080, 2);
    expect(log.join("\n")).toContain("WebGL2 unavailable");
  });

  it("samples the rig table at or before t", () => {
    const table = sampleRig();
    expect(sampleRigTable(table, 0)?.x).toBe(100);
    expect(sampleRigTable(table, 0.5)?.x).toBe(100);
    expect(sampleRigTable(table, 5)?.x).toBe(300);
    expect(sampleRigTable(null, 1)).toBeNull();
  });

  it("bundles the spec through the wrapper with a valid manifest", async () => {
    const bundle = await exportOGraf(loadSpec());
    expect(bundle.id).toContain("bounce-title");
    expect(bundle.manifest["main"]).toBe(`${bundle.id}.js`);
    const schema = bundle.manifest["schema"] as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["ball-color", "title-text"]);
    // The bundle re-renders synchronously from time.
    expect(bundle.js).toContain("goToTime");
    expect(bundle.js).toContain("flushSync");
    const ajv = ografAjv();
    const validate = ajv.getSchema(
      "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
    );
    expect(validate).toBeDefined();
    expect(validate!(bundle.manifest)).toBe(true);
  }, 120000);

  it("emits the same manifest twice for the same spec", async () => {
    const first = await exportOGraf(loadSpec());
    const second = await exportOGraf(loadSpec());
    expect(second.manifest).toEqual(first.manifest);
  }, 120000);
});
