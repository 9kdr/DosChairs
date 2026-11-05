// Saves PNG stills of chosen moments: node stills.mjs 2 60 120 ... → /tmp/chair-promo/stills
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const pw = join(homedir(), ".cache/ms-playwright");
const exe = process.env.CHROMIUM || readdirSync(pw).filter((d) => d.startsWith("chromium-")).map((d) => join(pw, d, "chrome-linux64/chrome")).find(existsSync);
const dir = process.env.OUT || "/tmp/chair-promo/stills"; mkdirSync(dir, { recursive: true });
const b = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto("file://" + join(import.meta.dirname, "index.html")); await p.evaluate(() => document.fonts.ready);
const ts = process.argv.slice(2).map(Number);
for (const [i, t] of (ts.length ? ts : [2.5, 26, 34, 119, 127.5, 161, 187]).entries()) {
  await p.evaluate((t) => window.__seek(t), t);
  await p.screenshot({ path: join(dir, `still-${i + 1}.${dir.includes("promo/stills") ? "jpg" : "png"}`), ...(dir.includes("promo/stills") ? { type: "jpeg", quality: 80 } : {}) });
}
await b.close(); console.log("stills in", dir);
