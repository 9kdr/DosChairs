/** OGraf export for Chair effect specs. No runtime imports: this module must stay
 * loadable by plain node (type stripping) for the scripts/export-ograf.ts dev
 * script, so everything here is self-contained and only `import type` is used.
 *
 * `exportOGraf(spec)` returns the two files Resolve scans under
 * `.../Fusion/Templates/Edit/Titles/OGraf/`: a `.ograf.json` manifest whose
 * schema (Inspector controls) is generated from `spec.controls`, and a
 * self-contained `.js` web component embedding the Chair renderer + rig sim.
 *
 * Resolve drives OGraf titles non-realtime: it calls `goToTime(ms)` per frame,
 * so the component renders purely from time (curve evaluation + a baked rig
 * table). Shape/text/image layers draw on Canvas2D, which every host webview
 * has; shader layers need WebGL2 and draw a labelled placeholder when it is
 * unavailable. Mirrors `resolveFrame` in curves.ts and `simulateRig` in rig.ts.
 */
import type { Control, EffectSpec, ExportTarget } from "./types.js";

export interface OgrafBundle {
  /** File stem, e.g. `chair-bounce-title`. Files are `<stem>.ograf.json` + `<stem>.js`. */
  id: string;
  manifest: Record<string, unknown>;
  js: string;
}

const OGRAF_SCHEMA_URL =
  "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json";

/** Manifest id/file stem: lowercase kebab, no slashes (Resolve scans by file). */
export function ografId(spec: EffectSpec): string {
  const slug = String(spec.id || "effect")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `chair-${slug || "effect"}`;
}

/** Web-component class name derived from the spec id. Always a valid identifier. */
export function ografClassName(spec: EffectSpec): string {
  const parts = String(spec.id || "effect").split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return `Chair${name || "Effect"}Graphic`;
}

/**
 * Recommended export target, cheapest native option first: a shape/text-only
 * spec becomes a Fusion macro; a spec with a custom shader needs the web
 * title path (OGraf); image layers with external files fall back to a
 * rendered clip. A caller-set `spec.export.target` wins over this guess.
 */
export function selectExportTarget(spec: EffectSpec): ExportTarget {
  const layers = spec.layers ?? [];
  if (spec.shader || layers.some((l) => l.type === "shader")) return "ograf";
  if (layers.some((l) => l.type === "image")) return "rendered-clip";
  return "fusion-macro";
}

function titleCase(id: string): string {
  return id
    .split(/[-_]+/)
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Normalize to lowercase `#rrggbb`; fall back to white when unparseable. */
export function normalizeHexColor(v: unknown): string {
  if (typeof v !== "string") return "#ffffff";
  let h = v.startsWith("#") ? v.slice(1) : v;
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (/^[0-9a-fA-F]{6}$/.test(h)) return `#${h.toLowerCase()}`;
  return "#ffffff";
}

/**
 * One spec control to one OGraf schema property (Inspector control).
 * Fusion renders at most 20 dynamic parameters, so callers slice there.
 */
export function controlToSchema(control: Control): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: control.label || titleCase(control.id),
    default: control.default,
  };
  switch (control.type) {
    case "color":
      return {
        ...base,
        type: "string",
        gddType: "color-rrggbb",
        pattern: "^#[0-9a-f]{6}$",
        default: normalizeHexColor(control.default),
      };
    case "text":
      return { ...base, type: "string", default: String(control.default ?? "") };
    case "bool":
      return { ...base, type: "boolean", default: Boolean(control.default) };
    case "number":
    default: {
      const prop: Record<string, unknown> = {
        ...base,
        type: "number",
        default: isFiniteNumber(control.default) ? control.default : 0,
      };
      if (isFiniteNumber(control.min)) prop["minimum"] = control.min;
      if (isFiniteNumber(control.max)) prop["maximum"] = control.max;
      return prop;
    }
  }
}

/** Manifest for the sample: required OGraf fields generated from the spec. */
export function ografManifest(spec: EffectSpec): Record<string, unknown> {
  const id = ografId(spec);
  const properties: Record<string, unknown> = {};
  for (const control of (spec.controls ?? []).slice(0, 20)) {
    properties[control.id] = controlToSchema(control);
  }
  return {
    $schema: OGRAF_SCHEMA_URL,
    id,
    version: "1.0.0",
    name: spec.name || titleCase(spec.id),
    description: `Chair effect "${spec.name || spec.id}" exported as an OGraf title.`,
    author: { name: "Chair" },
    main: `${id}.js`,
    v_bmd: { duration: spec.durationSec },
    stepCount: 1,
    supportsRealTime: false,
    supportsNonRealTime: true,
    schema: { type: "object", additionalProperties: false, properties },
    renderRequirements: [
      {
        resolution: {
          width: { ideal: spec.width },
          height: { ideal: spec.height },
        },
        frameRate: { ideal: spec.fps },
        accessToPublicInternet: { ideal: false },
      },
    ],
  };
}

/**
 * Which layer the baked rig trajectory drives: the topmost layer with static
 * x/y (no x/y curves). Returns null when every layer animates x/y or the
 * spec has no rig. Documented heuristic: keep x/y curves off every layer but
 * the hero and the spring follows the hero.
 */
export function ografRigTarget(spec: EffectSpec): string | null {
  if (!spec.rig) return null;
  for (let i = spec.layers.length - 1; i >= 0; i--) {
    const layer = spec.layers[i]!;
    if (layer.curves?.["x"] || layer.curves?.["y"]) continue;
    return layer.id;
  }
  return null;
}

interface OgrafEmbeddedControl {
  id: string;
  default: unknown;
  layerId: string;
  param: string;
}

/** The spec data embedded in the component: plain JSON, no functions. */
function embeddedSpec(spec: EffectSpec): Record<string, unknown> {
  const controls: OgrafEmbeddedControl[] = (spec.controls ?? []).slice(0, 20).map((c) => ({
    id: c.id,
    default:
      c.type === "color"
        ? normalizeHexColor(c.default)
        : c.type === "bool"
          ? Boolean(c.default)
          : c.type === "text"
            ? String(c.default ?? "")
            : isFiniteNumber(c.default)
              ? c.default
              : 0,
    layerId: c.target.layerId,
    param: c.target.param,
  }));
  return {
    width: spec.width,
    height: spec.height,
    durationSec: spec.durationSec,
    fps: spec.fps,
    layers: spec.layers.map((l) => ({
      id: l.id,
      type: l.type,
      params: l.params ?? {},
      curves: l.curves ?? {},
      blend: l.blend ?? "normal",
      visible: l.visible ?? true,
    })),
    controls,
    shader: spec.shader
      ? { source: spec.shader.source, uniforms: spec.shader.uniforms ?? [] }
      : null,
    rig: spec.rig ?? null,
    rigTarget: ografRigTarget(spec),
  };
}

/**
 * Self-contained OGraf web component source. Embeds the spec data plus a
 * Canvas2D renderer (shape/text/image), a WebGL2 fullscreen pass for shader
 * layers with a labelled Canvas2D fallback, and a port of the fixed-step rig
 * sim baked at load. Pure function of time: no timers, no randomness.
 */
export function ografComponentJS(spec: EffectSpec): string {
  const data = embeddedSpec(spec);
  const defaults: Record<string, unknown> = {};
  for (const c of data["controls"] as OgrafEmbeddedControl[]) defaults[c.id] = c.default;
  const skeleton = `
const SPEC = __CHAIR_SPEC__;
const DEFAULTS = __CHAIR_DEFAULTS__;

function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

function num(v, fb) {
  return typeof v === 'number' && isFinite(v) ? v : fb;
}

function easeFor(u, kind) {
  const t = clamp(u, 0, 1);
  if (kind === 'easeIn') return t * t;
  if (kind === 'easeOut') return 1 - (1 - t) * (1 - t);
  if (kind === 'easeInOut') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  if (kind === 'hold') return 0;
  return t;
}

function evaluateCurve(curve, t) {
  const keys = curve.keyframes.slice().sort(function (a, b) { return a.time - b.time; });
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.time) return first.value;
  if (t >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span <= 0 ? 0 : (t - a.time) / span;
      return a.value + (b.value - a.value) * easeFor(u, a.easing);
    }
  }
  return last.value;
}

function rigTargetAt(path, t) {
  const keys = path.slice().sort(function (a, b) { return a.time - b.time; });
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.time) return { x: first.x, y: first.y };
  if (t >= last.time) return { x: last.x, y: last.y };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const u = span <= 0 ? 0 : (t - a.time) / span;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return { x: last.x, y: last.y };
}

function bakeRig(rig, fps) {
  const k = rig.stiffness != null ? rig.stiffness : 90;
  const m = rig.mass != null ? rig.mass : 1;
  let c = rig.damping != null ? rig.damping : 12;
  if (rig.overshoot === false) c = Math.max(c, 2 * Math.sqrt(k * m));
  const swingOn = rig.swing !== false;
  const tiltOn = rig.tilt !== false;
  const squashOn = rig.squash !== false;
  const end = Math.max.apply(null, rig.inputPath.map(function (p) { return p.time; }));
  const total = end + 1;
  const frames = Math.max(1, Math.round(total * fps));
  const sub = 4;
  const dt = 1 / fps / sub;
  let x = rig.inputPath[0].x;
  let y = rig.inputPath[0].y;
  let vx = 0;
  let vy = 0;
  let swing = 0;
  let swingV = 0;
  let squashImpulse = 0;
  let prevVy = 0;
  const out = [];
  for (let f = 0; f <= frames; f++) {
    const t = f / fps;
    for (let s = 0; s < sub; s++) {
      const st = Math.min(t + (s / sub) * (1 / fps), total);
      const tgt = rigTargetAt(rig.inputPath, st);
      const ax = (k * (tgt.x - x) - c * vx) / m;
      const ay = (k * (tgt.y - y) - c * vy) / m;
      vx += ax * dt;
      vy += ay * dt;
      x += vx * dt;
      y += vy * dt;
      const swingTarget = swingOn ? clamp(-vx * 0.0009, -0.5, 0.5) : 0;
      const sA = 120 * (swingTarget - swing) - 14 * swingV;
      swingV += sA * dt;
      swing += swingV * dt;
      if (squashOn && prevVy > 60 && vy <= 0 && st <= end + 0.001) {
        squashImpulse = Math.min(0.35, prevVy * 0.0004);
      }
      squashImpulse *= Math.exp(-6 * dt);
      prevVy = vy;
    }
    const speed = Math.sqrt(vx * vx + vy * vy);
    const stretch = squashOn ? Math.min(0.25, speed * 0.00012) : 0;
    const imp = squashOn ? squashImpulse : 0;
    out.push({
      t: t, x: x, y: y,
      rotation: (swingOn ? swing : 0) + (tiltOn ? clamp(vx * 0.00012, -0.3, 0.3) : 0),
      scaleX: 1 + stretch + imp,
      scaleY: 1 - stretch * 0.8 - imp * 0.9
    });
  }
  return out;
}

function sampleRig(table, t) {
  if (!table || !table.length) return null;
  let best = table[0];
  for (let i = 0; i < table.length; i++) {
    if (table[i].t <= t + 1e-9) best = table[i];
    else break;
  }
  return best;
}

function resolveLayers(t, state) {
  return SPEC.layers.map(function (layer) {
    const resolved = {};
    for (const key of Object.keys(layer.params)) resolved[key] = layer.params[key];
    for (const prop of Object.keys(layer.curves)) resolved[prop] = evaluateCurve(layer.curves[prop], t);
    for (const c of SPEC.controls) {
      if (c.layerId !== layer.id) continue;
      const raw = state[c.id];
      const v = raw === undefined || raw === null ? c.default : raw;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') resolved[c.param] = v;
    }
    return { id: layer.id, type: layer.type, blend: layer.blend, visible: layer.visible, resolved: resolved };
  });
}

function parseHex(fill) {
  if (typeof fill !== 'string') return [1, 1, 1];
  let h = fill.charAt(0) === '#' ? fill.slice(1) : '';
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [1, 1, 1];
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function compositeFor(blend) {
  if (blend === 'add') return 'lighter';
  if (blend === 'multiply') return 'multiply';
  if (blend === 'screen') return 'screen';
  return 'source-over';
}

const SHADER_VS = '#version 300 es\\nin vec2 aPos; out vec2 vUv;\\n' +
  'void main() { vUv = aPos; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }';

function drawShapeLayer(ctx, r) {
  const w = num(r.scaleX, 100);
  const h = num(r.scaleY, 100);
  const rgb = parseHex(r.fill);
  ctx.save();
  ctx.globalAlpha = num(r.opacity, 1);
  ctx.translate(num(r.x, SPEC.width / 2), num(r.y, SPEC.height / 2));
  ctx.rotate(num(r.rotation, 0));
  ctx.fillStyle = 'rgb(' + Math.round(rgb[0] * 255) + ',' + Math.round(rgb[1] * 255) + ',' + Math.round(rgb[2] * 255) + ')';
  if (r.kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

function drawTextLayer(ctx, r) {
  const str = String(r.string !== undefined && r.string !== null ? r.string : '');
  if (!str) return;
  const size = num(r.size, 48);
  ctx.save();
  ctx.globalAlpha = num(r.opacity, 1);
  ctx.translate(num(r.x, SPEC.width / 2), num(r.y, SPEC.height / 2));
  ctx.rotate(num(r.rotation, 0));
  ctx.font = size + 'px ' + String(r.font || 'sans-serif');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = String(r.fill || '#ffffff');
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

function drawImageLayer(ctx, r, img) {
  if (!img) return;
  const iw = num(img.naturalWidth || img.width, 0);
  const ih = num(img.naturalHeight || img.height, 0);
  if (!iw || !ih) return;
  const w = num(r.scaleX, iw);
  const h = num(r.scaleY, ih);
  ctx.save();
  ctx.globalAlpha = num(r.opacity, 1);
  ctx.translate(num(r.x, SPEC.width / 2), num(r.y, SPEC.height / 2));
  ctx.rotate(num(r.rotation, 0));
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawShaderFallback(ctx, count) {
  const W = SPEC.width;
  const H = SPEC.height;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#1a1d24';
  ctx.fillRect(40, H - 132, W - 80, 92);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#f5c542';
  ctx.font = '28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('WebGL2 unavailable: ' + count + ' shader layer(s) skipped', W / 2, H - 86);
  ctx.restore();
}

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
  return s;
}

function linkProgram(gl, vs, fs) {
  const v = compileShader(gl, gl.VERTEX_SHADER, vs);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
  return p;
}

function hexToVec3(str) {
  const rgb = parseHex(str);
  return rgb;
}

class __CHAIR_CLASS__ extends HTMLElement {
  constructor() {
    super();
    this._state = {};
    for (const k of Object.keys(DEFAULTS)) this._state[k] = DEFAULTS[k];
    this._initialData = {};
    this._schedule = [];
    this._currentStep = 0;
    this._rigTable = null;
    this._images = {};
    this._gl = null;
    this._glProg = null;
    this._warnedNoGL = false;
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host { position: absolute; inset: 0; display: block; overflow: hidden; }' +
      'canvas { position: absolute; inset: 0; width: 100%; height: 100%; }';
    this._base = document.createElement('canvas');
    this._base.width = SPEC.width;
    this._base.height = SPEC.height;
    root.appendChild(style);
    root.appendChild(this._base);
    this._ctx = this._base.getContext('2d');
    if (SPEC.shader) {
      this._overlay = document.createElement('canvas');
      this._overlay.width = SPEC.width;
      this._overlay.height = SPEC.height;
      root.appendChild(this._overlay);
    } else {
      this._overlay = null;
    }
  }

  async load(params) {
    const data = (params && params.data) || {};
    this._initialData = {};
    for (const k of Object.keys(data)) this._initialData[k] = data[k];
    this._state = {};
    for (const k of Object.keys(DEFAULTS)) this._state[k] = DEFAULTS[k];
    for (const k of Object.keys(this._initialData)) this._state[k] = this._initialData[k];
    this._schedule = [];
    this._currentStep = 0;
    if (SPEC.rig) {
      try {
        this._rigTable = bakeRig(SPEC.rig, SPEC.fps);
      } catch (e) {
        this._rigTable = null;
      }
    }
    const needFonts = [];
    const needImages = [];
    for (const layer of SPEC.layers) {
      if (layer.type === 'text') {
        const size = num(layer.params.size, 48);
        const font = String(layer.params.font || 'sans-serif');
        needFonts.push(size + 'px "' + font + '"');
      } else if (layer.type === 'image') {
        const src = String(layer.params.src || '');
        if (src) needImages.push(src);
      }
    }
    try {
      if (needFonts.length && document.fonts && document.fonts.load) {
        const seen = {};
        const jobs = [];
        for (const f of needFonts) {
          if (!seen[f]) {
            seen[f] = true;
            jobs.push(document.fonts.load(f));
          }
        }
        await Promise.all(jobs);
      }
    } catch (e) { /* system fallback stack still renders */ }
    try {
      const jobs = [];
      for (const src of needImages) {
        jobs.push(this._loadImage(src));
      }
      await Promise.all(jobs);
    } catch (e) { /* missing images skip their layer */ }
    this._setFrame(0);
    return { statusCode: 200 };
  }

  _loadImage(src) {
    const self = this;
    return new Promise(function (resolve) {
      try {
        if (typeof Image === 'undefined') return resolve();
        const img = new Image();
        img.onload = function () { self._images[src] = img; resolve(); };
        img.onerror = function () { resolve(); };
        img.src = src;
      } catch (e) {
        resolve();
      }
    });
  }

  async dispose() {
    try {
      if (this._base && this._base.remove) this._base.remove();
      if (this._overlay && this._overlay.remove) this._overlay.remove();
    } catch (e) { /* already detached */ }
    this._images = {};
    this._gl = null;
    this._glProg = null;
    this._ctx = null;
    return { statusCode: 200 };
  }

  async playAction(params) {
    const p = params || {};
    if (p.goto !== undefined && p.goto !== null) {
      this._currentStep = num(Number(p.goto), 1);
    } else {
      const delta = p.delta !== undefined && p.delta !== null ? Number(p.delta) : 1;
      this._currentStep = num(this._currentStep, 0) + (isFinite(delta) ? delta : 1);
    }
    if (this._currentStep < 1) this._currentStep = 1;
    this._setFrame(Math.min(0.5, SPEC.durationSec));
    return { statusCode: 200, currentStep: this._currentStep };
  }

  async stopAction(params) {
    this._currentStep = 0;
    this._setFrame(-1);
    return { statusCode: 200 };
  }

  async updateAction(params) {
    const data = (params && params.data) || {};
    for (const k of Object.keys(data)) this._state[k] = data[k];
    let hasUpdateInSchedule = false;
    for (const e of this._schedule) {
      if (e && e.action && e.action.type === 'updateAction') {
        hasUpdateInSchedule = true;
        break;
      }
    }
    if (!hasUpdateInSchedule) {
      for (const k of Object.keys(data)) this._initialData[k] = data[k];
    }
    return { statusCode: 200 };
  }

  async customAction(params) {
    return { statusCode: 200 };
  }

  async goToTime(payload) {
    const timestamp = payload && payload.timestamp != null ? payload.timestamp : 0;
    this._state = {};
    for (const k of Object.keys(DEFAULTS)) this._state[k] = DEFAULTS[k];
    for (const k of Object.keys(this._initialData)) this._state[k] = this._initialData[k];
    let lastPlay = null;
    let lastStop = null;
    for (const event of this._schedule) {
      if (!event || event.timestamp > timestamp) break;
      const type = event.action && event.action.type;
      const pdata = (event.action && event.action.params && event.action.params.data) || {};
      if (type === 'updateAction') {
        for (const k of Object.keys(pdata)) this._state[k] = pdata[k];
      } else if (type === 'playAction') {
        lastPlay = event.timestamp;
        lastStop = null;
        this._currentStep = 1;
      } else if (type === 'stopAction') {
        lastStop = event.timestamp;
        lastPlay = null;
        this._currentStep = 0;
      }
    }
    if (lastStop !== null) {
      this._setFrame(-1 + (timestamp - lastStop) / 1000);
    } else if (lastPlay !== null) {
      this._setFrame((timestamp - lastPlay) / 1000);
    } else {
      this._setFrame(timestamp / 1000);
    }
    return { statusCode: 200 };
  }

  async setActionsSchedule(payload) {
    this._schedule = (payload && payload.schedule) || [];
    return { statusCode: 200 };
  }

  _setFrame(seconds) {
    const dur = SPEC.durationSec;
    const base = this._ctx;
    if (base) {
      base.clearRect(0, 0, SPEC.width, SPEC.height);
    }
    if (this._overlay) {
      try {
        const octx = this._overlay.getContext('2d');
        if (octx) octx.clearRect(0, 0, SPEC.width, SPEC.height);
      } catch (e) { /* overlay is GL-driven */ }
    }
    if (this._currentStep === 0 || seconds < 0 || seconds > dur) return;
    const layers = resolveLayers(seconds, this._state);
    const rigSample = SPEC.rigTarget ? sampleRig(this._rigTable, seconds) : null;
    if (base) {
      for (const layer of layers) {
        if (layer.visible === false) continue;
        const r = layer.resolved;
        if (rigSample && layer.id === SPEC.rigTarget) {
          r.x = rigSample.x;
          r.y = rigSample.y;
          r.rotation = num(r.rotation, 0) + rigSample.rotation;
          r.scaleX = num(r.scaleX, 1) * rigSample.scaleX;
          r.scaleY = num(r.scaleY, 1) * rigSample.scaleY;
        }
        try {
          if (layer.type === 'shape') {
            base.globalCompositeOperation = compositeFor(layer.blend);
            drawShapeLayer(base, r);
          } else if (layer.type === 'text') {
            base.globalCompositeOperation = compositeFor(layer.blend);
            drawTextLayer(base, r);
          } else if (layer.type === 'image') {
            base.globalCompositeOperation = compositeFor(layer.blend);
            drawImageLayer(base, r, this._images[String(r.src || '')]);
          } else if (layer.type === 'shader') {
            continue;
          }
        } catch (e) { /* one bad layer never blanks the frame */ }
      }
      base.globalCompositeOperation = 'source-over';
      base.globalAlpha = 1;
    }
    const shaderLayers = layers.filter(function (l) { return l.type === 'shader' && l.visible !== false; });
    if (shaderLayers.length && SPEC.shader) {
      const drew = this._drawShader(seconds);
      if (!drew && base) drawShaderFallback(base, shaderLayers.length);
    }
  }

  _drawShader(tSeconds) {
    if (!this._overlay) return false;
    let gl = this._gl;
    if (!gl) {
      try {
        gl = this._overlay.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
      } catch (e) {
        gl = null;
      }
      this._gl = gl || null;
    }
    if (!gl) {
      if (!this._warnedNoGL) {
        this._warnedNoGL = true;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[chair-ograf] WebGL2 unavailable: shader layer(s) skipped');
        }
      }
      return false;
    }
    try {
      if (!this._glProg) {
        this._glProg = linkProgram(gl, SHADER_VS, SPEC.shader.source);
      }
      const prog = this._glProg;
      if (!prog) return false;
      gl.viewport(0, 0, SPEC.width, SPEC.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      const tLoc = gl.getUniformLocation(prog, 'uTime');
      if (tLoc) gl.uniform1f(tLoc, tSeconds);
      const rLoc = gl.getUniformLocation(prog, 'uResolution');
      if (rLoc) gl.uniform2f(rLoc, SPEC.width, SPEC.height);
      const bound = {};
      for (const u of SPEC.shader.uniforms || []) bound[u.name] = u.controlId;
      for (const uname of Object.keys(bound)) {
        const loc = gl.getUniformLocation(prog, uname);
        if (!loc) continue;
        const raw = this._state[bound[uname]];
        const v = raw === undefined || raw === null ? DEFAULTS[bound[uname]] : raw;
        if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (typeof v === 'boolean') gl.uniform1f(loc, v ? 1 : 0);
        else if (typeof v === 'string' && v.charAt(0) === '#') {
          const c = hexToVec3(v);
          gl.uniform3f(loc, c[0], c[1], c[2]);
        }
      }
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.deleteBuffer(buf);
      return true;
    } catch (e) {
      return false;
    }
  }
}
`;
  const withSpec = skeleton
    .replace("__CHAIR_SPEC__", () => JSON.stringify(data))
    .replace("__CHAIR_DEFAULTS__", () => JSON.stringify(defaults))
    .replace("__CHAIR_CLASS__", () => ografClassName(spec));
  const header =
    "'use strict';\n" +
    "// Chair OGraf export of effect " +
    JSON.stringify(spec.id) +
    ". Deterministic non-realtime title: renders purely from goToTime(ms).\n";
  return header + withSpec + "\nexport default " + ografClassName(spec) + ";\n";
}

/** Both files Resolve scans: `<id>.ograf.json` manifest + `<id>.js` component. */
export function exportOGraf(spec: EffectSpec): OgrafBundle {
  return {
    id: ografId(spec),
    manifest: ografManifest(spec),
    js: ografComponentJS(spec),
  };
}
