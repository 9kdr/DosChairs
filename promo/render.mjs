// One-command render: node render.mjs [--fps 30] [--workers 8] [--from s --to s]
// Seeks index.html frame by frame in headless Chromium, pipes JPEGs to ffmpeg.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const fps = +arg("fps", 30), workers = +arg("workers", 8);
const here = resolve(import.meta.dirname), out = join(here, "out");
mkdirSync(out, { recursive: true });
const pw = join(homedir(), ".cache/ms-playwright");
const exe = process.env.CHROMIUM || [...readdirSync(pw).filter((d) => d.startsWith("chromium-")).map((d) => join(pw, d, "chrome-linux64/chrome"))].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--force-color-profile=srgb"] });
const url = "file://" + join(here, "index.html");
const probe = await browser.newPage();
await probe.goto(url);
const dur = await probe.evaluate(() => window.__duration);
await probe.close();
const from = +arg("from", 0), to = +arg("to", dur);
const total = Math.round((to - from) * fps);
console.log(`duration ${dur.toFixed(1)} s, rendering ${total} frames with ${workers} workers`);
const started = Date.now();
let doneFrames = 0;
const seg = async (w) => {
  const a = Math.floor((total * w) / workers), b = Math.floor((total * (w + 1)) / workers);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  const file = join(out, `seg${w}.mp4`);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), file]);
  for (let f = a; f < b; f++) {
    await page.evaluate((t) => window.__seek(t), from + f / fps);
    const buf = await page.screenshot({ type: "jpeg", quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (++doneFrames % 300 === 0) console.log(`${doneFrames}/${total} frames, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  await page.close();
  return file;
};
const files = await Promise.all(Array.from({ length: workers }, (_, w) => seg(w)));
await browser.close();
writeFileSync(join(out, "list.txt"), files.map((f) => `file '${f}'`).join("\n"));
const mp4 = join(out, "chair-promo.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(out, "list.txt"), "-c", "copy", "-movflags", "+faststart", mp4]);
const dest = "/tmp/chair-promo";
mkdirSync(join(dest, "stills"), { recursive: true });
copyFileSync(mp4, join(dest, "chair-promo.mp4"));
const stills = (arg("stills", "") || "").split(",").filter(Boolean).map(Number);
const at = stills.length ? stills : [0.3, 0.38, 0.62, 0.7, 0.82, 0.97].map((k) => from + (to - from) * k);
at.forEach((t, i) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(t - from), "-i", mp4, "-frames:v", "1", join(dest, "stills", `still-${i + 1}.png`)]));
console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s → ${mp4} and ${dest}/chair-promo.mp4`);
