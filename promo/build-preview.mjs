// Packs index.html + script.js + stage.js + the font into one self-contained
// out/preview.html that plays the whole promo live (no render needed).
// Click to pause/play, drag the bar to scrub.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const here = import.meta.dirname, read = (f) => readFileSync(join(here, f), "utf8");
const lite = process.argv.includes("--lite");
const font = lite ? "" : readFileSync(join(here, "fonts/inter-latin-wght-normal.woff2")).toString("base64");
let css = read("index.html").match(/<style>([\s\S]*?)<\/style>/)[1]
  .replace("url(fonts/inter-latin-wght-normal.woff2)", lite ? `url(${join(here, "fonts/inter-latin-wght-normal.woff2")})` : `url(data:font/woff2;base64,${font})`)
  .replace(/html, body \{[^}]*\}/, `#frame { position:absolute; left:0; top:0; width:1920px; height:1080px; overflow:hidden; background:var(--bg); color:var(--fg);
  font-family:"Inter Variable",sans-serif; -webkit-font-smoothing:antialiased; font-size:15px; transform-origin:0 0; }
#view { position:relative; width:100%; aspect-ratio:16/9; overflow:hidden; border-radius:12px; background:#0A0A0A; cursor:pointer; }
#ui { display:flex; gap:10px; align-items:center; margin-top:8px; font:12px/1 monospace; color:#a3a3a3; }
#scrub { flex:1; accent-color:#f5f5f5; }`);
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<div id="view"><div id="frame"><canvas id="bg" width="480" height="270"></canvas><div id="stage"></div></div></div>
<div id="ui"><span id="pp">pause</span><input id="scrub" type="range" min="0" max="1000" value="0"><span id="tc">0.0 s</span></div>
<script>${read("script.js")}</script><script>${read("stage.js")}</script>
<script>
const view = document.getElementById("view"), frame = document.getElementById("frame"), scrub = document.getElementById("scrub"), tc = document.getElementById("tc"), pp = document.getElementById("pp");
const fit = () => { frame.style.transform = "scale(" + view.clientWidth / 1920 + ")"; };
new ResizeObserver(fit).observe(view); fit();
let t = 0, playing = true, last = performance.now();
const D = window.__duration;
const tick = (now) => { if (playing) t = (t + (now - last) / 1000) % D; last = now;
  window.__seek(t); scrub.value = Math.round((t / D) * 1000); tc.textContent = t.toFixed(1) + " / " + D.toFixed(0) + " s"; requestAnimationFrame(tick); };
requestAnimationFrame(tick);
view.onclick = pp.onclick = () => { playing = !playing; pp.textContent = playing ? "pause" : "play"; };
scrub.oninput = () => { t = (scrub.value / 1000) * D; };
</script></body></html>`;
mkdirSync(join(here, "out"), { recursive: true });
const outFile = join(here, lite ? "out/preview-lite.html" : "out/preview.html");
writeFileSync(outFile, html);
console.log("wrote", outFile, (html.length / 1024).toFixed(0), "KB");
