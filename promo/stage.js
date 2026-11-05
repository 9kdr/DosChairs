// Chair promo: every frame is a pure function of time. window.__seek(t) draws t.
(() => {
const S = window.SCRIPT;
const W = 1920, H = 1080;

// ---------- helpers ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const eo = (x) => 1 - Math.pow(1 - clamp(x), 3);
const eio = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const prog = (t, s, d) => clamp((t - s) / d);
const lerp = (a, b, k) => a + (b - a) * k;
const inn = (t, s, d = 0.6, dy = 18) => { const k = eo(prog(t, s, d)); return `opacity:${k};transform:translateY(${(1 - k) * dy}px);`; };
const typed = (str, t, s, cps = 30) => str.slice(0, Math.max(0, Math.floor((t - s) * cps)));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const caret = (t) => (Math.floor(t * 2) % 2 ? "" : `<span style="display:inline-block;width:2px;height:1.1em;background:var(--fg);vertical-align:-0.15em;margin-left:2px"></span>`);
const kf = (keys) => (t) => {
  if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, x0, y0] = keys[i - 1], [t1, x1, y1] = keys[i];
      const k = eio((t - t0) / (t1 - t0));
      return [lerp(x0, x1, k), lerp(y0, y1, k)];
    }
  }
  const l = keys[keys.length - 1]; return [l[1], l[2]];
};

// ---------- dither tiles (ordered Bayer, Chair's dither look) ----------
const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const tileCache = {};
function dither(color, seed = 0, w = 240, h = 136, cell = 3) {
  const key = color + seed + w + h + cell;
  if (tileCache[key]) return tileCache[key];
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#141414"; g.fillRect(0, 0, w, h);
  g.fillStyle = color;
  const cx = (0.25 + ((seed * 37) % 50) / 100) * w, cy = (0.3 + ((seed * 53) % 40) / 100) * h;
  for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
    const d = Math.hypot((x - cx) / w, (y - cy) / h);
    const v = clamp(1.05 - d * 1.9 + 0.12 * Math.sin((x + seed * 20) / 23) * Math.cos(y / 17));
    const th = (bayer4[((y / cell) % 4) * 4 + ((x / cell) % 4)] + 0.5) / 16;
    if (v > th) g.fillRect(x, y, cell - 1, cell - 1);
  }
  return (tileCache[key] = c.toDataURL());
}
const PAL = ["oklch(0.72 0.14 240)", "oklch(0.7 0.18 304)", "oklch(0.78 0.17 152)", "oklch(0.74 0.17 354)", "oklch(0.79 0.15 62)", "oklch(0.66 0 0)"];
// Resolve canvas colors from oklch to rgb once (2d canvas accepts oklch in modern chromium; keep as is).
const thumb = (i, extra = "") => `background:url(${dither(PAL[i % PAL.length], i)}) center/cover;image-rendering:pixelated;${extra}`;
const checker = "background-color:#161616;background-image:conic-gradient(#1f1f1f 25%,transparent 0 50%,#1f1f1f 0 75%,transparent 0);background-size:24px 24px;";

// ---------- background shader (own WebGL port of a shaders.com-style dithered flow) ----------
const cv = document.getElementById("bg");
const gl = cv.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
let prog_, uni = {};
if (gl) {
  const vs = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;
  const fs = `precision highp float;
uniform vec2 uRes;uniform float uT,uAmt,uZoom;uniform vec3 uA,uB;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p*=2.03;a*=.5;}return v;}
float b2(vec2 a){a=floor(a);return fract(a.x/2.+a.y*a.y*.75);}
float b4(vec2 a){return b2(.5*a)*.25+b2(a);}
void main(){vec2 uv=gl_FragCoord.xy/uRes;vec2 p=(uv-.5)*vec2(uRes.x/uRes.y,1.)*uZoom;
float w=fbm(p*1.3+vec2(uT*.035,-uT*.02));
float v=fbm(p*1.7+vec2(w*1.6+uT*.03,uT*.025));
float m=smoothstep(.42,.9,v)*uAmt*(1.-smoothstep(.25,.75,length(uv-.5)));
float on=step(b4(gl_FragCoord.xy)+.001,m);
vec3 col=mix(uA,uB,smoothstep(.35,.75,fbm(p*.8+5.+uT*.01)));
gl_FragColor=vec4(mix(vec3(.039),col,on*.5),1.);}`;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  prog_ = gl.createProgram();
  gl.attachShader(prog_, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog_, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog_); gl.useProgram(prog_);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog_, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  for (const k of ["uRes", "uT", "uAmt", "uZoom", "uA", "uB"]) uni[k] = gl.getUniformLocation(prog_, k);
}
const C = { grey: [0.55, 0.55, 0.55], blue: [0.38, 0.62, 0.95], purple: [0.66, 0.5, 0.95], green: [0.35, 0.8, 0.55], orange: [0.95, 0.7, 0.4] };
function drawBg(t, bg) {
  if (!gl) return;
  gl.viewport(0, 0, cv.width, cv.height);
  gl.uniform2f(uni.uRes, cv.width, cv.height); gl.uniform1f(uni.uT, t);
  gl.uniform1f(uni.uAmt, bg.amt); gl.uniform1f(uni.uZoom, bg.zoom || 2.2);
  gl.uniform3fv(uni.uA, C[bg.a || "grey"]); gl.uniform3fv(uni.uB, C[bg.b || "blue"]);
  gl.drawArrays(gl.TRIANGLES, 0, 3); gl.finish();
}

// ---------- the pendulum cursor (hero) ----------
// Tip pinned to a keyframed target; the body swings with the target's acceleration.
function swing(path, t, o = {}) {
  const L = o.L || 40, g = o.g || 2600, damp = o.damp || 3.4, dt = 1 / 240, hh = 1 / 240;
  let th = 0, w = 0;
  for (let s = 0; s < t; s += dt) {
    const p0 = path(s - hh), p1 = path(s), p2 = path(s + hh);
    const ax = (p2[0] - 2 * p1[0] + p0[0]) / (hh * hh), ay = (p2[1] - 2 * p1[1] + p0[1]) / (hh * hh);
    const al = (-ax * Math.cos(th) - (g - ay) * Math.sin(th)) / L - damp * w;
    w += al * dt; th += w * dt;
  }
  return clamp(th, -1.6, 1.6);
}
const arrow = `<path d="M0 0 L0 31 L8 24 L13.5 36 L18.5 33.8 L13.2 22.2 L23.5 22.2 Z" fill="#f5f5f5" stroke="#0a0a0a" stroke-width="1.6" stroke-linejoin="round"/>`;
function cursorAt(x, y, th = 0, scale = 1.6, extra = "") {
  const deg = (-th * 180) / Math.PI;
  return `<svg class="abs" width="1" height="1" style="left:${x}px;top:${y}px;overflow:visible;transform:rotate(${deg}deg) scale(${scale});transform-origin:0 0;filter:drop-shadow(0 6px 10px rgb(0 0 0/.5));${extra}">${arrow}</svg>`;
}
function swingCursor(path, t, scale = 1.6, o = {}, press = 0) {
  const [x, y] = path(t);
  const th = swing(path, t, o);
  return cursorAt(x, y, th, scale * (1 - press * 0.12));
}
const pressAt = (t, s) => (t >= s && t < s + 0.22 ? Math.sin(((t - s) / 0.22) * Math.PI) : 0);

// ---------- shared chrome ----------
const winBar = (extra = "") => `<div class="bar"><span style="font-weight:600;font-size:16px;letter-spacing:-0.01em">Chair</span>
  <span class="chip">Summer Reel</span><span class="chip"><span class="dot" style="background:var(--success)"></span>Resolve connected</span>
  <span style="flex:1"></span>${extra}</div>`;
let featureIndex = 0;
function feature(f, n, lt, inner, barExtra = "") {
  const k = eo(prog(lt, 0.1, 0.8));
  return `<div class="abs" style="left:100px;top:290px;width:540px">
    <div class="kicker" style="${inn(lt, 0)}"><span class="mono" style="color:var(--subtle)">${String(n).padStart(2, "0")}</span>${esc(f.label)}</div>
    <div class="h1" style="margin-top:22px;${inn(lt, 0.12)}">${esc(f.title)}</div>
    <div class="sub" style="margin-top:28px;${inn(lt, 0.28)}">${esc(f.sub)}</div></div>
  <div class="win" style="opacity:${k};transform:translateX(${(1 - k) * 60}px)">${winBar(barExtra)}
    <div class="abs" style="left:0;top:48px;width:1120px;height:792px">${inner}</div></div>`;
}
function cmdBar(text, t, opts = {}) {
  const ph = !text;
  return `<div class="abs pill" style="left:40px;top:${opts.top || 700}px;width:1040px;height:64px;background:var(--fill);box-shadow:var(--rim);display:flex;align-items:center;padding:0 12px 0 26px;gap:12px;${opts.style || ""}">
    <span style="flex:1;font-size:18px;color:${ph ? "var(--subtle)" : "var(--fg)"}">${ph ? "Ask Chair to edit…" : esc(text)}${opts.focus ? caret(t) : ""}</span>
    <span class="pill" style="width:44px;height:44px;background:${opts.send ? "var(--fg)" : "var(--raised)"};display:flex;align-items:center;justify-content:center;transform:scale(${opts.sendScale || 1})">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${opts.send ? "#0a0a0a" : "#a3a3a3"}" stroke-width="2.4" stroke-linecap="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span></div>`;
}
const spinner = (t, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${t * 360}deg)"><circle cx="12" cy="12" r="9" fill="none" stroke="#404040" stroke-width="3"/><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="#f5f5f5" stroke-width="3" stroke-linecap="round"/></svg>`;
const checkIcon = (size = 16, col = "#10b981") => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const xIcon = (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="oklch(0.68 0.2 25)" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const ring = (size = 16) => `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:99px;border:2px solid #525252"></span>`;
const toast = (txt, k, y) => `<div class="abs" style="right:40px;top:${y}px;width:340px;height:60px;background:var(--popover,#1A1A1A);border-radius:16px;box-shadow:var(--rim),0 12px 30px rgb(0 0 0/.45);display:flex;align-items:center;gap:12px;padding:0 18px;opacity:${k};transform:translateX(${(1 - k) * 40}px)">${checkIcon(18)}<span style="font-weight:500">Task done</span><span class="meta">${esc(txt)}</span></div>`;

// ---------- feature scenes ----------
function sFlow(lt, f, n) {
  const typedStart = 1.0, sendAt = 3.35;
  const txt = lt < sendAt + 0.25 ? typed(f.command, lt, typedStart, 32) : "";
  let h = cmdBar(txt, lt, { focus: lt > 0.9 && lt < sendAt + 0.25, send: txt.length > 0, sendScale: 1 - pressAt(lt, sendAt) * 0.15 });
  // plan card
  const pk = eo(prog(lt, 3.6, 0.6));
  const doneAt = (i) => 5.0 + i * 1.15;
  h += `<div class="abs card" style="left:40px;top:40px;width:470px;height:400px;padding:28px;opacity:${pk};transform:translateY(${(1 - pk) * 20}px)">
    <div style="display:flex;align-items:center;gap:10px"><span style="font-weight:600;font-size:17px">Plan</span><span class="chip" style="height:26px">Muse Wonder · orchestrator</span></div>
    <div class="meta" style="margin-top:8px">${esc(f.command)}</div>
    <div style="margin-top:22px;display:flex;flex-direction:column;gap:16px">${f.plan.map((s, i) => {
      const st = lt > doneAt(i) + 0.9 ? checkIcon(18) : lt > doneAt(i) - 0.1 ? spinner(lt, 18) : ring(18);
      return `<div style="display:flex;align-items:center;gap:14px;font-size:17px;${inn(lt, 3.9 + i * 0.18, 0.5, 10)}">${st}<span>${esc(s)}</span></div>`;
    }).join("")}</div></div>`;
  // task cards
  f.tasks.forEach((name, i) => {
    const s = 4.4 + i * 0.25, run = 5.6 + i * 1.15, done = run + 1.1;
    const status = lt > done ? `<span class="chip" style="color:var(--fg)">${checkIcon(14)}Done</span>` : lt > run ? `<span class="chip" style="color:var(--fg)">${spinner(lt, 14)}Running · Muse Spark</span>` : `<span class="chip">Queued</span>`;
    const shift = lt > run && lt < done ? (lt * 40) % 240 : 0;
    h += `<div class="abs card" style="left:540px;top:${40 + i * 140}px;width:540px;height:124px;padding:14px;display:flex;gap:18px;align-items:center;${inn(lt, s, 0.5, 20)}">
      <div style="width:150px;height:96px;border-radius:14px;${thumb(i + 1, `background-position:${shift}px 0;background-size:300px 170px;opacity:${lt > run ? 1 : 0.45}`)}"></div>
      <div style="flex:1"><div style="font-weight:600;font-size:17px">${esc(name)}</div><div class="meta" style="margin-top:4px">Tool agent · task ${i + 1}</div><div style="margin-top:12px">${status}</div></div></div>`;
  });
  // toasts
  f.tasks.forEach((name, i) => {
    const s = 6.7 + i * 1.15, k = eo(prog(lt, s, 0.4)) * (1 - prog(lt, s + 2.0, 0.4));
    if (k > 0) h += toast(name, k, 470 + i * 70);
  });
  const path = kf([[0, 900, 560], [0.85, 420, 735], [3.2, 440, 738], [3.5, 1030, 735], [4.4, 820, 560], [10, 820, 560]]);
  h += swingCursor(path, lt, 1.5, {}, pressAt(lt, 0.9) + pressAt(lt, sendAt));
  return feature(f, n, lt, h);
}

function lanes(rows, x, y, w, extra = {}) {
  // rows: [label, clips:[[start,len,color,label]]]
  return rows.map(([label, clips], r) => `<div class="abs meta mono" style="left:${x}px;top:${y + r * 52 + 12}px">${label}</div>` +
    clips.map(([s, l, c, lab, op = 1]) => `<div class="track" style="left:${x + 56 + s * (w - 56)}px;top:${y + r * 52}px;width:${l * (w - 56)}px;${typeof c === "number" ? thumb(c) : `background:${c};`}opacity:${op};box-shadow:var(--rim)"><span style="position:absolute;left:10px;top:12px;font-size:12px;color:#f5f5f5;text-shadow:0 1px 2px #000">${lab || ""}</span></div>`).join("")).join("");
}
const baseRows = [["V2", [[0.1, 0.18, 5, "B-roll"]]], ["V1", [[0, 0.32, 0, "Interview A"], [0.33, 0.27, 2, "Wide"], [0.61, 0.38, 0, "Interview B"]]], ["A1", [[0, 0.6, "#2a2a2a", "Dialogue"], [0.61, 0.38, "#2a2a2a", "Dialogue"]]], ["A2", [[0, 0.99, "#232338", "Music"]]]];

function sCopies(lt, f, n) {
  let h = `<div class="abs card" style="left:40px;top:24px;width:1040px;height:284px;padding:18px 24px">
    <div style="display:flex;gap:10px;align-items:center"><span style="font-weight:600">Summer Reel</span><span class="chip" style="height:26px">Your timeline</span>
    ${lt > 5.3 ? `<span class="chip" style="height:26px;color:var(--fg);${inn(lt, 5.3, 0.4, 6)}"><span class="dot" style="background:var(--success)"></span>Untouched</span>` : ""}</div>
    ${lanes(baseRows, 24, 64, 990)}</div>`;
  const ck = eo(prog(lt, 1.0, 0.8)), und = prog(lt, 5.1, 0.6);
  const v3k = eo(prog(lt, 1.9, 0.5));
  h += `<div class="abs card" style="left:40px;top:${lerp(24, 322, ck)}px;width:1040px;height:330px;padding:20px 24px;opacity:${Math.min(ck, 1 - und * 0.7)};background:#1f1f1f">
    <div style="display:flex;gap:10px;align-items:center"><span style="font-weight:600">Summer Reel · Chair 1</span><span class="chip" style="height:26px;color:var(--fg)">New timeline (copy)</span>
    ${lt > 5.1 ? `<span class="chip" style="height:26px">Undone</span>` : ""}</div>
    ${lanes([["V3", [[0.02, 0.2, 1, "Title piece", v3k]]], ...baseRows], 24, 64, 990)}
    <div class="abs chip" style="left:290px;top:58px;height:26px;color:var(--fg);opacity:${v3k}">New track</div></div>`;
  // history
  h += `<div class="abs card" style="left:40px;top:664px;width:640px;height:122px;padding:10px 24px">
    <div style="font-weight:600;margin-bottom:2px">History</div>${f.history.map((r, i) => {
      const struck = i > 0 && lt > 5.1;
      return `<div style="display:flex;gap:12px;align-items:center;height:28px;${inn(lt, 0.6 + i * 1.0, 0.4, 8)};opacity:${struck ? 0.4 : undefined}">
      <span class="mono meta" style="width:24px">${i + 1}</span><span style="${struck ? "text-decoration:line-through" : ""}">${esc(r)}</span></div>`;
    }).join("")}</div>`;
  const p = pressAt(lt, 4.9);
  h += `<div class="abs" style="left:730px;top:696px;display:flex;gap:10px;align-items:center;${inn(lt, 4.2, 0.5)}">
    <span class="kbd" style="transform:translateY(${p * 4}px)">Ctrl</span><span class="kbd" style="transform:translateY(${p * 4}px)">Z</span><span class="meta" style="margin-left:8px;font-size:15px">Undo</span></div>`;
  return feature(f, n, lt, h);
}

function sResolve(lt, f, n) {
  const names = ["Summer Reel", "Launch Teaser", "Podcast Ep. 12"];
  const click = 1.8;
  let h = `<div class="abs" style="left:40px;top:36px;font-size:22px;font-weight:600">Projects</div>`;
  names.forEach((nm, i) => {
    const sc = i === 0 ? 1 - pressAt(lt, click) * 0.03 : 1;
    h += `<div class="abs card" style="left:${40 + i * 350}px;top:96px;width:330px;height:270px;padding:12px;transform:scale(${sc});${inn(lt, 0.2 + i * 0.12, 0.5)}">
      <div style="height:190px;border-radius:16px;${thumb(i * 2)}"></div><div style="margin:14px 6px 0;font-weight:600">${nm}</div><div class="meta" style="margin:2px 6px">DaVinci Resolve · 3 timelines</div></div>`;
  });
  const rk = eo(prog(lt, 2.3, 0.9));
  const tabs = ["Media", "Cut", "Edit", "Fusion", "Color", "Fairlight", "Deliver"];
  const lineK = (s) => prog(lt, s, 0.5);
  const node = (x, y, label, acc, s) => `<div class="abs" style="left:${x}px;top:${y}px;width:190px;height:56px;border-radius:10px;background:${acc ? "#2b2440" : "#2a2a2c"};border:1px solid ${acc ? "oklch(0.7 0.18 304)" : "#3a3a3c"};display:flex;align-items:center;justify-content:center;font-size:15px;${inn(lt, s, 0.4, 10)}">${label}</div>`;
  h += `<div class="abs" style="left:0;top:${lerp(800, 0, rk)}px;width:1120px;height:792px;background:#161618;border-top:1px solid #2c2c2e">
    <div style="height:44px;display:flex;align-items:center;padding:0 20px;gap:10px;border-bottom:1px solid #26262a;font-size:14px;color:#b0b0b4">Resolve · Summer Reel
      <span style="flex:1"></span>${tabs.map((t) => `<span style="padding:4px 10px;border-radius:6px;${t === "Fusion" ? "background:#2c2c30;color:#f5f5f5" : ""}">${t}</span>`).join("")}</div>
    <svg class="abs" style="left:0;top:44px" width="1120" height="420">
      <path d="M 300 190 L 445 190" stroke="#8a8a8e" stroke-width="2" stroke-dasharray="145" stroke-dashoffset="${145 * (1 - lineK(3.5))}"/>
      <path d="M 635 190 L 780 190" stroke="#8a8a8e" stroke-width="2" stroke-dasharray="145" stroke-dashoffset="${145 * (1 - lineK(3.9))}"/></svg>
    ${node(110, 206, "MediaIn1", false, 3.2)}${node(445, 206, "Chair · Title Piece", true, 3.5)}${node(780, 206, "MediaOut1", false, 3.9)}
    <div class="abs" style="left:445px;top:150px;${inn(lt, 4.1, 0.5)}"><span class="chip" style="color:var(--fg)">Native Fusion comp · new version</span></div>
    <div class="abs" style="left:40px;top:470px;width:1040px;height:270px;border-radius:12px;background:#1d1d20;padding:18px 22px;${inn(lt, 4.3, 0.5)}">
      <div style="font-size:14px;color:#b0b0b4;margin-bottom:14px">Keyframes · Chair · Title Piece</div>
      ${["Position X", "Opacity", "Bar width"].map((p, r) => `<div style="position:relative;height:56px;border-top:1px solid #2a2a2e"><span style="position:absolute;left:0;top:18px;font-size:14px;color:#c8c8cc">${p}</span>
        ${[0.08, 0.3, 0.55, 0.8].map((x, i) => `<span style="position:absolute;left:${180 + x * 800}px;top:20px;width:14px;height:14px;background:oklch(0.79 0.15 62);transform:rotate(45deg) scale(${eo(prog(lt, 4.7 + r * 0.15 + i * 0.12, 0.3))})"></span>`).join("")}</div>`).join("")}
      <div class="abs" style="left:${222 + 800 * prog(lt, 4.6, 2.8)}px;top:40px;width:2px;height:200px;background:#e5484d"></div></div></div>`;
  const path = kf([[0, 700, 600], [1.6, 200, 250], [2.3, 230, 270], [3.2, 900, 650], [7.5, 900, 650]]);
  h += swingCursor(path, lt, 1.5, {}, pressAt(lt, click));
  return feature(f, n, lt, h);
}

function sPieces(lt, f, n) {
  let h = `<div class="abs pill" style="left:40px;top:36px;width:1040px;height:60px;background:var(--fill);box-shadow:var(--rim);display:flex;align-items:center;padding:0 20px 0 24px;gap:12px">
    <span class="meta" style="font-size:15px">Piece</span><span style="flex:1;font-size:18px">${esc(typed(f.prompt, lt, 0.5, 26))}${lt < 2 ? caret(lt) : ""}</span><span class="chip" style="color:var(--fg)">Muse Spark</span></div>`;
  // preview on transparency checker
  const p = lt - 2.2;
  const bar = eo(prog(p, 0, 0.7)), t1 = eo(prog(p, 0.3, 0.6)), t2 = eo(prog(p, 0.5, 0.6)), acc = eo(prog(p, 0.15, 0.5));
  h += `<div class="abs" style="left:40px;top:120px;width:660px;height:400px;border-radius:24px;overflow:hidden;${checker}${inn(lt, 1.6, 0.6)}">
    <div class="abs" style="left:56px;top:250px;width:${420 * bar}px;height:88px;background:rgb(10 10 10/.88);border-radius:10px"></div>
    <div class="abs" style="left:56px;top:250px;width:10px;height:${88 * acc}px;background:oklch(0.7 0.18 304);border-radius:10px 0 0 10px"></div>
    <div class="abs" style="left:86px;top:262px;font-size:30px;font-weight:600;letter-spacing:-0.02em;opacity:${t1};transform:translateY(${(1 - t1) * 16}px)">Mel, editor</div>
    <div class="abs" style="left:86px;top:302px;font-size:16px;color:#a3a3a3;opacity:${t2};transform:translateY(${(1 - t2) * 12}px)">Shot on a Chair · Summer Reel</div>
    <div class="abs chip" style="left:20px;top:20px;color:var(--fg)">Transparent · alpha</div></div>`;
  // bake stats
  const bk = prog(lt, 3.6, 2.2);
  const secs = (17 * bk).toFixed(1);
  h += `<div class="abs card" style="left:730px;top:120px;width:350px;height:190px;padding:24px;${inn(lt, 3.3, 0.5)}">
    <div class="meta">Bake · 8 s · 1080p · GPU</div><div style="font-size:52px;font-weight:600;letter-spacing:-0.03em;margin-top:6px" class="mono">${secs}<span style="font-size:24px;color:var(--muted)"> s</span></div>
    <div style="margin-top:16px;height:8px;border-radius:99px;background:#2a2a2a;overflow:hidden"><div style="height:100%;width:${bk * 100}%;background:var(--fg)"></div></div></div>
    <div class="abs card" style="left:730px;top:330px;width:350px;height:190px;padding:24px;${inn(lt, 6.1, 0.5)}">
    <div class="meta">${esc(f.cached)}</div><div style="font-size:52px;font-weight:600;letter-spacing:-0.03em;margin-top:6px;display:flex;align-items:center;gap:14px" class="mono">0.3<span style="font-size:24px;color:var(--muted)"> s</span>${checkIcon(30)}</div>
    <div style="margin-top:16px;height:8px;border-radius:99px;background:var(--success)"></div></div>`;
  // frame strip
  h += `<div class="abs" style="left:40px;top:550px;display:flex;gap:12px">${Array.from({ length: 8 }, (_, i) => {
    const k = eo(prog(bk, i / 8, 0.12));
    return `<div style="width:121px;height:68px;border-radius:10px;${checker}background-size:12px 12px;opacity:${0.2 + 0.8 * k};position:relative;overflow:hidden"><div style="position:absolute;left:8px;top:40px;height:16px;width:${60 * Math.min(1, (i + 1) / 4)}px;background:rgb(10 10 10/.9);border-left:3px solid oklch(0.7 0.18 304)"></div></div>`;
  }).join("")}</div><div class="abs meta" style="left:40px;top:632px;${inn(lt, 3.6)}">PNG frames with alpha → new comp version in Resolve</div>`;
  return feature(f, n, lt, h);
}

function sShelf(lt, f, n) {
  const items = [["Media", "Interview A"], ["Pieces", "Lower third · grain"], ["Sounds", "Riser 2.4 s"], ["Media", "Wide shot"], ["Pieces", "Title · kinetic"], ["Sounds", "Whoosh soft"],
    ["Media", "B-roll street"], ["Pieces", "Lower third · clean"], ["Sounds", "Room tone"], ["Pieces", "Pendulum cursor"], ["Media", "Logo.png"], ["Sounds", "Hit low"]];
  const filterAt = 2.65, q = lt > 4.2 ? typed(f.search, lt, 4.2, 9) : "";
  const kind = lt > filterAt ? "Pieces" : "All";
  const vis = (kd, query) => items.map((it, i) => ((kd === "All" || it[0] === kd) && it[1].toLowerCase().includes(query) ? i : -1)).filter((i) => i >= 0);
  // state transitions
  const states = [[0, vis("All", "")], [filterAt, vis("Pieces", "")], [4.2 + 5 / 9, vis("Pieces", f.search)]];
  let cur = 0; for (let i = 0; i < states.length; i++) if (lt >= states[i][0]) cur = i;
  const prev = states[Math.max(0, cur - 1)][1], now = states[cur][1], k = cur ? eio(prog(lt, states[cur][0], 0.6)) : 1;
  const pos = (j) => [40 + (j % 4) * 262, 120 + Math.floor(j / 4) * 200];
  let h = `<div class="abs pill" style="left:40px;top:36px;width:860px;height:56px;background:var(--fill);box-shadow:var(--rim);display:flex;align-items:center;padding:0 22px;gap:12px">
     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a3a3a3" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
     <span style="font-size:17px;color:${q ? "var(--fg)" : "var(--subtle)"}">${q ? esc(q) : "Search the shelf"}${lt > 4.0 && lt < 6 ? caret(lt) : ""}</span></div>
     <div class="abs pill" style="left:916px;top:36px;width:164px;height:56px;background:${lt > 1.5 && lt < filterAt ? "var(--raised)" : "var(--fill)"};box-shadow:var(--rim);display:flex;align-items:center;justify-content:center;gap:10px;font-size:16px">
     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f5f5f5" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>${kind}</div>`;
  items.forEach((it, i) => {
    const a = prev.indexOf(i), b = now.indexOf(i);
    let x, y, op, sc;
    if (a >= 0 && b >= 0) { const [x0, y0] = pos(a), [x1, y1] = pos(b); x = lerp(x0, x1, k); y = lerp(y0, y1, k); op = 1; sc = 1; }
    else if (b >= 0) { [x, y] = pos(b); op = k; sc = 0.94 + 0.06 * k; }
    else if (a >= 0) { [x, y] = pos(a); op = 1 - k; sc = 1 - 0.06 * k; }
    else return;
    if (op <= 0.001) return;
    const vis0 = it[0] === "Pieces" ? `${checker}background-size:16px 16px` : it[0] === "Sounds" ? "background:#1d1d24" : thumb(i);
    const wave = it[0] === "Sounds" ? `<svg class="abs" style="left:20px;top:40px" width="200" height="60">${Array.from({ length: 34 }, (_, j) => { const hh = 6 + Math.abs(Math.sin(j * 1.7 + i) * Math.cos(j * 0.6)) * 46; return `<rect x="${j * 6}" y="${30 - hh / 2}" width="3" height="${hh}" rx="1.5" fill="oklch(0.72 0.14 240)"/>`; }).join("")}</svg>` : "";
    const piece = it[0] === "Pieces" ? `<div class="abs" style="left:20px;top:80px;width:140px;height:28px;background:rgb(10 10 10/.9);border-left:4px solid oklch(0.7 0.18 304);border-radius:4px"></div>` : "";
    h += `<div class="abs card" style="left:${x}px;top:${y + (1 - eo(prog(lt, 0.1 + i * 0.04, 0.5))) * 20}px;width:242px;height:184px;padding:8px;opacity:${op * eo(prog(lt, 0.1 + i * 0.04, 0.5))};transform:scale(${sc})">
      <div style="position:relative;height:130px;border-radius:16px;overflow:hidden;${vis0}">${wave}${piece}</div>
      <div style="margin:10px 6px 0;font-size:14px;font-weight:500;display:flex;justify-content:space-between"><span>${esc(it[1])}</span><span class="meta">${it[0]}</span></div></div>`;
  });
  // menu
  const mk = eo(prog(lt, 1.55, 0.25)) * (1 - prog(lt, filterAt + 0.05, 0.2));
  if (mk > 0) {
    const hover = lt > 2.1 ? 2 : lt > 1.8 ? 0 : -1;
    h += `<div class="abs" style="left:900px;top:102px;width:180px;padding:6px;border-radius:16px;background:#1A1A1A;box-shadow:var(--rim),0 16px 40px rgb(0 0 0/.55);opacity:${mk};transform:translateY(${(1 - mk) * -8}px)">
      <div class="meta" style="padding:6px 12px">Show</div>${["All", "Media", "Pieces", "Sounds"].map((o, i) => `<div style="padding:9px 12px;border-radius:10px;font-size:15px;display:flex;justify-content:space-between;${i === hover ? "background:rgb(245 245 245/.06)" : ""}">${o}${o === "All" ? checkIcon(14, "#f5f5f5") : ""}</div>`).join("")}</div>`;
  }
  const path = kf([[0, 600, 600], [1.4, 1000, 70], [1.9, 980, 130], [2.4, 980, 186], [3.2, 760, 520], [7.5, 760, 520]]);
  h += swingCursor(path, lt, 1.5, {}, pressAt(lt, 1.45) + pressAt(lt, 2.5));
  return feature(f, n, lt, h);
}

function sRig(lt, f, n) {
  let h = `<div class="abs pill" style="left:40px;top:36px;width:1040px;height:60px;background:var(--fill);box-shadow:var(--rim);display:flex;align-items:center;padding:0 20px 0 24px;gap:12px">
    <span class="meta" style="font-size:15px">Effect Maker</span><span style="flex:1;font-size:18px">${esc(typed(f.prompt, lt, 0.4, 30))}${lt < 2 ? caret(lt) : ""}</span><span class="chip" style="color:var(--fg)">Generated rig</span></div>`;
  const keys = [[0, 160, 200], [2.0, 160, 200], [3.0, 780, 170], [4.0, 520, 360], [4.8, 900, 380], [5.8, 300, 300], [6.6, 640, 150], [7.6, 860, 300], [8.6, 420, 360], [10, 420, 360]];
  const path = kf(keys);
  const X0 = 40, Y0 = 120;
  const ck = eo(prog(lt, 1.2, 0.6));
  const pts = keys.slice(1, -1).map(([, x, y]) => `${x},${y}`).join(" ");
  h += `<div class="abs card" style="left:${X0}px;top:${Y0}px;width:1040px;height:470px;overflow:hidden;opacity:${ck};background-color:#151515;background-image:radial-gradient(#2a2a2a 1.2px,transparent 1.2px);background-size:28px 28px">
    <svg class="abs" style="left:0;top:0" width="1040" height="470"><polyline points="${pts}" fill="none" stroke="#3a3a3a" stroke-width="2" stroke-dasharray="6 8"/>
    ${keys.slice(1, -1).map(([kt, x, y]) => `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" transform="rotate(45 ${x} ${y})" fill="${lt >= kt ? "oklch(0.79 0.15 62)" : "#4a4a4a"}"/>`).join("")}</svg>`;
  // ghost trail
  for (let g = 4; g >= 1; g--) {
    const tg = lt - g * 0.05; if (tg < 2) continue;
    const [gx, gy] = path(tg);
    h += cursorAt(gx, gy, swing(path, tg, { L: 46, damp: 2.4 }), 3, `opacity:${0.1 * (5 - g) / 2};filter:none`);
  }
  const [tx, ty] = path(lt);
  h += `<div class="abs" style="left:${tx - 9}px;top:${ty - 9}px;width:18px;height:18px;border-radius:99px;border:2px solid oklch(0.79 0.15 62)"></div>`;
  h += cursorAt(tx, ty, swing(path, lt, { L: 46, damp: 2.4 }), 3);
  h += `</div>`;
  // keyframe lane
  const lk = prog(lt, 2.0, 7.6);
  h += `<div class="abs card" style="left:40px;top:610px;width:1040px;height:150px;padding:18px 24px;${inn(lt, 1.6)}">
    <div style="display:flex;gap:10px;align-items:center"><span style="font-weight:600">Target</span><span class="meta">Keyframed, no tracking</span><span style="flex:1"></span>
    <span class="chip">Length 46</span><span class="chip">Damping 2.4</span><span class="chip">Gravity 2600</span></div>
    ${["X", "Y"].map((a, r) => `<div style="position:relative;height:38px;margin-top:${r ? 0 : 14}px;border-top:1px solid var(--line)"><span class="meta mono" style="position:absolute;left:0;top:10px">${a}</span>
      ${keys.slice(1, -1).map(([kt]) => `<span style="position:absolute;left:${60 + ((kt - 2) / 7.6) * 900}px;top:12px;width:12px;height:12px;background:${lt >= kt ? "oklch(0.79 0.15 62)" : "#4a4a4a"};transform:rotate(45deg)"></span>`).join("")}</div>`).join("")}
    <div class="abs" style="left:${84 + lk * 900}px;top:56px;width:2px;height:80px;background:#e5484d"></div></div>`;
  return feature(f, n, lt, h);
}

function sSound(lt, f, n) {
  const x = 40, w = 1040, L = (s) => x + 56 + s * (w - 56 - 30);
  const rows = [["V1", [[0, 0.3, 0, "Interview A"], [0.31, 0.25, 2, "Title moment"], [0.57, 0.42, 0, "Interview B"]]],
    ["A1", [[0.02, 0.26, "#2a2a2a", "Dialogue"], [0.6, 0.36, "#2a2a2a", "Dialogue"]]], ["A2", [[0, 0.99, "#232338", "Music · Hungarian Dance No. 5"]]], ["A3", []]];
  let h = `<div class="abs card" style="left:${x}px;top:40px;width:${w}px;height:330px;padding:20px 24px">
    <div style="display:flex;gap:10px;align-items:center"><span style="font-weight:600">Summer Reel · Chair 2</span><span class="chip" style="height:26px">copy</span></div></div>`;
  h += `<div class="abs" style="left:0;top:0">${lanes(rows, x + 24, 104, w - 48)}</div>`;
  // volume line on A2
  const yA2 = 104 + 2 * 52, top = yA2 + 8, low = yA2 + 32;
  const X = (s) => x + 24 + 56 + s * (w - 48 - 56);
  const d = `M ${X(0)} ${top} L ${X(0.0)} ${low} L ${X(0.29)} ${low} L ${X(0.31)} ${top} L ${X(0.58)} ${top} L ${X(0.6)} ${low} L ${X(0.97)} ${low}`;
  const dk = prog(lt, 1.0, 1.4);
  h += `<svg class="abs" style="left:0;top:0" width="1120" height="800"><path d="${d}" fill="none" stroke="oklch(0.79 0.15 62)" stroke-width="2.5" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${1 - dk}"/></svg>`;
  h += `<div class="abs chip" style="left:${X(0.62)}px;top:${yA2 - 34}px;color:var(--fg);${inn(lt, 2.0, 0.4, 8)}">Music −9 dB under dialogue</div>`;
  // riser picked then dropped
  const pk = eo(prog(lt, 2.4, 0.5)) * (1 - prog(lt, 5.6, 0.4));
  h += `<div class="abs card" style="left:540px;top:430px;width:540px;padding:18px;opacity:${pk}"><div class="meta" style="margin-bottom:10px">SFX picks for the title moment</div>
    ${[["Riser 2.4 s", true], ["Whoosh soft", false], ["Hit low", false]].map(([s, on], i) => `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;${on && lt > 3.2 ? "background:rgb(245 245 245/.06)" : ""};${inn(lt, 2.6 + i * 0.12, 0.4, 8)}">
      ${on && lt > 3.2 ? checkIcon(16) : ring(16)}<span>${s}</span></div>`).join("")}</div>`;
  const dropK = eio(prog(lt, 3.6, 0.9));
  const yA3 = 104 + 3 * 52;
  if (lt > 3.6) h += `<div class="track" style="left:${lerp(560, X(0.17), dropK)}px;top:${lerp(470, yA3, dropK)}px;width:${0.14 * (w - 104)}px;background:linear-gradient(90deg,#1d2533,oklch(0.72 0.14 240));box-shadow:var(--rim)"><span style="position:absolute;left:10px;top:12px;font-size:12px">Riser</span></div>`;
  h += `<div class="abs" style="left:${X(0.31)}px;top:96px;width:2px;height:260px;background:oklch(0.7 0.18 304);opacity:${0.4 + 0.6 * (lt > 4.5)}"></div>`;
  h += `<div class="abs chip" style="left:${X(0.31) + 12}px;top:${yA3 + 52}px;color:var(--fg);${inn(lt, 4.6, 0.4, 8)}">Riser ends on the cut</div>`;
  h += `<div class="abs" style="left:${X(prog(lt, 0.3, 6.4))}px;top:96px;width:2px;height:260px;background:#e5484d"></div>`;
  return feature(f, n, lt, h);
}

function sSuggest(lt, f, n) {
  const retryAt = 3.2, doneAt = 4.6;
  const steps = [["Read the cut", "done"], ["Generate title piece", "done"], ["Render preview", lt > doneAt ? "done" : lt > retryAt ? "run" : "fail"], ["Color match shots 3–5", "todo"], ["Export captions", "todo"]];
  let h = `<div class="abs card" style="left:40px;top:40px;width:1040px;height:440px;padding:28px">
    <div style="display:flex;align-items:center;gap:10px"><span style="font-weight:600;font-size:17px">Plan</span><span class="chip" style="height:26px">5 steps</span></div>
    <div style="margin-top:20px;display:flex;flex-direction:column;gap:6px">${steps.map(([s, st], i) => `<div style="display:flex;align-items:center;gap:14px;height:58px;padding:0 16px;border-radius:16px;font-size:17px;${st === "fail" ? "background:rgb(229 72 77/.08)" : ""};${inn(lt, 0.2 + i * 0.1, 0.4, 8)}">
      ${st === "done" ? checkIcon(18) : st === "run" ? spinner(lt, 18) : st === "fail" ? xIcon(18) : ring(18)}<span style="flex:1;${st === "todo" ? "color:var(--muted)" : ""}">${s}</span>
      ${st === "fail" ? `<span class="meta" style="margin-right:12px">GPU busy</span><span class="pill" style="padding:8px 18px;background:var(--fg);color:#0a0a0a;font-weight:600;font-size:14px;transform:scale(${1 - pressAt(lt, retryAt) * 0.08})">Retry</span>` : ""}
      ${st === "run" ? `<span class="meta">Muse Spark · retrying</span>` : ""}</div>`).join("")}</div></div>`;
  h += cmdBar("", lt, { top: 520 });
  const chips = f.chips.filter((c, i) => !(i === 1 && lt > retryAt + 0.2));
  h += `<div class="abs" style="left:40px;top:604px;display:flex;gap:12px">${chips.map((c) => { const i = f.chips.indexOf(c); return `<span class="chip" style="height:40px;font-size:15px;color:var(--fg);${inn(lt, 1.0 + i * 0.15, 0.4, 8)}">${c.startsWith("Retry") ? xIcon(14) : `<span class="dot" style="background:var(--muted)"></span>`}${esc(c)}</span>`; }).join("")}</div>
    <div class="abs meta" style="left:44px;top:660px;${inn(lt, 1.4)}">Suggestions come from the plan: next unrun steps, Retry on failures.</div>`;
  const path = kf([[0, 700, 700], [2.9, 1000, 288], [4.0, 980, 300], [5.0, 760, 700], [7, 760, 700]]);
  h += swingCursor(path, lt, 1.5, {}, pressAt(lt, retryAt));
  return feature(f, n, lt, h);
}

function sModels(lt, f, n) {
  const card = (x, name, role, rows, s) => `<div class="abs card" style="left:${x}px;top:80px;width:470px;height:420px;padding:32px;${inn(lt, s, 0.6)}">
    <div style="width:56px;height:56px;border-radius:16px;${thumb(name === "Muse Wonder" ? 1 : 0)}"></div>
    <div style="font-size:32px;font-weight:600;letter-spacing:-0.02em;margin-top:22px">${name}</div><div class="meta" style="font-size:16px;margin-top:4px">${role}</div>
    <div style="margin-top:26px;display:flex;flex-direction:column;gap:12px">${rows.map(([ic, r], i) => `<div style="display:flex;gap:12px;align-items:center;font-size:16px;${inn(lt, s + 0.6 + i * 0.25, 0.4, 8)}">${ic}${r}</div>`).join("")}</div></div>`;
  let h = card(40, "Muse Wonder", "Plans the edit", [[ring(16), "Read the cut"], [ring(16), "Split into tasks"], [ring(16), "Pick the tools"]], 0.2);
  h += card(610, "Muse Spark", "Executes each task, then verifies it", [[checkIcon(16), "Title piece"], [checkIcon(16), "Music ducking"], [checkIcon(16), "Verified on the copy"]], 0.6);
  const ak = prog(lt, 1.2, 0.8);
  h += `<svg class="abs" style="left:0;top:0" width="1120" height="800"><path d="M 520 290 L 600 290" stroke="#f5f5f5" stroke-width="2.5" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${1 - ak}"/><path d="M 590 282 L 600 290 L 590 298" fill="none" stroke="#f5f5f5" stroke-width="2.5" opacity="${ak}"/></svg>`;
  h += `<div class="abs" style="left:40px;top:560px;display:flex;gap:14px;align-items:center;font-size:18px;${inn(lt, 2.6)}"><span class="chip" style="height:44px;font-size:16px;color:var(--fg)">Plan</span>→<span class="chip" style="height:44px;font-size:16px;color:var(--fg)">Task</span>→<span class="chip" style="height:44px;font-size:16px;color:var(--fg)">Check ${checkIcon(16)}</span></div>`;
  return feature(f, n, lt, h);
}

// ---------- intro beats ----------
function kinetic(text, lt, s, size = 92, accent = "", align = "center") {
  const words = text.split(" ");
  const accWords = accent ? accent.split(" ").length : 0;
  return `<div class="big" style="font-size:${size}px;text-align:${align}">${words.map((w, i) => {
    const k = eo(prog(lt, s + i * 0.09, 0.7));
    const isAcc = accent && i >= words.length - accWords;
    const st = isAcc ? "color:oklch(0.7 0.18 304);" : "";
    return `<span class="word" style="opacity:${k};transform:translateY(${(1 - k) * 28}px);${st}">${esc(w)}</span>`;
  }).join(" ")}</div>`;
}
const desktopIcons = (lt) => [["renders", 0], ["final_final_v3.mp4", 1], ["b-roll", 0], ["notes.txt", 2]].map(([nm, k], i) => `<div class="abs" style="left:80px;top:${80 + i * 130}px;width:110px;text-align:center;${inn(lt, 0.1 + i * 0.08, 0.5)}">
  <div style="margin:0 auto;width:64px;height:${k === 0 ? 50 : 64}px;border-radius:${k === 0 ? 10 : 8}px;background:${k === 0 ? "#2a2a2a" : k === 1 ? "#1f1f1f" : "#262626"};box-shadow:var(--rim);${k === 1 ? thumb(0) : ""}"></div>
  <div class="meta" style="margin-top:8px">${nm}</div></div>`).join("");

function sIntro(lt, b) {
  const d = b.dur;
  let h = "", bg = { amt: 0.35, a: "grey", b: "blue" };
  const phrase = (s = 0.6, y = 820, size = 64) => (b.show ? `<div class="abs" style="left:0;top:${y}px;width:${W}px">${kinetic(b.show, lt, s, size, b.accent)}</div>` : "");
  if (b.visual === "cursor") {
    const mood = b.mood || "wander";
    let path;
    if (mood === "pace") path = (t) => [W / 2 + Math.sin(t * 3.2) * 420, 470 + Math.sin(t * 6.4) * 30];
    else if (mood === "shake") path = (t) => [W / 2 + (t > 0.6 ? Math.sin((t - 0.6) * 15) * 70 * Math.exp(-(t - 0.6) * 0.8) : 0), 470];
    else if (mood === "curious") path = kf([[0, 1500, 300], [1.6, 1100, 420], [2.4, 1060, 440], [3.4, 980, 470], [4.4, 960, 480], [7, 960, 480]]);
    else path = kf([[0, 1400, 760], [1.3, 900, 420], [2.2, 1250, 520], [3.0, 980, 470], [4.5, 960, 470]]);
    h += desktopIcons(lt);
    if (mood === "curious") h += `<div class="abs big" style="left:1060px;top:300px;font-size:140px;color:var(--subtle);${inn(lt, 2.6, 0.8)}">?</div>`;
    h += swingCursor(path, lt, 4.2, { L: 46, damp: mood === "shake" ? 1.6 : 2.6 });
    h += phrase(1.0, 800, 72);
    bg = { amt: 0.42, a: "grey", b: mood === "curious" ? "purple" : "blue", zoom: 2.0 };
  } else if (b.visual === "type") {
    h += `<div class="abs" style="left:160px;top:0;width:1600px;height:${H}px;display:flex;align-items:center;justify-content:center">${kinetic(b.show, lt, 0.2, 104, b.accent)}</div>`;
    bg = { amt: 0.22, a: "grey", b: "blue" };
  } else if (b.visual === "montage") {
    const k = prog(lt, 0, d);
    h += `<div class="abs" style="left:320px;top:150px;width:1280px;height:720px;border-radius:24px;border:2px dashed #3a3a3a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
      <div class="big" style="font-size:120px;letter-spacing:0.08em">MONTAGE</div><div class="meta" style="font-size:20px">Replace with the clips · ${d} s slot · gets louder</div>
      <div style="width:600px;height:6px;border-radius:99px;background:#262626;margin-top:20px;overflow:hidden"><div style="height:100%;width:${k * 100}%;background:#f5f5f5"></div></div></div>`;
    bg = { amt: 0.15 + 0.4 * k, a: "grey", b: "orange" };
  } else if (b.visual === "grid") {
    for (let i = 0; i < 12; i++) {
      const x = 180 + (i % 4) * 400, y = 110 + Math.floor(i / 4) * 250;
      h += `<div class="abs" style="left:${x}px;top:${y}px;width:360px;height:210px;border-radius:20px;${thumb(i)};${inn(lt, 0.1 + i * 0.06, 0.5)}">
        <span class="chip abs" style="right:12px;top:12px;color:var(--fg);opacity:${eo(prog(lt, 1.6 + i * 0.12, 0.3))};transform:scale(${1 + 0.3 * (1 - eo(prog(lt, 1.6 + i * 0.12, 0.3)))})">AI</span></div>`;
    }
    h = `<div style="opacity:${1 - 0.65 * eo(prog(lt, 2.6, 0.8))}">${h}</div>`;
    h += `<div class="abs" style="left:0;top:450px;width:${W}px">${kinetic(b.show, lt, 3.0, 120)}</div>`;
    const path = kf([[0, 1700, 900], [2.6, 1500, 700], [3.6, 1180, 600], [6, 1160, 610]]);
    h += swingCursor(path, lt, 3, { L: 46, damp: 2.4 });
    bg = { amt: 0.2 };
  } else if (b.visual === "pullback") {
    // gentle pull-back: one polished frame, slowly revealing it is one of many identical ones
    const k = eio(prog(lt, 0.2, d - 0.6));
    const sc = lerp(2.6, 0.62, k);
    let g = "";
    for (let r = -3; r <= 3; r++) for (let c = -4; c <= 4; c++) {
      const far = Math.hypot(r, c);
      g += `<div class="abs" style="left:${c * 400 - 180}px;top:${r * 240 - 105}px;width:360px;height:210px;border-radius:18px;${thumb(1, "")}opacity:${far === 0 ? 1 : clamp(k * 1.6 - far * 0.08)}"></div>`;
    }
    h += `<div class="abs" style="left:${W / 2}px;top:${H / 2}px;transform:scale(${sc})">${g}</div>`;
    h += `<div class="abs" style="left:0;top:0;width:${W}px;height:${H}px;background:radial-gradient(ellipse at center,transparent 30%,rgb(10 10 10/.85) 80%)"></div>`;
    h += `<div class="abs" style="left:0;top:880px;width:${W}px">${kinetic(b.show, lt, 2.2, 72)}</div>`;
    bg = { amt: 0 };
  } else if (b.visual === "dissolve") {
    const parts = b.show.split(" · ");
    h += `<div class="abs" style="left:0;top:380px;width:${W}px;display:flex;flex-direction:column;align-items:center;gap:10px">${parts.map((p, i) => {
      const k = eo(prog(lt, 0.4 + i * 0.9, 0.7)), out = eio(prog(lt, 4.2 + i * 0.5, 1.6));
      return `<div class="big" style="font-size:96px;opacity:${k * (1 - out * 0.85)};letter-spacing:${-0.035 + out * 0.25}em;filter:blur(${out * 6}px);transform:translateY(${(1 - k) * 24}px)">${esc(p)}</div>`;
    }).join("")}</div>`;
    bg = { amt: 0.18 };
  } else if (b.visual === "switch") {
    const ak = prog(lt, 1.6, 1.2);
    h += `<div class="abs card" style="left:330px;top:400px;width:480px;height:220px;display:flex;align-items:center;justify-content:center;font-size:52px;font-weight:600;${inn(lt, 0.3)}">Vegas Pro</div>
      <svg class="abs" style="left:830px;top:490px" width="260" height="40"><path d="M 10 20 L 240 20" stroke="#f5f5f5" stroke-width="3" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${1 - ak}"/><path d="M 226 8 L 240 20 L 226 32" fill="none" stroke="#f5f5f5" stroke-width="3" opacity="${ak}"/></svg>
      <div class="abs card" style="left:1110px;top:400px;width:480px;height:220px;display:flex;align-items:center;justify-content:center;font-size:52px;font-weight:600;${inn(lt, 2.4)}">DaVinci Resolve</div>
      <div class="abs meta" style="left:0;top:680px;width:${W}px;text-align:center;font-size:26px;${inn(lt, 3.4)}">Already hard enough once.</div>`;
    const path = kf([[0, 560, 800], [1.0, 600, 560], [2.8, 1320, 560], [3.6, 1340, 600], [6.5, 1340, 600]]);
    h += swingCursor(path, lt, 3, { L: 46, damp: 2.4 });
    bg = { amt: 0.2 };
  } else if (b.visual === "brand") {
    const fonts = [`font-family:"Inter Variable";font-weight:600`, `font-family:serif;font-style:italic;font-weight:400`, `font-family:var(--mono);font-weight:300`, `font-family:"Inter Variable";font-weight:200`, `font-family:serif;font-weight:700`];
    const settled = b.settled || lt > 3.8;
    const fi = settled ? 0 : Math.floor((lt - 0.8) / 0.6) + 1;
    const fnt = fonts[clamp(fi, 0, 99) % fonts.length];
    const k = b.settled ? 1 : eo(prog(lt, 0.6, 1.2));
    h += `<div class="abs" style="left:0;top:${b.settled ? 330 : 390}px;width:${W}px;text-align:center;font-size:220px;letter-spacing:-0.04em;line-height:1;opacity:${k};${fnt}">Chair</div>`;
    if (b.show) h += `<div class="abs" style="left:0;top:640px;width:${W}px">${kinetic(b.show, lt, 2.0, 56)}</div>`;
    if (b.settled) {
      const path = kf([[0, 2100, 900], [1.6, 1400, 560], [2.4, 1380, 570], [7, 1380, 570]]);
      h += swingCursor(path, lt, 2.6, { L: 46, damp: 2.4 });
    }
    bg = { amt: b.settled ? 0.18 : 0, a: "grey", b: "purple" };
  }
  return { html: h, bg };
}

function sOutro(lt, o) {
  let h = `<div class="abs" style="left:0;top:330px;width:${W}px;text-align:center;font-size:240px;font-weight:600;letter-spacing:-0.045em;line-height:1;${inn(lt, 0.2, 1.0, 30)}">${esc(o.word)}</div>
    <div class="abs" style="left:0;top:610px;width:${W}px">${kinetic(o.tagline, lt, 1.0, 48)}</div>
    <div class="abs" style="left:0;top:720px;width:${W}px;display:flex;justify-content:center;${inn(lt, 2.0)}"><span class="chip mono" style="height:48px;font-size:20px;padding:0 24px;color:var(--fg)">${esc(o.url)}</span></div>`;
  const path = kf([[0, 2100, 300], [1.8, 1480, 360], [2.5, 1460, 370], [7, 1460, 370]]);
  h += swingCursor(path, lt, 2.6, { L: 46, damp: 2.4 });
  return { html: h, bg: { amt: 0.3, a: "grey", b: "purple" } };
}

// ---------- timeline ----------
const SCENES = [];
for (const b of S.intro) SCENES.push({ dur: b.dur, draw: (lt) => sIntro(lt, b), name: "intro" });
const F = S.features, featureFns = [["flow", sFlow], ["copies", sCopies], ["resolve", sResolve], ["pieces", sPieces], ["shelf", sShelf], ["rig", sRig], ["sound", sSound], ["suggest", sSuggest], ["models", sModels]];
featureFns.forEach(([k, fn], i) => SCENES.push({ dur: F[k].dur, draw: (lt) => ({ html: fn(lt, F[k], i + 1), bg: { amt: 0.12, a: "grey", b: "blue", zoom: 1.6 } }), name: k }));
SCENES.push({ dur: S.outro.dur, draw: (lt) => sOutro(lt, S.outro), name: "outro" });
let acc = 0; for (const s of SCENES) { s.start = acc; acc += s.dur; }
window.__duration = acc;
window.__scenes = SCENES.map((s) => ({ name: s.name, start: s.start, dur: s.dur }));

const stage = document.getElementById("stage");
window.__seek = (t) => {
  let s = SCENES[SCENES.length - 1];
  for (const sc of SCENES) if (t < sc.start + sc.dur) { s = sc; break; }
  const lt = t - s.start;
  const env = Math.min(eo(lt / 0.45), clamp((s.dur - lt) / 0.35));
  const r = s.draw(lt);
  stage.innerHTML = `<div style="position:absolute;inset:0;opacity:${env}">${r.html}</div>`;
  drawBg(t, { ...r.bg, amt: r.bg.amt * env });
};
const q = new URLSearchParams(location.search);
window.__seek(parseFloat(q.get("t") || "0"));
if (q.has("play")) { const t0 = performance.now(); const loop = () => { window.__seek(((performance.now() - t0) / 1000) % acc); requestAnimationFrame(loop); }; loop(); }
})();
