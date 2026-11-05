/**
 * Bake a module to a PNG sequence: the same OGraf bundle Resolve would load,
 * driven frame-by-frame through goToTime in headless chromium and screenshotted
 * with alpha. Powers the Linux auto-bake (issue #308): Resolve on Linux never
 * loads OGraf titles, so the agent renders the frames here and applies them
 * through the Fusion Loader path instead.
 *
 * Same seek contract as the quality check (probe.ts) and the OGraf host
 * (wrap.ts): every frame is a pure function of (props, t), sought in any
 * order. Chromium flags match the module checker (SwiftShader WebGL2 and
 * WebGPU), so shaders.com modules bake the way they verify.
 *
 * Needs a chromium binary (CHAIR_CHROMIUM, the Playwright cache, or PATH).
 * Without one renderFrames throws, and the agent answers 503.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleModule } from "./bundle.js";
import { findChromium } from "./verify.js";

export interface RenderOptions {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Inspector baseline props (static overrides on top of the defaults). */
  props?: Record<string, unknown> | undefined;
  /** Baked keyframe table {prop: [[sec, value], ...]} for animated props. */
  keyframes?: Record<string, [number, unknown][]> | undefined;
  outDir: string;
  chromium?: string | undefined;
  /** Parallel pages splitting the frames; frames are pure in t. Default 4. */
  jobs?: number | undefined;
}

export interface RenderOutcome {
  files: string[];
  frames: number;
  width: number;
  height: number;
  /** Wall time of the whole bake in ms. */
  ms: number;
  /** Which renderer painted the frames. */
  renderer: "gpu" | "swiftshader";
}

const ENDPOINT_RETRIES = 150;


const FRAME_SETTLE = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))";
/** Nudge dead WebGL contexts free: some modules rebuild the GL renderer per seek. */
const GC_EVERY_FRAMES = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Width/height straight out of the PNG IHDR: no image lib needed. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) {
    return null;
  }
  if (png.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function harnessPage(width: number, height: number, props: Record<string, unknown>): string {
  const baseline = JSON.stringify(props);
  return `<!doctype html><meta charset="utf-8"><title>bake</title>
<style>html,body{margin:0;background:transparent}#stage{position:relative;overflow:hidden;width:${width}px;height:${height}px}</style>
<div id="stage"></div>
<script type="module">
// Kept GL buffers survive until the screenshot reads them; without this a
// preserve=false canvas (OGL's default) composites blank on GPU captures.
// Same pixels, only retained. Module code is untouched.
const __chairGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, attrs) {
  if ((type === "webgl" || type === "webgl2" || type === "experimental-webgl") &&
      (attrs === undefined || (typeof attrs === "object" && attrs !== null))) {
    return __chairGetContext.call(this, type, { ...attrs, preserveDrawingBuffer: true });
  }
  return __chairGetContext.call(this, type, attrs);
};
import Title from "./title.js";
customElements.define("chair-bake-title", Title);
const el = document.createElement("chair-bake-title");
el.style.cssText = "position:absolute;left:0;top:0;width:${width}px;height:${height}px;display:block;";
document.getElementById("stage").appendChild(el);
await el.load({ data: ${baseline} });
window.__chair = { seek: (ms) => el.goToTime({ timestamp: ms }) };
document.title = "ready";
</script>
`;
}

class Cdp {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    const failAll = (why: string): void => {
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(`bake: debugger socket ${why}`));
      }
      this.pending.clear();
    };
    ws.onclose = () => failAll("closed");
    ws.onerror = () => failAll("errored");
    ws.onmessage = (event: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isRecord(msg) || typeof msg["id"] !== "number") return;
      const waiter = this.pending.get(msg["id"]);
      if (!waiter) return;
      this.pending.delete(msg["id"]);
      if (msg["error"] !== undefined) waiter.reject(new Error(`CDP error: ${JSON.stringify(msg["error"])}`));
      else waiter.resolve(isRecord(msg["result"]) ? msg["result"] : {});
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("bake: could not open the debugger socket"));
    });
    return new Cdp(ws);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bake: CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

const DEBUG = process.env["CHAIR_BAKE_DEBUG"] === "1";

function log(phase: string): void {
  if (DEBUG) process.stderr.write(`[bake] ${phase}\n`);
}

export async function debugTarget(port: number): Promise<string> {
  let answered = false;
  for (let i = 0; i < ENDPOINT_RETRIES; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      answered = true;
      const tabs = (await res.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
      const page = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      if (i % 20 === 0) log(`debug endpoint up, ${tabs.length} targets`);
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    answered
      ? "bake: chromium's debugger endpoint answered but never listed a page target"
      : "bake: chromium's debugger endpoint never answered",
  );
}

/** True when chromium drives a real GPU (not SwiftShader software GL). */
async function hasRealGpu(cdp: Cdp): Promise<boolean> {
  try {
    // Browser target only. Device strings come back empty; glRenderer names
    // the driver: "ANGLE (NVIDIA, ...)" on hardware, SwiftShader in software.
    const info = await cdp.send("SystemInfo.getInfo", {}, 15_000);
    const gpu = isRecord(info["gpu"]) ? info["gpu"] : null;
    const aux = gpu && isRecord(gpu["auxAttributes"]) ? gpu["auxAttributes"] : null;
    const renderer = aux && typeof aux["glRenderer"] === "string" ? aux["glRenderer"] : "";
    return renderer !== "" && !/swiftshader/i.test(renderer);
  } catch {
    return false;
  }
}

async function browserEndpoint(port: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      const info = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("bake: chromium's browser endpoint never came up");
}

/** Render every frame of the module to outDir/frame-000001.png, ... */
export async function renderFrames(entry: string, opts: RenderOptions): Promise<RenderOutcome> {
  const { width, height, fps } = opts;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("bake needs positive integer width and height");
  }
  if (!(fps > 0) || !(opts.durationSec > 0)) {
    throw new Error("bake needs positive fps and durationSec");
  }
  const chromium = opts.chromium ?? findChromium();
  if (!chromium) {
    throw new Error("bake needs a chromium binary (set CHAIR_CHROMIUM)");
  }
  const frames = Math.max(1, Math.round(opts.durationSec * fps));
  const started = Date.now();

  const built = await bundleModule(entry, {
    data: opts.keyframes ? { keyframes: opts.keyframes } : undefined,
  });
  if (!built.bundle) {
    throw new Error(`bake: module failed the check: ${built.report.errors.slice(0, 6).join("; ")}`);
  }
  const page = harnessPage(width, height, opts.props ?? {});
  const titleJs = built.bundle.js;
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/title.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(titleJs);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const freePort = async (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.on("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const found = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(found));
      });
    });
  await mkdir(opts.outDir, { recursive: true });
  // Headless never ticks requestAnimationFrame in a window narrower than
  // ~500px, which would wedge the per-frame settle below; the metrics
  // override still screenshots at exactly width x height.
  const winWidth = Math.max(width, 500);
  const winHeight = Math.max(height, 500);

  const jobs = Math.max(1, Math.min(opts.jobs ?? 4, frames));

  // One browser per worker: several GL pages in one GPU process crash it,
  // while one page per process renders in parallel without sharing.
  // Throwaway profiles and ports per worker (a shared profile dir wedges
  // concurrent chromiums; other agents bake on this same machine).
  const workers: { debugPort: number; profileDir: string }[] = [];
  for (let w = 0; w < jobs; w++) {
    workers.push({
      debugPort: await freePort(),
      profileDir: await mkdtemp(join(tmpdir(), "chair-bake-profile-")),
    });
  }

  const makeArgs = (software: boolean, worker: { debugPort: number; profileDir: string }): string[] => [
    // GPU first (fast GL/WebGPU on real hardware), SwiftShader fallback:
    // the GPU set drives ANGLE over native Vulkan, the software set pins
    // ANGLE and Vulkan to SwiftShader. --in-process-gpu: the out-of-process
    // GPU hits external-memory OOMs and blank canvas readback here.
    // No --disable-gpu: it also disables the WebGPU adapter.
    // No --default-background-color: on this Chrome it stops the page
    // target from ever appearing; the transparent background arrives over
    // CDP instead (see below).
    ...(software
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-vulkan=swiftshader"]
      : ["--enable-gpu", "--use-angle=vulkan", "--in-process-gpu"]),
    "--headless", "--no-sandbox", "--disable-dev-shm-usage",
    "--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-webgl",
    "--enable-features=Vulkan",
    "--hide-scrollbars", "--force-device-scale-factor=1", "--mute-audio",
    `--window-size=${winWidth},${winHeight}`,
    `--user-data-dir=${worker.profileDir}`,
    `--remote-debugging-port=${worker.debugPort}`, "--remote-allow-origins=*",
    "about:blank",
  ];

  let childErr = "";
  const children: ChildProcess[] = [];
  const launch = (software: boolean): void => {
    for (const worker of workers) {
      const child = spawn(chromium, makeArgs(software, worker), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.stderr?.on("data", (d: Buffer) => {
        childErr = `${childErr}${d.toString()}`.slice(-2000);
        if (DEBUG) process.stderr.write(`[chromium] ${d.toString()}`);
      });
    }
  };
  const stopAll = async (): Promise<void> => {
    const dying = children.splice(0);
    for (const child of dying) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Wait for the killed browsers to actually exit (short cap): a
    // relaunch on the same port or profile dir while the old process
    // still holds them aborts the new chromium (exit 21, SingletonLock),
    // leaving nobody on the debug port.
    await Promise.all(
      dying.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 5000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      ),
    );
  };
  const cleanProfiles = async (dirs: string[]): Promise<void> => {
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }),
    );
  };

  const setupPage = async (cdp: Cdp): Promise<void> => {
    await cdp.send("Page.enable");
    await cdp.send("HeapProfiler.enable");
    // Exact viewport and a transparent default background: screenshots
    // come back at exactly width x height with a real alpha channel.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; i < 300; i++) {
      const state = await cdp.send(
        "Runtime.evaluate",
        { expression: "document.title", returnByValue: true },
        10_000,
      );
      const title = isRecord(state["result"]) ? state["result"]["value"] : null;
      if (title === "ready") return;
      if (i === 299) throw new Error("bake: the harness page never became ready");
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  let doneCount = 0;
  const bakeShard = async (cdp: Cdp, from: number, to: number): Promise<string[]> => {
    const mine: string[] = [];
    for (let i = from; i < to; i++) {
      const t = i / fps;
      const mark = Date.now();
      await cdp.send("Runtime.evaluate", {
        expression: `__chair.seek(${(t * 1000).toFixed(3)})`,
        awaitPromise: true,
      });
      const sought = Date.now();
      // Layout effects repaint synchronously inside the seek; two frames
      // let compositing catch up before the screenshot.
      await cdp.send("Runtime.evaluate", { expression: FRAME_SETTLE, awaitPromise: true });
      const settled = Date.now();
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      if (DEBUG && (i - from < 2 || i === to - 1)) {
        log(`frame ${i}: seek ${sought - mark}ms settle ${settled - sought}ms shot ${Date.now() - settled}ms`);
      }
      if (typeof shot["data"] !== "string") {
        throw new Error(`bake: frame ${i} came back without pixels`);
      }
      const png = Buffer.from(shot["data"], "base64");
      if (i === 0) {
        const size = pngSize(png);
        if (!size || size.width !== width || size.height !== height) {
          throw new Error(
            `bake: screenshot is ${size ? `${size.width}x${size.height}` : "not a PNG"}, wanted ${width}x${height}`,
          );
        }
      }
      const name = `frame-${String(i + 1).padStart(6, "0")}.png`;
      await writeFile(join(opts.outDir, name), png);
      mine.push(join(opts.outDir, name));
      doneCount += 1;
      if (mine.length % GC_EVERY_FRAMES === 0) {
        await cdp.send("HeapProfiler.collectGarbage").catch(() => ({}));
      }
    }
    return mine;
  };

  const pages: Cdp[] = [];
  let renderer: "gpu" | "swiftshader" = "gpu";
  const connectAll = (): Promise<Cdp[]> =>
    Promise.all(
      workers.map((worker) => debugTarget(worker.debugPort).then((url) => Cdp.connect(url))),
    );
  try {
    log(`bundled, launching ${jobs} chromium worker(s)`);
    launch(false);
    let connected = await connectAll();
    const detect = async (): Promise<boolean> => {
      const browser = await browserEndpoint(workers[0]!.debugPort).then((url) => Cdp.connect(url));
      try {
        return await hasRealGpu(browser);
      } finally {
        browser.close();
      }
    };
    if (!(await detect())) {
      log("no GPU adapter; relaunching on SwiftShader");
      for (const page of connected) page.close();
      await stopAll();
      childErr = "";
      // Fresh ports and profiles for the software launch: even waited-on,
      // a dying chromium can still hold the old ones briefly.
      const oldDirs = workers.map((worker) => worker.profileDir);
      for (const worker of workers) {
        worker.debugPort = await freePort();
        worker.profileDir = await mkdtemp(join(tmpdir(), "chair-bake-profile-"));
      }
      await cleanProfiles(oldDirs);
      launch(true);
      connected = await connectAll();
      renderer = "swiftshader";
    } else {
      log("GPU adapter present");
    }
    pages.push(...connected);
    await Promise.all(pages.map((page) => setupPage(page)));
    log(`harness ready on ${pages.length} worker(s)`);
    const chunk = Math.ceil(frames / jobs);
    const shards = await Promise.all(
      pages.map((page, w) => bakeShard(page, w * chunk, Math.min((w + 1) * chunk, frames))),
    );
    const files = shards.flat();
    return { files, frames, width, height, ms: Date.now() - started, renderer };
  } catch (error) {
    const tail = childErr.trim().split("\n").slice(-3).join(" | ");
    throw new Error(
      `bake failed after ${doneCount}/${frames} frames: ${error instanceof Error ? error.message : String(error)}${tail ? ` (chromium: ${tail})` : ""}`,
    );
  } finally {
    for (const page of pages) page.close();
    await stopAll();
    server.close();
    // Let the killed browsers exit before removing their profiles, else
    // rmdir races their last writes (ENOTEMPTY).
    await new Promise((r) => setTimeout(r, 1500));
    await cleanProfiles(workers.map((worker) => worker.profileDir));
  }
}
