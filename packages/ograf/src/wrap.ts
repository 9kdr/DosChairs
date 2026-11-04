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
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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
  /** Extra JSON payload passed as the component's `data` prop. */
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

class __WRAP_CLASS__ extends HTMLElement {
  constructor() {
    super();
    this._props = {};
    for (const k of Object.keys(DEFAULTS)) this._props[k] = DEFAULTS[k];
    this._t = 0;
    this._frame = 0;
    this._root = null;
    this._schedule = [];
    this._currentStep = 0;
    this._primed = false;
    const shadow = this.attachShadow({ mode: 'open' });
    this._mount = document.createElement('div');
    this._mount.style.cssText = 'position:absolute;inset:0;';
    shadow.appendChild(this._mount);
  }

  _render() {
    const element = React.createElement(Component, {
      ...this._props,
      data: DATA,
      t: this._t,
      frame: this._frame,
    });
    if (!this._root) this._root = createRoot(this._mount);
    flushSync(() => {
      this._root.render(element);
    });
  }

  async load(params) {
    const data = (params && params.data) || {};
    this._props = {};
    for (const k of Object.keys(DEFAULTS)) this._props[k] = DEFAULTS[k];
    for (const k of Object.keys(data)) this._props[k] = data[k];
    this._schedule = [];
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
    this._t = Math.min(0.5, __WRAP_DURATION__);
    this._frame = Math.round(this._t * FPS);
    this._render();
    return { statusCode: 200, currentStep: this._currentStep };
  }

  async stopAction(params) {
    this._currentStep = 0;
    this._primed = true;
    this._hide();
    return { statusCode: 200 };
  }

  async updateAction(params) {
    const data = (params && params.data) || {};
    for (const k of Object.keys(data)) this._props[k] = data[k];
    this._render();
    return { statusCode: 200 };
  }

  async customAction(params) {
    return { statusCode: 200 };
  }

  async goToTime(payload) {
    const timestamp = payload && payload.timestamp != null ? payload.timestamp : 0;
    let lastPlay = null;
    let lastStop = null;
    for (const event of this._schedule) {
      if (!event || event.timestamp > timestamp) break;
      const type = event.action && event.action.type;
      const pdata = (event.action && event.action.params && event.action.params.data) || {};
      if (type === 'updateAction') {
        for (const k of Object.keys(pdata)) this._props[k] = pdata[k];
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
    let seconds;
    if (lastStop !== null) seconds = -1 + (timestamp - lastStop) / 1000;
    else if (lastPlay !== null) seconds = (timestamp - lastPlay) / 1000;
    else seconds = timestamp / 1000;
    const dur = __WRAP_DURATION__;
    if (seconds < 0 || seconds > dur) {
      this._hide();
      return { statusCode: 200 };
    }
    if (this._currentStep === 0 && this._primed) {
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
    this._schedule = (payload && payload.schedule) || [];
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
  const nodePaths = [dirname(opts.entry), join(here, "..", "node_modules"), join(process.cwd(), "node_modules")];
  const source = host
    .replace("__WRAP_ENTRY__", () => JSON.stringify(opts.entry))
    .replace("__WRAP_DATA__", () => JSON.stringify(opts.data ?? null))
    .replace("__WRAP_DEFAULTS__", () => JSON.stringify(propDefaultsOf(opts.props)))
    .replace(/__WRAP_FPS__/g, () => JSON.stringify(fps))
    .replace(/__WRAP_DURATION__/g, () => JSON.stringify(opts.durationSec))
    .replace(/__WRAP_CLASS__/g, () => className);
  await writeFile(hostPath, source, "utf8");
  const built = await build({
    entryPoints: [hostPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome90"],
    jsx: "automatic",
    minify: true,
    write: false,
    nodePaths,
    logLevel: "warning",
  });
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
