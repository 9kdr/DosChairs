/**
 * Browser verification: re-checks the scope rules against a real rendered
 * frame. The SSR probe (probe.ts) never runs layout effects, so it cannot see
 * a ShaderPass compile failure (client-only fallback box) or canvas paint (a
 * semi-transparent wash over the whole frame). This step mounts the module in
 * headless chromium, seeks to the same mid frame, and reports the live DOM
 * text, live opaque fills, and canvas alpha coverage back into the check.
 *
 * Needs a chromium binary (CHAIR_CHROMIUM, the Playwright cache, or PATH).
 * Without one it reports `skipped`, and the check keeps the SSR verdict with
 * a warning — CI has no browser, so it stays green and enforcement happens
 * where modules are generated.
 */
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { effectsPackageDir } from "./catalogue.js";

export interface BrowserScope {
  wantsBackground: boolean;
  wantsText: boolean;
}

export interface VerifyOutcome {
  skipped: boolean;
  reason?: string;
  text?: string;
  covers?: string[];
  shaderFailed?: boolean;
  shaderLog?: string | null;
  /**
   * Fraction of sampled pixels visibly painted when the biggest canvas is
   * composited over black and over white (max channel deviation above
   * 10/255 from the backing counts). Composite-aware, so unmultiplied color
   * leaking from transparent areas counts; null when there is no canvas or
   * its buffer cannot be read.
   */
  paintCoverage?: number | null;
}

const VERIFY_TIMEOUT_MS = 60_000;

/** Locate a chromium binary, or null when there is no browser on this machine. */
export function findChromium(): string | null {
  const found = (p: string): string | null => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile() ? p : null;
    } catch {
      return null;
    }
  };
  const fromEnv = (process.env["CHAIR_CHROMIUM"] ?? "").trim();
  if (fromEnv && found(fromEnv)) return fromEnv;
  const cache =
    process.env["PLAYWRIGHT_BROWSERS_PATH"]?.trim() ||
    join(process.env["HOME"] ?? "", ".cache", "ms-playwright");
  try {
    for (const name of readdirSync(cache)) {
      if (name.startsWith("chromium-")) {
        const hit = found(join(cache, name, "chrome-linux", "chrome"));
        if (hit) return hit;
      } else if (name.startsWith("chromium_headless_shell-")) {
        const hit = found(join(cache, name, "chrome-headless-shell-linux64", "chrome-headless-shell"));
        if (hit) return hit;
      }
    }
  } catch {
    /* no cache dir */
  }
  for (const bin of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const out = spawnSync("which", [bin], { encoding: "utf8" }).stdout.trim().split("\n")[0]?.trim();
      if (out && found(out)) return out;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

const MOUNT_SOURCE = `import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import * as Mod from "chair-module-under-test";

const meta = (Mod.meta ?? {});
const props = (Mod.props ?? {});
const Effect = Mod.default;
const dur = typeof meta.durationSec === "number" && meta.durationSec > 0 ? meta.durationSec : 5;
const fps = typeof meta.fps === "number" && meta.fps > 0 ? meta.fps : 30;
const width = typeof meta.width === "number" ? meta.width : 1920;
const height = typeof meta.height === "number" ? meta.height : 1080;
const t = dur * 0.5;
const defaults = {};
for (const id of Object.keys(props)) defaults[id] = props[id].default;
const history = (name) => defaults[name];
const stage = document.getElementById("stage");
stage.style.width = width + "px";
stage.style.height = height + "px";

function collapse(s) { return String(s).replace(/\\s+/g, " ").trim().slice(0, 200); }

function measure() {
  const facts = { text: "", covers: [], shaderFailed: false, shaderLog: null, paintCoverage: null };
  try {
    facts.text = collapse(stage.innerText ?? stage.textContent ?? "");
    const failed = stage.querySelector("[data-shader-failed]");
    if (failed) {
      facts.shaderFailed = true;
      facts.shaderLog = failed.getAttribute("data-shader-log");
    }
    const area = width * height;
    for (const el of stage.querySelectorAll("*")) {
      if (facts.covers.length >= 5) break;
      const bg = getComputedStyle(el).backgroundColor || "";
      const m = bg.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?\\s*\\)/);
      if (!m || (m[4] !== undefined && parseFloat(m[4]) < 1)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= area * 0.95) {
        facts.covers.push(el.tagName.toLowerCase() + " covers the frame (background: " + bg.slice(0, 80) + ")");
      }
    }
    let biggest = null;
    let biggestArea = 0;
    for (const c of stage.querySelectorAll("canvas")) {
      const a = (c.width || 0) * (c.height || 0);
      if (a > biggestArea) { biggestArea = a; biggest = c; }
    }
    if (biggest && biggestArea > 0) {
      const small = document.createElement("canvas");
      small.width = 192; small.height = 108;
      const ctx = small.getContext("2d", { willReadFrequently: true });
      const n = small.width * small.height;
      const worst = new Array(n).fill(0);
      for (const fill of ["#000000", "#ffffff"]) {
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = fill; ctx.fillRect(0, 0, small.width, small.height);
        ctx.drawImage(biggest, 0, 0, small.width, small.height);
        const data = ctx.getImageData(0, 0, small.width, small.height).data;
        const base = fill === "#000000" ? 0 : 255;
        for (let p = 0; p < n; p++) {
          let dev = 0;
          for (let k = 0; k < 3; k++) {
            const d = Math.abs(data[p * 4 + k] - base);
            if (d > dev) dev = d;
          }
          if (dev > worst[p]) worst[p] = dev;
        }
      }
      let hit = 0;
      for (let p = 0; p < n; p++) if (worst[p] > 10) hit++;
      facts.paintCoverage = Math.round((hit / n) * 1000) / 1000;
    }
  } catch (err) {
    facts.text = "verify measure crashed: " + String((err && err.message) || err);
  }
  document.getElementById("result").textContent = JSON.stringify(facts);
  document.title = "ready";
}

try {
  if (typeof Effect !== "function") throw new Error("no default Effect export");
  // Commit synchronously so the facts are written in the same task: a dump
  // taken the moment the page loads must already see a result, never an
  // empty tag racing the next animation frame.
  const root = createRoot(stage);
  flushSync(() => {
    root.render(
      React.createElement(Effect, { ...defaults, t, frame: Math.round(t * fps), fps, width, height, history }),
    );
  });
  measure();
  // Late painters (passive effects) refine the facts when frames run.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { measure(); } catch { /* keep the synchronous facts */ }
  }));
} catch (err) {
  document.getElementById("result").textContent = JSON.stringify({
    text: "verify mount crashed: " + String((err && err.message) || err),
    covers: [], shaderFailed: false, shaderLog: null, paintCoverage: null,
  });
  document.title = "ready";
}
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>verify</title>
<style>html,body{margin:0;background:#000}#stage{position:relative;overflow:hidden}</style>
<div id="stage"></div><pre id="result"></pre>
<script type="module" src="./mount.js"></script>
`;

/** Mount the module in headless chromium and read back live scope facts. */
export async function verifyInBrowser(
  entry: string,
  opts: { plugin: Plugin; scope: BrowserScope; chromium?: string },
): Promise<VerifyOutcome> {
  const chromium = opts.chromium ?? findChromium();
  if (!chromium) {
    return { skipped: true, reason: "no chromium binary (set CHAIR_CHROMIUM)" };
  }
  const dir = await mkdtemp(join(tmpdir(), "chair-verify-"));
  await writeFile(join(dir, "mount.tsx"), MOUNT_SOURCE, "utf8");
  const server = createServer(async (req, res) => {
    try {
      if ((req.url ?? "/").split("?")[0] === "/mount.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(await readFile(join(dir, "mount.js"), "utf8"));
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
      }
    } catch {
      res.writeHead(500);
      res.end("verify harness error");
    }
  });
  try {
    await build({
      entryPoints: [join(dir, "mount.tsx")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["chrome120"],
      jsx: "automatic",
      outfile: join(dir, "mount.js"),
      write: true,
      nodePaths: [join(effectsPackageDir(), "node_modules")],
      plugins: [opts.plugin],
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    }).catch((error: unknown) => {
      throw new Error(
        `browser verify could not bundle the module: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        chromium,
        [
          "--headless", "--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader",
          "--virtual-time-budget=15000", "--timeout=45000", "--dump-dom",
          `http://127.0.0.1:${port}/`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let text = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("browser verification timed out after 60s (render loop?)"));
      }, VERIFY_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => (text += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`browser verification could not start chromium: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (text.includes('id="result"')) resolve(text);
        else reject(new Error(`browser verification crashed (exit ${code}): ${err.trim().split("\n").slice(0, 3).join(" | ")}`));
      });
    });
    const match = stdout.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/);
    if (!match) {
      const head = stdout.replace(/\s+/g, " ").trim().slice(0, 300);
      throw new Error(`browser verification found no result in the page (dump head: ${head || "(empty)"})`);
    }
    const facts = JSON.parse(match[1] ?? "{}") as {
      text?: string; covers?: string[]; shaderFailed?: boolean; shaderLog?: string | null; paintCoverage?: number | null;
    };
    return {
      skipped: false,
      text: typeof facts.text === "string" ? facts.text : "",
      covers: Array.isArray(facts.covers) ? facts.covers.map(String) : [],
      shaderFailed: facts.shaderFailed === true,
      shaderLog: typeof facts.shaderLog === "string" ? facts.shaderLog : null,
      paintCoverage: typeof facts.paintCoverage === "number" ? facts.paintCoverage : null,
    };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
