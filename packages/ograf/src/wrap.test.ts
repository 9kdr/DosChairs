import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { manifestForOgarf } from "./manifest.js";
import { normalizeHexColor, propDefaults, propToSchema } from "./props.js";
import type { OgrafProp } from "./props.js";
import { wrapCustomElement, wrapReactComponent } from "./wrap.js";

const ografDir = new URL("../../../fixtures/ograf/", import.meta.url);

function ebuValidator(): (data: unknown) => boolean {
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
  const validate = ajv.getSchema(
    "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
  );
  if (!validate) throw new Error("vendored EBU schema did not register");
  return validate;
}

const PROPS: OgrafProp[] = [
  { id: "size", label: "Size", type: "number", default: 1.5, min: 0.5, max: 3 },
  { id: "tint", label: "Tint", type: "color", default: "#FFB000" },
  { id: "caption", label: "Caption", type: "text", default: "hi" },
  { id: "badge", label: "Badge", type: "bool", default: true },
];

describe("ograf wrapper", () => {
  it("maps every prop type to an Inspector control", () => {
    expect(propToSchema(PROPS[0]!)).toMatchObject({
      type: "number",
      minimum: 0.5,
      maximum: 3,
      default: 1.5,
    });
    expect(propToSchema(PROPS[1]!)).toMatchObject({
      type: "string",
      gddType: "color-rrggbb",
      pattern: "^#[0-9a-f]{6}$",
      default: "#ffb000",
    });
    expect(propToSchema(PROPS[2]!)).toMatchObject({ type: "string", default: "hi" });
    expect(propToSchema(PROPS[3]!)).toMatchObject({ type: "boolean", default: true });
  });

  it("normalizes colors to lowercase #rrggbb", () => {
    expect(normalizeHexColor("#FFB000")).toBe("#ffb000");
    expect(normalizeHexColor("junk")).toBe("#ffffff");
    expect(propDefaults([{ id: "c", label: "C", type: "color", default: "#ABC" }])).toEqual({
      c: "#aabbcc",
    });
  });

  it("emits the Resolve-required manifest fields and validates", () => {
    const manifest = manifestForOgarf({
      id: "Hello World!",
      name: "Hello",
      durationSec: 5,
      fps: 30,
      width: 1920,
      height: 1080,
      props: PROPS,
    });
    expect(manifest["id"]).toBe("chair-hello-world");
    expect(manifest["main"]).toBe("chair-hello-world.js");
    expect(manifest["supportsRealTime"]).toBe(false);
    expect(manifest["supportsNonRealTime"]).toBe(true);
    expect(manifest["stepCount"]).toBe(1);
    expect((manifest["v_bmd"] as { duration: number }).duration).toBe(5);
    expect(ebuValidator()(manifest)).toBe(true);
  });

  it("caps Inspector props at the Fusion limit of 20", () => {
    const many: OgrafProp[] = Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      label: `P${i}`,
      type: "number" as const,
      default: i,
    }));
    const manifest = manifestForOgarf({ id: "x", name: "X", durationSec: 1, props: many });
    const schema = manifest["schema"] as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toHaveLength(20);
  });

  it("bundles a ready-made web component unchanged", async () => {
    const bundle = await wrapCustomElement({
      id: "ready",
      name: "Ready",
      durationSec: 4,
      entry: new URL("./fixtures/ready-element.ts", import.meta.url).pathname,
      props: PROPS.slice(0, 1),
    });
    expect(bundle.id).toBe("chair-ready");
    expect(bundle.manifest["main"]).toBe("chair-ready.js");
    for (const method of ["goToTime", "setActionsSchedule", "updateAction"]) {
      expect(bundle.js).toContain(method);
    }
    expect(ebuValidator()(bundle.manifest)).toBe(true);
  }, 60000);

  it("refuses a component missing OGraf methods", async () => {
    await expect(
      wrapCustomElement({
        id: "broken",
        name: "Broken",
        durationSec: 4,
        entry: new URL("./fixtures/broken-element.ts", import.meta.url).pathname,
      }),
    ).rejects.toThrow(/goToTime/);
  }, 60000);

  it("bundles a React component with time-as-prop rendering", async () => {
    const bundle = await wrapReactComponent({
      id: "hello",
      name: "Hello",
      durationSec: 5,
      fps: 30,
      entry: new URL("./fixtures/hello.tsx", import.meta.url).pathname,
      props: [{ id: "name", label: "Name", type: "text", default: "world" }],
      data: { greeting: "hi" },
    });
    expect(bundle.id).toBe("chair-hello");
    expect(bundle.manifest["main"]).toBe("chair-hello.js");
    // The host re-renders synchronously from goToTime.
    expect(bundle.js).toContain("goToTime");
    expect(bundle.js).toContain("flushSync");
    expect(bundle.js).toContain("Hello");
    const schema = bundle.manifest["schema"] as { properties: Record<string, unknown> };
    expect(schema.properties["name"]).toMatchObject({ type: "string", default: "world" });
    expect(ebuValidator()(bundle.manifest)).toBe(true);
  }, 120000);
});
