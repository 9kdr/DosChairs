import { describe, expect, it } from "vitest";
import type { EffectSpec } from "@chair/effects";
import { applyChangesetItem, emptyTimeline, invertItem, type Timeline } from "@chair/timeline-ir";
import { advanceMirror, tryHistoryEntry } from "../project/store";
import { bakedPayload, bakeRig, defaultControls, effectItem, exportInfo, rigOf, rigTargetId, stamp } from "./effect-model";
import { sampleEffect } from "./effects-api";

describe("sample effect", () => {
  it("loads the bundled bouncing title with a rig and two controls", () => {
    const spec = sampleEffect();
    expect(spec.id).toBe("bounce-title");
    expect(rigOf(spec)).not.toBeNull();
    expect(defaultControls(spec)).toEqual({ "ball-color": "#ffb000", "title-text": "Hello, Chair" });
    expect(rigTargetId(spec)).toBe("ball");
  });
});

describe("bakeRig", () => {
  it("bakes the rig onto the target layer and counts the keys", () => {
    const spec = sampleEffect();
    const bake = bakeRig(spec, rigOf(spec));
    expect(bake.keys).toBeGreaterThan(4);
    expect(bake.frames).toBeGreaterThan(30);
    const ball = bake.spec.layers.find((layer) => layer.id === "ball")!;
    expect(ball.curves?.["x"]?.keyframes.length).toBeGreaterThan(1);
    // The original spec is never mutated.
    expect(spec.layers.find((layer) => layer.id === "ball")!.curves?.["y"]?.keyframes).toHaveLength(8);
  });

  it("re-simulates: a stiffer spring bakes a different curve than a soft one", () => {
    const spec = sampleEffect();
    const soft = bakeRig(spec, { ...rigOf(spec)!, stiffness: 20, damping: 4 });
    const stiff = bakeRig(spec, { ...rigOf(spec)!, stiffness: 300, damping: 30 });
    expect(JSON.stringify(soft.spec.layers)).not.toBe(JSON.stringify(stiff.spec.layers));
  });

  it("leaves a spec without a rig alone", () => {
    const spec: EffectSpec = { ...sampleEffect(), rig: undefined };
    const bake = bakeRig(spec, null);
    expect(bake).toEqual({ spec, keys: 0, frames: 0 });
  });
});

describe("exportInfo", () => {
  it("explains a fusion macro in plain words", () => {
    const info = exportInfo(sampleEffect());
    expect(info).toMatchObject({ target: "fusion-macro", label: "Fusion macro", fallback: false });
    expect(info.reason).toMatch(/editable macro/);
  });

  it("surfaces the spec's fallback reason", () => {
    const spec: EffectSpec = {
      ...sampleEffect(),
      export: { target: "rendered-clip", fallback: { capability: "native Fusion nodes", reason: "Needs custom GLSL." } },
    };
    expect(exportInfo(spec)).toMatchObject({ label: "Rendered clip", reason: "Needs custom GLSL.", fallback: true });
  });
});

describe("effectItem", () => {
  const timeline: Timeline = (() => {
    const base = emptyTimeline("t", "Cut");
    base.tracks[0]!.clips.push({
      id: "clip-1",
      name: "Interview",
      sourceRange: { start: { value: 0, rate: 24 }, duration: { value: 48, rate: 24 } },
      timelineRange: { start: { value: 0, rate: 24 }, duration: { value: 48, rate: 24 } },
    });
    return base;
  })();

  it("builds an add_effect item with a specRef that inverts to remove_effect", () => {
    const spec = sampleEffect();
    const item = effectItem({ spec, controls: { "ball-color": "#ff0000" }, targetId: "clip-1", bakedKeys: 12, now: 1 });
    expect(item).toMatchObject({ op: "add_effect", targetId: "clip-1", specRef: "bounce-title", status: "pending" });
    expect(item.patch).toMatchObject({ presetName: "Bouncing title", params: { "ball-color": "#ff0000", rigKeys: 12, exportTarget: "fusion-macro" } });
    const inverted = invertItem(item, timeline);
    expect(inverted).toMatchObject({ ok: true, inverse: { op: "remove_effect", targetId: "clip-1" } });
  });

  it("lands on a copy of the mirror, never the original timeline", () => {
    const item = effectItem({ spec: sampleEffect(), controls: {}, targetId: "clip-1", bakedKeys: 0, now: 2 });
    const copy = structuredClone(timeline);
    applyChangesetItem(copy, { ...item, status: "accepted" });
    expect(copy.tracks[0]!.clips[0]!.effects).toHaveLength(1);
    expect(timeline.tracks[0]!.clips[0]!.effects).toBeUndefined();
  });
});

describe("apply pipeline", () => {
  it("makes a history entry that rewinds the effect again", () => {
    const base = emptyTimeline("t", "Cut");
    base.tracks[0]!.clips.push({
      id: "clip-1",
      name: "Interview",
      sourceRange: { start: { value: 0, rate: 24 }, duration: { value: 48, rate: 24 } },
      timelineRange: { start: { value: 0, rate: 24 }, duration: { value: 48, rate: 24 } },
    });
    const item = effectItem({ spec: sampleEffect(), controls: {}, targetId: "clip-1", bakedKeys: 9, now: 3 });
    const changeset = { schemaVersion: "0.1.0" as const, id: "cs-fx", baseRevision: "local", items: [item] };
    const checked = tryHistoryEntry(changeset, item, base, "you", "2026-11-04T00:00:00Z");
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.entry).toMatchObject({ op: "add_effect", actor: "user", inverse: { op: "remove_effect" } });
    expect(checked.entry.forward).toMatchObject({ specRef: "bounce-title", presetName: "Bouncing title" });
    const after = advanceMirror(base, [checked.entry]);
    expect(after.tracks[0]!.clips[0]!.effects?.[0]?.presetName).toBe("Bouncing title");
    expect(base.tracks[0]!.clips[0]!.effects).toBeUndefined();
  });
});

describe("bakedPayload", () => {
  it("sends the target layer's live curves as layer id to prop key lists", () => {
    const spec = sampleEffect();
    const bake = bakeRig(spec, rigOf(spec));
    const payload = bakedPayload(bake.spec, rigTargetId(bake.spec));
    expect(Object.keys(payload ?? {})).toEqual(["ball"]);
    const props = payload!.ball!;
    expect(Object.keys(props).sort()).toEqual(["rotation", "scaleX", "scaleY", "x", "y"]);
    expect(props.x![0]).toMatchObject({ time: expect.any(Number), value: expect.any(Number) });
    const sent = Object.values(props).reduce((sum, keys) => sum + keys.length, 0);
    expect(sent).toBe(bake.keys);
  });

  it("is undefined when the target has no keys, so the call sends the spec alone", () => {
    const spec = sampleEffect();
    expect(bakedPayload(spec, null)).toBeUndefined();
    expect(bakedPayload(spec, "no-such-layer")).toBeUndefined();
    const flat: EffectSpec = {
      ...spec,
      layers: spec.layers.map((layer) => ({ ...layer, curves: undefined })),
    };
    expect(bakedPayload(flat, rigTargetId(flat))).toBeUndefined();
  });
});

describe("effectItem resolve", () => {
  it("carries the comp names as the undo back", () => {
    const item = effectItem({
      spec: sampleEffect(),
      controls: {},
      targetId: "clip-1",
      bakedKeys: 9,
      resolve: { compName: "Comp 2", prevCompName: "Comp 1" },
      now: 4,
    });
    expect(item.patch).toMatchObject({ resolve: { compName: "Comp 2", prevCompName: "Comp 1" } });
  });
});

describe("stamp", () => {
  it("formats m:ss.cc", () => {
    expect(stamp(1.5)).toBe("0:01.50");
    expect(stamp(65.25)).toBe("1:05.25");
  });
});
