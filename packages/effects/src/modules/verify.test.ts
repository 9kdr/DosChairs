/**
 * The browser verify step: a module that looks clean to the SSR probe is
 * re-checked in headless chromium. A shader that fails to compile renders the
 * kit fallback box (rejected with the GL log); a semi-transparent full-frame
 * wash the alpha channel misses is caught by compositing the canvas over
 * black and white. Needs a chromium binary, so the browser assertions skip
 * where there is none (CI); the SSR-clean assertions always run.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkModule, probeImportsPlugin } from "./bundle.js";
import { findChromium, verifyInBrowser } from "./verify.js";

const SCOPE = { wantsBackground: false, wantsText: false };
const SCOPE_BG = { wantsBackground: true, wantsText: false };

function fixture(id: string, frag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chair-verify-test-"));
  const path = join(dir, `${id}.tsx`);
  writeFileSync(
    path,
    `import React from "react";
import { ShaderPass } from "@chair/effects";
export const meta = { id: "${id}", name: "${id}", kind: "overlay",
  durationSec: 2, fps: 30, width: 640, height: 360 };
export const props = {
  hue: { type: "number", min: 0, max: 1, default: 0.5, title: "Hue" },
};
const FRAG = \`${frag}\`;
export default function Effect({ t, hue, width, height }: any) {
  return <ShaderPass frag={FRAG} width={width} height={height} uniforms={{ u_hue: hue, u_time: t }} />;
}
`,
  );
  return path;
}

// Same bug class as the round-4 spark reroll: scalar assigned to a vec2.
const BROKEN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_hue;
void main() {
  vec2 bad = (u_hue - 0.5) * 2.0;
  oColor = vec4(bad, 0.0, 1.0);
}`;

// Unmultiplied orange at alpha 0.03 across the frame: the alpha channel reads
// almost clean, but every browser composites the RGB as a visible veil.
const WASH_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_hue;
void main() {
  oColor = vec4(vec3(1.0, 0.42, 0.0), 0.03);
}`;

// Premultiplied disc on a transparent frame: the asked-for element, nothing else.
const CLEAN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_hue;
void main() {
  float a = 1.0 - smoothstep(0.05, 0.06, length(vUv - 0.5));
  oColor = vec4(vec3(1.0, 0.42, 0.0) * a, a);
}`;

// The zeroed-uniform bug class: the shader compiles and its uniforms upload,
// but it outputs effectively nothing — a blank canvas the SSR probe cannot see.
const BLANK_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_hue;
void main() {
  oColor = vec4(vec3(u_hue / 255.0), 0.0);
}`;

const BROKEN = fixture("bad-shader", BROKEN_FRAG);
const WASH = fixture("wash", WASH_FRAG);
const CLEAN = fixture("clean-disc", CLEAN_FRAG);
const BLANK = fixture("blank", BLANK_FRAG);

describe("browser verification", () => {
  it("SSR sees a clean frame for all four fixtures", async () => {
    for (const entry of [BROKEN, WASH, CLEAN, BLANK]) {
      const report = await checkModule(entry);
      expect(report.errors, entry).toEqual([]);
      expect(report.ok, entry).toBe(true);
    }
  }, 120_000);

  it.runIf(findChromium() !== null)("rejects a module whose shader fails to compile", async () => {
    const report = await checkModule(BROKEN, { scope: SCOPE });
    expect(report.ok).toBe(false);
    expect(report.checks["browserVerified"]).toBe(true);
    const text = report.errors.join(" ");
    expect(text).toContain("failure fallback");
    expect(text).toContain("dimension mismatch");
  }, 120_000);

  it.runIf(findChromium() !== null)("rejects a semi-transparent full-frame wash", async () => {
    const report = await checkModule(WASH, { scope: SCOPE });
    expect(report.ok).toBe(false);
    expect(report.checks["browserVerified"]).toBe(true);
    const coverage = report.checks["paintCoverage"];
    expect(typeof coverage).toBe("number");
    expect(coverage as number).toBeGreaterThan(0.4);
    expect(report.errors.join(" ")).toContain("premultiplied");
  }, 120_000);

  it.runIf(findChromium() !== null)("passes one premultiplied element on transparency", async () => {
    const report = await checkModule(CLEAN, { scope: SCOPE });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    const coverage = report.checks["paintCoverage"];
    expect(typeof coverage).toBe("number");
    expect(coverage as number).toBeLessThan(0.4);
  }, 120_000);

  it.runIf(findChromium() !== null)("rejects a module that paints nothing", async () => {
    const report = await checkModule(BLANK, { scope: SCOPE });
    expect(report.ok).toBe(false);
    expect(report.checks["browserVerified"]).toBe(true);
    expect(report.checks["paintCoverage"]).toBe(0);
    expect(report.errors.join(" ")).toContain("piece painted nothing");
  }, 120_000);

  it.runIf(findChromium() !== null)("switch off paints the asked-for background and passes", async () => {
    const seen = await verifyInBrowser(CLEAN, {
      plugin: probeImportsPlugin(CLEAN),
      scope: SCOPE_BG,
      values: { transparentBg: false },
    });
    expect(seen.skipped).toBe(false);
    // #0e0e10, the standard fill, covering the frame.
    expect((seen.covers ?? []).join(" ")).toContain("14, 14, 16");
    const report = await checkModule(CLEAN, { scope: SCOPE_BG, values: { transparentBg: false } });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);
});
