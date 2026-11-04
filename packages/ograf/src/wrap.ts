/**
 * Generic OGraf wrapper: turn a React component or a ready-made web component
 * into an OGraf title package ({manifest, js}) that Resolve loads from
 * Effects > Titles > OGraf.
 *
 * Contract the wrapper guarantees: time flows in through goToTime(ms) and the
 * frame re-renders synchronously from (props, t) — no timers, no
 * requestAnimationFrame, no playback state. The *component* must hold up its
 * end (pure render of props + t); the host never hands it a clock.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import type { OgrafProp } from "./props.js";
import { normalizeHexColor } from "./props.js";
import { manifestForOgarf, ografClassName, ografSlug } from "./manifest.js";

export interface OgrafBundle {
  /** File stem: `<id>.ograf.json` + `<id>.js`. */
  id: string;
  manifest: Record<string, unknown>;
  js: string;
}

export interface WrapReactOptions {
  id: string;
  name: string;
  description?: string;
  durationSec: number;
  fps?: number;
  width?: number;
  height?: number;
  /** File exporting the component as its default export (.tsx/.ts/.jsx/.js). */
  entry: string;
  /** Inspector props: become manifest schema, passed to the component. */
  props?: OgrafProp[];
  /** Extra esbuild plugins (import allow-list, aliases) for the bundle step. */
  plugins?: Plugin[];
  /** Extra folders searched for bare imports, after the entry's own folder. */
  nodePaths?: string[];
  /**
   * Extra JSON payload passed as the component's `data` prop. A
   * `data.keyframes` table (`{ propId: [[seconds, value], ...] }`) is the
   * baked fallback for `history()` when the host sends no updateAction
   * events: numbers interpolate linearly, anything else holds.
   */
  data?: unknown;
}

export interface WrapElementOptions {
  id: string;
  name: string;
  description?: string;
  durationSec: number;
  fps?: number;
  width?: number;
  height?: number;
  /** File default-exporting an HTMLElement subclass with the 8 OGraf methods. */
  entry: string;
  props?: OgrafProp[];
}

const OGRAF_METHODS = [
  "load",
  "dispose",
  "playAction",
  "stopAction",
  "updateAction",
  "customAction",
  "goToTime",
  "setActionsSchedule",
];

/**
 * Bundle a React component as an OGraf title. The component receives
 * `{...inspectorProps, data, t, frame}` where `t` is seconds and `frame` the
 * frame number at `fps`; goToTime re-renders synchronously via flushSync, so
 * every call paints the frame for exactly that timestamp.
 */
export async function wrapReactComponent(opts: WrapReactOptions): Promise<OgrafBundle> {
  const fps = opts.fps ?? 30;
  const className = ografClassName(opts.id);
  const host = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Component from __WRAP_ENTRY__;
const DATA = __WRAP_DATA__;
const DEFAULTS = __WRAP_DEFAULTS__;
const FPS = __WRAP_FPS__;
const WIDTH = __WRAP_WIDTH__;
const HEIGHT = __WRAP_HEIGHT__;
const BAKED = (DATA && typeof DATA === 'object' && DATA.keyframes && typeof DATA.keyframes === 'object') ? DATA.keyframes : {};

function sampleBaked(table, t) {
  if (!Array.isArray(table) || table.length === 0) return undefined;
  const first = table[0];
  const last = table[table.length - 1];
  if (t <= first[0]) return first[1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (t >= a[0] && t <= b[0]) {
      if (typeof a[1] === 'number' && typeof b[1] === 'number') {
        const u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * u;
      }
      return a[1];
    }
  }
  return last[1];
}

class __WRAP_CLASS__ extends HTMLElement {
  constructor() {
    super();
    this._baseline = {};
    this._t = 0;
    this._frame = 0;
    this._root = null;
    this._schedule = [];
    this._updates = [];
    this._origin = 0;
    this._liveStep = 0;
    this._currentStep = 0;
    this._primed = false;
    this._history = (name, t) => this._hist(name, t);
    const shadow = this.attachShadow({ mode: 'open' });
    this._mount = document.createElement('div');
    this._mount.style.cssText = 'position:absolute;inset:0;';
    shadow.appendChild(this._mount);
  }

  // A prop's value at component time t (seconds since play): the last
  // scheduled updateAction at or before it (sample-and-hold), else the baked
  // keyframe table, else the load/Inspector baseline, else the default. It
  // reads only the stored schedule, never call order, so any seek order and
  // any earlier time give the same answer.
  _hist(name, t) {
    const at = this._origin + t * 1000;
    let found = false;
    let value;
    for (const u of this._updates) {
      if (u.timestamp > at) break;
      if (Object.prototype.hasOwnProperty.call(u.data, name)) {
        found = true;
        value = u.data[name];
      }
    }
    if (found) return value;
    if (Object.prototype.hasOwnProperty.call(BAKED, name)) {
      const baked = sampleBaked(BAKED[name], t);
      if (baked !== undefined) return baked;
    }
    if (Object.prototype.hasOwnProperty.call(this._baseline, name)) return this._baseline[name];
    return DEFAULTS[name];
  }

  _propsAt(t) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = this._hist(k, t);
    return out;
  }

  _render() {
    const element = React.createElement(Component, {
      ...this._propsAt(this._t),
      data: DATA,
      t: this._t,
      frame: this._frame,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      history: this._history,
    });
    if (!this._root) this._root = createRoot(this._mount);
    flushSync(() => {
      this._root.render(element);
    });
  }

  async load(params) {
    const data = (params && params.data) || {};
    this._baseline = {};
    for (const k of Object.keys(data)) this._baseline[k] = data[k];
    this._schedule = [];
    this._updates = [];
    this._origin = 0;
    this._liveStep = 0;
    this._currentStep = 0;
    this._primed = false;
    this._t = 0;
    this._frame = 0;
    this._render();
    return { statusCode: 200 };
  }

  _hide() {
    if (this._root) {
      const self = this;
      flushSync(() => {
        self._root.render(null);
      });
    }
  }

  async dispose() {
    try {
      if (this._root) this._root.unmount();
    } catch (e) { /* already gone */ }
    this._root = null;
    return { statusCode: 200 };
  }

  async playAction(params) {
    const p = params || {};
    this._primed = true;
    if (p.goto !== undefined && p.goto !== null) {
      this._currentStep = Number(p.goto) || 0;
    } else {
      const delta = p.delta !== undefined && p.delta !== null ? Number(p.delta) : 1;
      this._currentStep = this._currentStep + (isFinite(delta) ? delta : 1);
    }
    if (this._currentStep < 1) this._currentStep = 1;
    this._liveStep = this._currentStep;
    this._t = Math.min(0.5, __WRAP_DURATION__);
    this._frame = Math.round(this._t * FPS);
    this._render();
    return { statusCode: 200, currentStep: this._currentStep };
  }

  async stopAction(params) {
    this._currentStep = 0;
    this._liveStep = 0;
    this._primed = true;
    this._hide();
    return { statusCode: 200 };
  }

  async updateAction(params) {
    const data = (params && params.data) || {};
    // Inspector edits live in the baseline so every later seek keeps them,
    // unless the schedule carries its own updateAction events (then those
    // replay the values and the baseline stays the load-time state).
    if (this._updates.length === 0) {
      for (const k of Object.keys(data)) this._baseline[k] = data[k];
    }
    this._render();
    return { statusCode: 200 };
  }

  async customAction(params) {
    return { statusCode: 200 };
  }

  async goToTime(payload) {
    const timestamp = payload && payload.timestamp != null ? payload.timestamp : 0;
    // Every seek rebuilds from the stored schedule: the play/stop state comes
    // from the live lifecycle calls plus the events up to this timestamp,
    // the prop values come from history. Nothing carries over from the
    // previous goToTime, so any call order paints the same frame.
    let step = this._liveStep;
    let lastPlay = null;
    let lastStop = null;
    for (const event of this._schedule) {
      if (!event || event.timestamp > timestamp) break;
      const type = event.action && event.action.type;
      if (type === 'playAction') {
        lastPlay = event.timestamp;
        lastStop = null;
        step = 1;
      } else if (type === 'stopAction') {
        lastStop = event.timestamp;
        lastPlay = null;
        step = 0;
      }
    }
    let seconds;
    if (lastStop !== null) seconds = -1 + (timestamp - lastStop) / 1000;
    else if (lastPlay !== null) seconds = (timestamp - lastPlay) / 1000;
    else seconds = timestamp / 1000;
    this._origin = lastPlay !== null ? lastPlay : 0;
    const dur = __WRAP_DURATION__;
    if (seconds < 0 || seconds > dur) {
      this._currentStep = step;
      this._hide();
      return { statusCode: 200 };
    }
    if (step === 0 && this._primed) {
      this._currentStep = step;
      this._hide();
      return { statusCode: 200 };
    }
    // No play, stop, or schedule ever arrived: a seek-only host still gets
    // the frame. Hosts that follow the lifecycle (Resolve calls playAction
    // on load) never take this path, so contracted behavior is unchanged.
    this._currentStep = 1;
    this._t = seconds;
    this._frame = Math.round(seconds * FPS);
    this._render();
    return { statusCode: 200 };
  }

  async setActionsSchedule(payload) {
    this._schedule = ((payload && payload.schedule) || []).slice().sort((a, b) => a.timestamp - b.timestamp);
    this._updates = [];
    for (const event of this._schedule) {
      if (event && event.action && event.action.type === 'updateAction') {
        const data = (event.action.params && event.action.params.data) || {};
        this._updates.push({ timestamp: event.timestamp, data });
      }
    }
    if (this._schedule.length > 0) this._primed = true;
    return { statusCode: 200 };
  }
}

export default __WRAP_CLASS__;
`;
  const dir = await mkdtemp(join(tmpdir(), "chair-ograf-"));
  const hostPath = join(dir, "host.tsx");
  // The host file lives in a temp dir, so bare imports (react, …) would not
  // resolve from there: search from the entry first, then this package, then
  // the caller's working tree.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const nodePaths = [
    dirname(opts.entry),
    ...(opts.nodePaths ?? []),
    join(here, "..", "node_modules"),
    join(process.cwd(), "node_modules"),
  ];
  const source = host
    .replace("__WRAP_ENTRY__", () => JSON.stringify(opts.entry))
    .replace("__WRAP_DATA__", () => JSON.stringify(opts.data ?? null))
    .replace("__WRAP_DEFAULTS__", () => JSON.stringify(propDefaultsOf(opts.props)))
    .replace(/__WRAP_FPS__/g, () => JSON.stringify(fps))
    .replace(/__WRAP_WIDTH__/g, () => JSON.stringify(opts.width ?? 1920))
    .replace(/__WRAP_HEIGHT__/g, () => JSON.stringify(opts.height ?? 1080))
    .replace(/__WRAP_DURATION__/g, () => JSON.stringify(opts.durationSec))
    .replace(/__WRAP_CLASS__/g, () => className);
  let built;
  try {
    await writeFile(hostPath, source, "utf8");
    built = await build({
      entryPoints: [hostPath],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["chrome90"],
      jsx: "automatic",
      minify: true,
      write: false,
      nodePaths,
      plugins: opts.plugins ?? [],
      logLevel: "warning",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const js = built.outputFiles?.[0]?.text ?? "";
  if (!js) throw new Error(`wrapReactComponent: esbuild produced no output for ${opts.entry}.`);
  for (const method of ["goToTime", "setActionsSchedule"]) {
    if (!js.includes(method)) {
      throw new Error(`wrapReactComponent: bundled output lost ${method}; refusing a dead title.`);
    }
  }
  const id = ografSlug(opts.id);
  const manifest = manifestForOgarf({ ...opts, props: opts.props ?? [] });
  return { id, manifest, js };
}

/**
 * Bundle a ready-made web component. The entry default-exports the element
 * class with the 8 OGraf methods; bundling only resolves its imports. The
 * class must not self-register (no customElements.define): Resolve registers
 * the default export itself.
 */
export async function wrapCustomElement(opts: WrapElementOptions): Promise<OgrafBundle> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const built = await build({
    entryPoints: [opts.entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome90"],
    minify: true,
    write: false,
    nodePaths: [dirname(opts.entry), join(here, "..", "node_modules"), join(process.cwd(), "node_modules")],
    logLevel: "warning",
  });
  const js = built.outputFiles?.[0]?.text ?? "";
  if (!js) throw new Error(`wrapCustomElement: esbuild produced no output for ${opts.entry}.`);
  const missing = OGRAF_METHODS.filter((m) => !js.includes(m));
  if (missing.length > 0) {
    throw new Error(
      `wrapCustomElement: ${opts.entry} looks unfinished, bundle misses ${missing.join(", ")}.`,
    );
  }
  const id = ografSlug(opts.id);
  const manifest = manifestForOgarf({ ...opts, props: opts.props ?? [] });
  return { id, manifest, js };
}

function propDefaultsOf(props: OgrafProp[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of props ?? []) {
    out[prop.id] = prop.type === "color" ? normalizeHexColor(prop.default) : prop.default;
  }
  return out;
}
