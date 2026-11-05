/**
 * The PNG-sequence bake: a module's OGraf bundle driven frame-by-frame
 * through goToTime and screenshotted with alpha. Browser assertions skip
 * where there is no chromium (CI); the pure helpers always run.
 */
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { debugTarget, pngSize, renderFrames } from "./render.js";
import { findChromium } from "./verify.js";

const DISC_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oColor;
uniform float u_hue;
void main() {
  float a = 1.0 - smoothstep(0.05, 0.06, length(vUv - 0.5));
  oColor = vec4(vec3(1.0, 0.42, 0.0) * a, a);
}`;

function fixture(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chair-render-test-"));
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
const FRAG = \`${DISC_FRAG}\`;
export default function Effect({ t, hue, width, height }: any) {
  return <ShaderPass frag={FRAG} width={width} height={height} uniforms={{ u_hue: hue, u_time: t }} />;
}
`,
  );
  return path;
}

describe("pngSize", () => {
  it("reads dimensions out of a PNG header", () => {
    const head = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      (() => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(13);
        return len;
      })(),
      Buffer.from("IHDR", "ascii"),
      (() => {
        const dims = Buffer.alloc(8);
        dims.writeUInt32BE(480, 0);
        dims.writeUInt32BE(270, 4);
        return dims;
      })(),
    ]);
    expect(pngSize(head)).toEqual({ width: 480, height: 270 });
    expect(pngSize(Buffer.from("not a png"))).toBeNull();
  });
});

describe("findChromium ordering (the bake needs full chromium: the shell rejects remote debugging)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers full chromium over the headless shell", () => {
    const cache = mkdtempSync(join(tmpdir(), "chair-browsers-"));
    const full = join(cache, "chromium-999", "chrome-linux64", "chrome");
    const shell = join(cache, "chromium_headless_shell-1", "chrome-headless-shell-linux64", "chrome-headless-shell");
    mkdirSync(join(cache, "chromium-999", "chrome-linux64"), { recursive: true });
    mkdirSync(join(cache, "chromium_headless_shell-1", "chrome-headless-shell-linux64"), { recursive: true });
    writeFileSync(full, "x");
    writeFileSync(shell, "x");
    chmodSync(full, 0o755);
    chmodSync(shell, 0o755);
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
    vi.stubEnv("CHAIR_CHROMIUM", "");
    expect(findChromium()).toBe(full);
  });

  it("honors CHAIR_CHROMIUM first", () => {
    const dir = mkdtempSync(join(tmpdir(), "chair-chromium-env-"));
    const custom = join(dir, "my-chrome");
    writeFileSync(custom, "x");
    chmodSync(custom, 0o755);
    vi.stubEnv("CHAIR_CHROMIUM", custom);
    expect(findChromium()).toBe(custom);
  });
});

describe("renderFrames", () => {
  it("refuses bad geometry without launching a browser", async () => {
    await expect(renderFrames(fixture("geo"), {
      width: 0, height: 270, fps: 10, durationSec: 0.2, outDir: tmpdir(),
    })).rejects.toThrow("positive integer width");
  });

  it.runIf(findChromium() !== null)("bakes two identical frames of a static disc", async () => {
    // 480 wide: headless never ticks rAF in a narrower window. Two workers
    // to cover the parallel path: one frame each.
    const outDir = mkdtempSync(join(tmpdir(), "chair-bake-test-"));
    const outcome = await renderFrames(fixture("disc"), {
      width: 480, height: 270, fps: 10, durationSec: 0.2, outDir, jobs: 2,
    });
    expect(outcome.frames).toBe(2);
    expect(outcome.files).toHaveLength(2);
    const [first, second] = outcome.files.map((f) => readFileSync(f));
    for (const png of [first, second]) {
      expect(png!.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(pngSize(png!)).toEqual({ width: 480, height: 270 });
      // A blank transparent frame is ~1KB; the disc paints more.
      expect(png!.length).toBeGreaterThan(2000);
    }
    // Same pixels, same bytes: the bake is deterministic per frame.
    expect(first!.equals(second!)).toBe(true);
  }, 180_000);
});

describe("debugTarget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says the endpoint never answered when nothing listens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );

    await expect(debugTarget(9222)).rejects.toThrow("debugger endpoint never answered");
  }, 60_000);

  it("says the endpoint answered when it lists no page target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify([{ type: "browser", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/1" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await expect(debugTarget(9222)).rejects.toThrow("answered but never listed a page target");
  }, 60_000);
});

