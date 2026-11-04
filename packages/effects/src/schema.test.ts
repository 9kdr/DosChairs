import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { EffectSpec } from "./types.js";

const schemaUrl = new URL("../../../schemas/effect-spec.schema.json", import.meta.url);
const fixtureUrl = new URL("../../../fixtures/effects/bounce-title.effect.json", import.meta.url);

describe("effect-spec schema", () => {
  it("accepts the sample bounce-title spec", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
    const spec = JSON.parse(readFileSync(fixtureUrl, "utf8")) as EffectSpec;
    const validate = ajv.compile(schema);
    expect(validate.errors ?? []).toEqual([]);
    expect(validate(spec)).toBe(true);
    expect(spec.layers.length).toBeGreaterThan(0);
  });

  it("rejects a spec with no layers", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
    const spec = JSON.parse(readFileSync(fixtureUrl, "utf8"));
    spec.layers = [];
    expect(ajv.compile(schema)(spec)).toBe(false);
  });
});
