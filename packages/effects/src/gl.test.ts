import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EffectSpec } from "./types.js";
import {
  coerceUniformValue,
  controlValues,
  paintShader,
  parseHexToVec3,
  shaderUniforms,
} from "./gl.js";

function shaderSpec(): EffectSpec {
  return {
    schemaVersion: "0.1.0",
    id: "liquid-dither",
    name: "Liquid Dither Flow",
    durationSec: 4,
    fps: 30,
    width: 1920,
    height: 1080,
    layers: [{ id: "liquid-bg", type: "shader", params: { entry: "liquidMain" } }],
    controls: [
      {
        id: "color-a",
        label: "Color A",
        type: "color",
        default: "#0A1E8C",
        target: { layerId: "liquid-bg", param: "colorA" },
      },
      {
        id: "dither-size",
        label: "Dither Size",
        type: "number",
        default: 4,
        min: 1,
        max: 8,
        target: { layerId: "liquid-bg", param: "ditherSize" },
      },
    ],
    shader: {
      source: [
        "#version 300 es",
        "precision highp float;",
        "out vec4 fragColor;",
        "uniform vec2 u_resolution;",
        "uniform float u_time;",
        "uniform vec3 u_colorA;",
        "uniform float u_ditherSize;",
        "uniform vec2 u_mouse;",
        "void main(){",
        "  vec2 uv = gl_FragCoord.xy / u_resolution;",
        "  fragColor = vec4(u_colorA * (0.5 + 0.5 * sin(u_time + uv.x * u_ditherSize)), 1.0);",
        "}",
      ].join("\n"),
      uniforms: [
        { name: "u_colorA", controlId: "color-a" },
        { name: "u_ditherSize", controlId: "dither-size" },
      ],
    },
  };
}

/** Record every GL call in order; constants read as numbers, objects as dummies. */
function stubGL(log: string[], failCompile = false): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get(_t, p: string | symbol) {
        if (typeof p === "symbol" || p === "then") return undefined;
        if (p === "canvas") return {};
        if (/^[A-Z][A-Z0-9_]*$/.test(p)) return 1;
        return (...args: unknown[]) => {
          log.push(`${String(p)}(${args.map((a) => JSON.stringify(a)).join(",")})`);
          if (p === "createShader" || p === "createProgram" || p === "createBuffer") return {};
          if (p === "getUniformLocation") return { u: args[1] };
          if (p === "getAttribLocation") return 0;
          if (p === "getShaderParameter" || p === "getProgramParameter") return !failCompile;
          return undefined;
        };
      },
      set(t, p, v) {
        (t as Record<string | symbol, unknown>)[p] = v;
        return true;
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

describe("shader GL pass", () => {
  it("coerces control values to GLSL uniform kinds", () => {
    expect(coerceUniformValue(0.35)).toEqual({ kind: "float", value: 0.35 });
    expect(coerceUniformValue(true)).toEqual({ kind: "float", value: 1 });
    const rgb = coerceUniformValue("#0A1E8C");
    expect(rgb?.kind).toBe("vec3");
    if (rgb?.kind === "vec3") {
      expect(rgb.value[0]).toBeCloseTo(10 / 255, 5);
      expect(rgb.value[2]).toBeCloseTo(140 / 255, 5);
    }
    expect(coerceUniformValue([0.5, 0.5])).toEqual({ kind: "vec2", value: [0.5, 0.5] });
    expect(coerceUniformValue("not-a-value")).toBeNull();
    expect(coerceUniformValue([1])).toBeNull();
    expect(parseHexToVec3("junk")).toBeNull();
  });

  it("fills control defaults and lets overrides win", () => {
    const values = controlValues(shaderSpec(), { "dither-size": 8 });
    expect(values.get("color-a")).toBe("#0A1E8C");
    expect(values.get("dither-size")).toBe(8);
  });

  it("binds shader uniforms and hosts the clock", () => {
    const uniforms = shaderUniforms(shaderSpec(), 1.5, { "dither-size": 6 });
    const byName = new Map(uniforms.map((u) => [u.name, u.value]));
    expect(byName.get("u_colorA")).toEqual({
      kind: "vec3",
      value: [10 / 255, 30 / 255, 140 / 255],
    });
    expect(byName.get("u_ditherSize")).toEqual({ kind: "float", value: 6 });
    expect(byName.get("u_time")).toEqual({ kind: "float", value: 1.5 });
    expect(byName.get("u_resolution")).toEqual({ kind: "vec2", value: [1920, 1080] });
    expect(byName.get("u_mouse")).toEqual({ kind: "vec2", value: [0.5, 0.5] });
    expect(byName.get("u_frame")).toEqual({ kind: "float", value: 45 });
  });

  it("lets an explicit binding own a clock name", () => {
    const spec = shaderSpec();
    spec.shader!.uniforms = [...spec.shader!.uniforms, { name: "u_time", controlId: "dither-size" }];
    const uniforms = shaderUniforms(spec, 1.5);
    expect(uniforms.filter((u) => u.name === "u_time")).toHaveLength(1);
    expect(uniforms.find((u) => u.name === "u_time")?.value).toEqual({
      kind: "float",
      value: 4,
    });
  });

  it("paints deterministically from time", () => {
    const spec = shaderSpec();
    const run = (t: number): string[] => {
      const log: string[] = [];
      expect(paintShader(stubGL(log), spec, t, {})).toBe(true);
      return log;
    };
    const first = run(1.0);
    expect(first.length).toBeGreaterThan(0);
    expect(run(1.0)).toEqual(first);
    const later = run(2.0);
    expect(later).not.toEqual(first);
    // The only intended difference between frames is the clock.
    const clockLines = (log: string[]): string[] => log.filter((l) => l.includes("u_time"));
    expect(clockLines(later)).not.toEqual(clockLines(first));
  });

  it("reports compile failure instead of throwing", () => {
    const log: string[] = [];
    expect(paintShader(stubGL(log, true), shaderSpec(), 1.0, {})).toBe(false);
    expect(paintShader(stubGL(log), { ...shaderSpec(), shader: undefined }, 1.0, {})).toBe(false);
  });

  it("keeps the frame path free of clocks and timers", () => {
    const here = new URL("./", import.meta.url);
    for (const file of ["gl.ts", "spec-view.tsx", "canvas2d.ts"]) {
      const src = readFileSync(new URL(file, here), "utf8");
      for (const banned of [
        "performance.now",
        "Date.now",
        "requestAnimationFrame",
        "setTimeout",
        "setInterval",
        "Math.random",
      ]) {
        expect(src, `${file} must not use ${banned}`).not.toContain(banned);
      }
    }
  });
});
