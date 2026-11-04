/**
 * The probe: runs inside a throwaway node process (permission model on: no
 * file writes, no child processes, no workers). It imports the module's
 * bundle, reads `meta` and `props`, and renders frames with react-dom/server
 * to check the contract. It prints one JSON report line.
 *
 * Source text only: this file is bundled together with the module under test
 * by bundle.ts (entry import swapped in via the `chair-module-under-test` alias).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error resolved by the bundler alias to the module under test
import * as Mod from "chair-module-under-test";
import { describeCovers, extractText } from "./scope.js";
import { STANDARD_SWITCH_PROPS, StandardBg } from "../kit/standardBg.js";

type Json = number | string | boolean | null | Json[] | { [k: string]: Json };
type History = (name: string, t: number) => number | string | boolean | undefined;

interface RawProp {
  type?: string;
  default?: unknown;
  min?: number;
  max?: number;
}

const report: {
  meta: unknown;
  props: unknown;
  errors: string[];
  warnings: string[];
  checks: Record<string, boolean | number>;
  scope: { covers: string[]; text: string };
} = { meta: null, props: null, errors: [], warnings: [], checks: {}, scope: { covers: [], text: "" } };

function done(): void {
  process.stdout.write(`\n@@CHAIR_PROBE@@${JSON.stringify(report)}\n`);
}

try {
  const meta = (Mod as Record<string, unknown>)["meta"] as { durationSec?: number; fps?: number; width?: number; height?: number; kind?: string } | undefined;
  const rawProps = (Mod as Record<string, unknown>)["props"] as Record<string, RawProp> | undefined;
  const Effect = (Mod as Record<string, unknown>)["default"] as ((p: Record<string, unknown>) => React.ReactNode) | undefined;
  // The standard switch rides along on every non-background piece; the kit
  // wins on a collision so the ids stay the same everywhere.
  const stdSwitch = meta?.kind !== "background";
  const props = (stdSwitch && rawProps && typeof rawProps === "object"
    ? { ...rawProps, ...STANDARD_SWITCH_PROPS }
    : rawProps) as Record<string, RawProp> | undefined;
  report.meta = (meta ?? null) as Json;
  report.props = (props ?? null) as Json;
  if (typeof Effect !== "function") {
    report.errors.push("the module must `export default` the Effect function component");
  } else if (meta && props && typeof meta === "object" && typeof props === "object") {
    const Rendered = stdSwitch
      ? (p: Record<string, unknown>) => StandardBg({
          t: p["t"] as number,
          history: p["history"] as History,
          children: Effect(p),
        })
      : Effect;
    probeFrames(Rendered, meta, props);
  }
} catch (error) {
  report.errors.push(`module failed to load: ${error instanceof Error ? error.message : String(error)}`);
}
done();

function probeFrames(
  Effect: (p: Record<string, unknown>) => React.ReactNode,
  meta: { durationSec?: number; fps?: number; width?: number; height?: number },
  props: Record<string, RawProp>,
): void {
  const dur = typeof meta.durationSec === "number" && meta.durationSec > 0 ? meta.durationSec : 5;
  const fps = typeof meta.fps === "number" && meta.fps > 0 ? meta.fps : 30;
  const width = typeof meta.width === "number" ? meta.width : 1920;
  const height = typeof meta.height === "number" ? meta.height : 1080;
  const ids = Object.keys(props);

  const defaults: Record<string, unknown> = {};
  for (const id of ids) defaults[id] = props[id]!.default;

  // Two histories: every prop held at its default, and every number swept
  // along a piecewise-linear keyframe path across the whole duration.
  const constant: History = (name) => defaults[name] as number | string | boolean | undefined;
  const swept: History = (name, t) => {
    const spec = props[name];
    const def = defaults[name];
    if (!spec || spec.type !== "number" || typeof def !== "number") return def as number | string | boolean | undefined;
    const lo = typeof spec.min === "number" ? spec.min : def - 1;
    const hi = typeof spec.max === "number" ? spec.max : def + 1;
    const phase = (Math.max(0, t) / dur) * 3;
    const k = Math.floor(phase);
    const f = phase - k;
    const stops = [0.2, 0.8, 0.35, 0.65];
    const a = stops[k % 4]!;
    const b = stops[(k + 1) % 4]!;
    return lo + (hi - lo) * (a + (b - a) * f);
  };

  const render = (history: History, t: number, override: Record<string, unknown> = {}): string => {
    const current: Record<string, unknown> = {};
    for (const id of ids) current[id] = history(id, t);
    return renderToStaticMarkup(
      React.createElement(Effect as React.FunctionComponent<Record<string, unknown>>, {
        ...current,
        ...override,
        t,
        frame: Math.round(t * fps),
        fps,
        width,
        height,
        history,
      }),
    );
  };

  const times = [0, dur * 0.1, dur * 0.35, dur * 0.5, dur * 0.8, dur];
  let identical = true;
  let animates = false;
  let slowest = 0;
  for (const [label, history] of [["constant", constant], ["swept", swept]] as const) {
    const first = new Map<number, string>();
    const timed = (t: number): string => {
      const start = process.hrtime.bigint();
      const html = render(history, t);
      slowest = Math.max(slowest, Number(process.hrtime.bigint() - start) / 1e6);
      return html;
    };
    for (const t of times) first.set(t, timed(t));
    // Seek backwards through the same times, then jump away and straight back.
    let drifted = false;
    for (const t of [...times].reverse()) {
      if (!drifted && timed(t) !== first.get(t)) {
        drifted = true;
        report.errors.push(`not deterministic (${label} history): the frame at t=${t.toFixed(2)}s changed after seeking elsewhere; it must depend only on props, history, and t (no module-level state, refs read during render, or clocks)`);
      }
    }
    const probe = times[3]!;
    timed(times[1]!);
    if (!drifted && timed(probe) !== first.get(probe)) {
      drifted = true;
      report.errors.push(`not deterministic (${label} history): seek away and back changed the frame at t=${probe.toFixed(2)}s`);
    }
    if (drifted) identical = false;
    if (new Set(first.values()).size > 1) animates = true;
  }
  report.checks["deterministic"] = identical;
  report.checks["animates"] = animates;
  report.checks["slowestFrameMs"] = Math.round(slowest * 10) / 10;
  if (!animates) report.warnings.push("frames never changed over time with default or swept props: nothing animates");
  if (slowest > 2000) report.errors.push(`a frame took ${Math.round(slowest)} ms to render; keep physics and loops cheap (Resolve renders every frame)`);
  else if (slowest > 250) report.warnings.push(`slowest frame ${Math.round(slowest)} ms; Resolve renders every frame, keep it cheap`);

  // Scope facts from one mid frame: full-frame opaque fills and visible text.
  // The bundler turns these into errors when the brief asked for neither.
  const midHtml = render(swept, dur * 0.5);
  report.scope = { covers: describeCovers(midHtml), text: extractText(midHtml) };

  // Every Inspector control should do something to the frame.
  const mid = dur * 0.5;
  const inert: string[] = [];
  for (const id of ids) {
    const spec = props[id]!;
    let alt: unknown;
    if (spec.type === "number") {
      const lo = typeof spec.min === "number" ? spec.min : (spec.default as number) - 1;
      const hi = typeof spec.max === "number" ? spec.max : (spec.default as number) + 1;
      alt = (spec.default as number) === hi ? lo : hi;
    } else if (spec.type === "color") alt = spec.default === "#00ff00" ? "#ff00ff" : "#00ff00";
    else if (spec.type === "boolean" || spec.type === "bool") alt = !(spec.default as boolean);
    else alt = `${String(spec.default)} X`;
    const overridden: History = (name, t) => (name === id ? (alt as number) : swept(name, t));
    if (render(overridden, mid, { [id]: alt }) === render(swept, mid)) inert.push(id);
  }
  report.checks["inertProps"] = inert.length;
  if (inert.length > 0) {
    report.warnings.push(`props with no visible effect in server-rendered frames: ${inert.join(", ")} (fine if they only drive canvas painting, otherwise wire them up)`);
  }
}
