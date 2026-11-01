import { describe, expect, it } from "vitest";
import {
  applyAccepted,
  buildUndoChangeset,
  emptyTimeline,
  invertItem,
  type Changeset,
  type ChangesetItem,
  type Clip,
  type EditOp,
  type HistoryEntry,
  type Timeline,
} from "./index";

function range(start: number, duration: number) {
  return {
    start: { value: start, rate: 24 },
    duration: { value: duration, rate: 24 },
  };
}

function clip(id: string, start: number, duration: number): Clip {
  return {
    id,
    name: id,
    mediaRef: `media://${id}.mov`,
    sourceRange: range(0, duration),
    timelineRange: range(start, duration),
  };
}

/** Two clips on V1, one on A1, one marker. */
function makeTimeline(): Timeline {
  const timeline = emptyTimeline("tl", "Demo");
  timeline.tracks[0]!.clips.push(clip("clip-a", 0, 240), clip("clip-b", 240, 120));
  timeline.tracks[1]!.clips.push(clip("clip-c", 0, 240));
  timeline.markers.push({
    id: "mark-1",
    name: "One",
    time: { value: 48, rate: 24 },
    kind: "user",
  });
  return timeline;
}

function item(
  id: string,
  op: EditOp,
  patch?: Record<string, unknown>,
  targetId?: string,
): ChangesetItem {
  return { id, op, rationale: `test ${op}`, patch, targetId, status: "pending" };
}

function accepted(changeset: Changeset): Changeset {
  return {
    ...changeset,
    items: changeset.items.map((entry) => ({ ...entry, status: "accepted" as const })),
  };
}

/** Accept one item against the timeline as it stands, like the store does. */
function acceptForTest(
  timeline: Timeline,
  entry: ChangesetItem,
  taskId = "task-1",
): { timeline: Timeline; history: HistoryEntry } {
  const inverted = invertItem(entry, timeline);
  expect(inverted.ok).toBe(true);
  if (!inverted.ok) throw new Error("unreachable");
  const history: HistoryEntry = {
    taskId,
    changesetId: "cs-1",
    itemId: entry.id,
    op: entry.op,
    targetId: entry.targetId,
    baseRevision: "live",
    forward: entry.patch ?? {},
    inverse: inverted.inverse,
    acceptedAt: "2026-11-01T12:00:00.000Z",
    acceptedBy: "you",
  };
  const next = applyAccepted(timeline, {
    schemaVersion: "0.1.0",
    id: "cs-1",
    baseRevision: "live",
    items: [{ ...entry, status: "accepted" }],
  });
  return { timeline: next, history };
}

describe("invertItem", () => {
  it("pairs add_clip with remove_clip", () => {
    const inverted = invertItem(item("i", "add_clip", { clipId: "clip-x" }, "v1"), makeTimeline());
    expect(inverted).toEqual({
      ok: true,
      inverse: { op: "remove_clip", targetId: "clip-x", patch: { clipId: "clip-x" } },
    });
  });

  it("rebuilds a removed whole clip from its snapshot", () => {
    const inverted = invertItem(item("i", "remove_clip", undefined, "clip-a"), makeTimeline());
    expect(inverted.ok).toBe(true);
    if (!inverted.ok) return;
    expect(inverted.inverse.op).toBe("add_clip");
    expect(inverted.inverse.targetId).toBe("v1");
    expect(inverted.inverse.patch).toMatchObject({ clipId: "clip-a", toTrackId: "v1" });
    expect((inverted.inverse.patch.clip as Clip).mediaRef).toBe("media://clip-a.mov");
  });

  it("inverts a partial cut to a trim carrying the before ranges", () => {
    const inverted = invertItem(
      item("i", "remove_clip", { startFrames: 0, frames: 24 }, "clip-a"),
      makeTimeline(),
    );
    expect(inverted.ok).toBe(true);
    if (!inverted.ok) return;
    expect(inverted.inverse.op).toBe("trim");
    expect(inverted.inverse.patch.restoreTimelineRange).toEqual(range(0, 240));
  });

  it("carries before/after ranges for trim and positions for move", () => {
    const timeline = makeTimeline();
    const trim = invertItem(item("i", "trim", { edge: "head", frames: 12 }, "clip-a"), timeline);
    expect(trim.ok).toBe(true);
    if (trim.ok) {
      expect(trim.inverse.op).toBe("trim");
      expect(trim.inverse.patch.restoreTimelineRange).toEqual(range(0, 240));
    }
    const move = invertItem(
      item("i", "move", { toTrackId: "a1", startFrames: 48 }, "clip-a"),
      timeline,
    );
    expect(move).toEqual({
      ok: true,
      inverse: {
        op: "move",
        targetId: "clip-a",
        patch: { toTrackId: "v1", startValue: 0, startRate: 24, insertAt: 0 },
      },
    });
  });

  it("negates ripple shifts", () => {
    const inverted = invertItem(
      item("i", "ripple", { shiftFrames: 24 }, "clip-b"),
      makeTimeline(),
    );
    expect(inverted).toEqual({
      ok: true,
      inverse: { op: "ripple", targetId: "clip-b", patch: { shiftFrames: -24 } },
    });
  });

  it("restores the before value for speed and gain, flipping mute", () => {
    const timeline = makeTimeline();
    expect(invertItem(item("i", "set_speed", { rate: 2 }, "clip-a"), timeline)).toEqual({
      ok: true,
      inverse: {
        op: "set_speed",
        targetId: "clip-a",
        patch: { rate: 1, previousRate: 2 },
      },
    });
    expect(invertItem(item("i", "set_gain", { gainDb: -6 }, "clip-a"), timeline)).toEqual({
      ok: true,
      inverse: {
        op: "set_gain",
        targetId: "clip-a",
        patch: { gainDb: 0, previousGainDb: -6 },
      },
    });
    expect(invertItem(item("i", "mute_clip", undefined, "clip-a"), timeline)).toEqual({
      ok: true,
      inverse: { op: "mute_clip", targetId: "clip-a", patch: { muted: false } },
    });
  });

  it("pairs the add/remove families for markers, effects, transitions, tracks", () => {
    const timeline = makeTimeline();
    const marker = invertItem(
      item("i", "add_marker", { marker: { id: "m2", name: "Two" } }),
      timeline,
    );
    expect(marker.ok).toBe(true);
    if (marker.ok) {
      expect(marker.inverse.op).toBe("remove_marker");
      expect(marker.inverse.targetId).toBe("m2");
    }
    const unmark = invertItem(item("i", "remove_marker", undefined, "mark-1"), timeline);
    expect(unmark.ok).toBe(true);
    if (unmark.ok) expect(unmark.inverse.op).toBe("add_marker");

    const effect = invertItem(
      item("i", "add_effect", { presetName: "Halation" }, "clip-a"),
      timeline,
    );
    expect(effect).toEqual({
      ok: true,
      inverse: { op: "remove_effect", targetId: "clip-a", patch: { effectId: "i" } },
    });

    const transition = invertItem(
      item("i", "add_transition", { transition: "dissolve", durationFrames: 12 }, "clip-a"),
      timeline,
    );
    expect(transition.ok).toBe(true);
    if (transition.ok) {
      expect(transition.inverse.op).toBe("remove_transition");
      expect(transition.inverse.patch).toEqual({
        transitionId: "i",
        transition: { transition: "dissolve", durationFrames: 12 },
      });
    }

    const track = invertItem(item("i", "add_track", { trackId: "v2" }), timeline);
    expect(track).toEqual({
      ok: true,
      inverse: { op: "remove_track", targetId: "v2", patch: { trackId: "v2" } },
    });
    const untrack = invertItem(item("i", "remove_track", undefined, "s1"), timeline);
    expect(untrack.ok).toBe(true);
    if (untrack.ok) {
      expect(untrack.inverse.op).toBe("add_track");
      expect((untrack.inverse.patch.track as { id: string }).id).toBe("s1");
    }
  });

  it("fails closed for an op with no defined inverse", () => {
    const inverted = invertItem(
      { id: "i", op: "teleport" as EditOp, rationale: "x", status: "pending" },
      makeTimeline(),
    );
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.reason).toMatch(/no inverse defined for op "teleport"/);
  });

  it("fails closed when the before-state is missing from the timeline", () => {
    const timeline = makeTimeline();
    const cases: Array<[ChangesetItem, RegExp]> = [
      [item("i", "remove_clip", undefined, "clip-missing"), /needs clip-missing on the timeline/],
      [item("i", "trim", { edge: "head", frames: 4 }, "clip-missing"), /needs clip-missing/],
      [item("i", "move", { toTrackId: "a1", startFrames: 0 }, "clip-missing"), /needs clip-missing/],
      [item("i", "remove_marker", undefined, "mark-missing"), /needs mark-missing/],
      [item("i", "remove_effect", { effectId: "fx-1" }, "clip-a"), /needs effect fx-1/],
      [item("i", "remove_track", undefined, "v9"), /needs v9/],
      [item("i", "ripple", { shiftFrames: 8 }, "clip-missing"), /needs clip-missing/],
    ];
    for (const [entry, pattern] of cases) {
      const inverted = invertItem(entry, timeline);
      expect(inverted.ok).toBe(false);
      if (!inverted.ok) expect(inverted.reason).toMatch(pattern);
    }
  });

  it("fails closed when the forward patch carries nothing to invert", () => {
    const timeline = makeTimeline();
    const cases: Array<[ChangesetItem, RegExp]> = [
      [item("i", "add_clip", undefined, "v1"), /added clip id/],
      [item("i", "add_marker", undefined), /patch\.marker/],
      [item("i", "add_track", undefined), /track id/],
      [item("i", "ripple", undefined, "clip-a"), /shiftFrames/],
      [item("i", "ripple", { shiftFrames: 0 }, "clip-a"), /shiftFrames/],
      [item("i", "set_speed", undefined, "clip-a"), /patch\.rate/],
      [item("i", "set_gain", undefined, "clip-a"), /patch\.gainDb/],
      [item("i", "remove_effect", undefined, "clip-a"), /patch\.effectId/],
      [item("i", "remove_marker", undefined), /marker id/],
      [item("i", "add_effect", undefined), /target clip/],
      [item("i", "move", undefined), /target clip/],
    ];
    for (const [entry, pattern] of cases) {
      const inverted = invertItem(entry, timeline);
      expect(inverted.ok).toBe(false);
      if (!inverted.ok) expect(inverted.reason).toMatch(pattern);
    }
  });
});

describe("applyAccepted round-trips", () => {
  /** Forward then inverse returns the exact timeline, media refs included. */
  function expectRoundTrip(entry: ChangesetItem) {
    const before = makeTimeline();
    const inverted = invertItem(entry, before);
    expect(inverted.ok).toBe(true);
    if (!inverted.ok) return;
    const after = applyAccepted(before, {
      schemaVersion: "0.1.0",
      id: "cs-fwd",
      baseRevision: "live",
      items: [{ ...entry, status: "accepted" }],
    });
    expect(after).not.toEqual(before);
    const back = applyAccepted(after, {
      schemaVersion: "0.1.0",
      id: "cs-inv",
      baseRevision: "live",
      items: [
        {
          id: "undo",
          op: inverted.inverse.op,
          targetId: inverted.inverse.targetId,
          rationale: "undo",
          patch: inverted.inverse.patch,
          status: "accepted",
        },
      ],
    });
    expect(back).toEqual(before);
  }

  it("round-trips add_clip and remove_clip", () => {
    expectRoundTrip(item("i", "add_clip", { clipId: "clip-new" }, "v1"));
    expectRoundTrip(
      item(
        "i",
        "add_clip",
        { clip: { ...clip("clip-new", 360, 48), name: "New" } },
        "v1",
      ),
    );
    expectRoundTrip(item("i", "remove_clip", undefined, "clip-b"));
    // Removing the first clip restores its slot, not the end of the track.
    expectRoundTrip(item("i", "remove_clip", undefined, "clip-a"));
  });

  it("round-trips partial cuts through their trim inverse", () => {
    expectRoundTrip(item("i", "remove_clip", { startFrames: 0, frames: 24 }, "clip-a"));
    expectRoundTrip(item("i", "remove_clip", { startFrames: 48, frames: 24 }, "clip-a"));
  });

  it("round-trips markers, tracks, and effects", () => {
    expectRoundTrip(
      item("i", "add_marker", {
        marker: { id: "m2", name: "Two", time: { value: 96, rate: 24 }, kind: "beat" },
      }),
    );
    expectRoundTrip(item("i", "remove_marker", undefined, "mark-1"));
    expectRoundTrip(item("i", "add_track", { trackId: "v2", kind: "video", name: "V2" }));
    expectRoundTrip(item("i", "remove_track", undefined, "s1"));
    expectRoundTrip(item("i", "add_effect", { presetName: "Halation" }, "clip-a"));
  });

  it("round-trips remove_effect against the snapshotted effect", () => {
    const before = makeTimeline();
    const withEffect = applyAccepted(before, {
      schemaVersion: "0.1.0",
      id: "cs-fx",
      baseRevision: "live",
      items: [
        { ...item("fx", "add_effect", { effectId: "fx-1", presetName: "H" }, "clip-a"), status: "accepted" },
      ],
    });
    const inverted = invertItem(item("i", "remove_effect", { effectId: "fx-1" }, "clip-a"), withEffect);
    expect(inverted.ok).toBe(true);
    if (!inverted.ok) return;
    expect(inverted.inverse.patch).toMatchObject({ effectId: "fx-1", presetName: "H" });
    const removed = applyAccepted(withEffect, {
      schemaVersion: "0.1.0",
      id: "cs-rm",
      baseRevision: "live",
      items: [{ ...item("i", "remove_effect", { effectId: "fx-1" }, "clip-a"), status: "accepted" }],
    });
    expect(removed.tracks[0]!.clips[0]!.effects).toBeUndefined();
    const back = applyAccepted(removed, {
      schemaVersion: "0.1.0",
      id: "cs-back",
      baseRevision: "live",
      items: [
        {
          id: "undo",
          op: inverted.inverse.op,
          targetId: inverted.inverse.targetId,
          rationale: "undo",
          patch: inverted.inverse.patch,
          status: "accepted",
        },
      ],
    });
    expect(back).toEqual(withEffect);
  });

  it("round-trips trim in both patch dialects", () => {
    expectRoundTrip(item("i", "trim", { edge: "head", frames: 12 }, "clip-a"));
    expectRoundTrip(item("i", "trim", { edge: "tail", frames: 12 }, "clip-a"));
    expectRoundTrip(item("i", "trim", { trimStartFrames: 6, trimEndFrames: 6 }, "clip-a"));
  });

  it("round-trips move across tracks and ripple down the track", () => {
    expectRoundTrip(item("i", "move", { toTrackId: "a1", startFrames: 48 }, "clip-a"));
    expectRoundTrip(item("i", "move", { toTrackId: "v1", startFrames: 12 }, "clip-b"));
    expectRoundTrip(item("i", "ripple", { shiftFrames: 24 }, "clip-b"));
    expectRoundTrip(item("i", "ripple", { shiftFrames: -24 }, "clip-a"));
  });

  it("round-trips patch-only ops by inverting twice", () => {
    const timeline = makeTimeline();
    const speed = invertItem(item("i", "set_speed", { rate: 2 }, "clip-a"), timeline);
    expect(speed.ok).toBe(true);
    if (!speed.ok) return;
    const speedBack = invertItem(
      { id: "u", op: speed.inverse.op, targetId: speed.inverse.targetId, patch: speed.inverse.patch },
      timeline,
    );
    expect(speedBack.ok).toBe(true);
    if (speedBack.ok) {
      expect(speedBack.inverse.op).toBe("set_speed");
      expect(speedBack.inverse.patch).toMatchObject({ rate: 2 });
    }

    const mute = invertItem(item("i", "mute_clip", undefined, "clip-a"), timeline);
    expect(mute.ok).toBe(true);
    if (!mute.ok) return;
    const muteBack = invertItem(
      { id: "u", op: mute.inverse.op, targetId: mute.inverse.targetId, patch: mute.inverse.patch },
      timeline,
    );
    expect(muteBack).toEqual({
      ok: true,
      inverse: { op: "mute_clip", targetId: "clip-a", patch: { muted: true } },
    });

    const transition = invertItem(
      item("i", "add_transition", { transition: "dissolve", durationFrames: 12 }, "clip-a"),
      timeline,
    );
    expect(transition.ok).toBe(true);
    if (!transition.ok) return;
    const transitionBack = invertItem(
      {
        id: "u",
        op: transition.inverse.op,
        targetId: transition.inverse.targetId,
        patch: transition.inverse.patch,
      },
      timeline,
    );
    expect(transitionBack.ok).toBe(true);
    if (transitionBack.ok) {
      expect(transitionBack.inverse.op).toBe("add_transition");
      expect(transitionBack.inverse.patch).toMatchObject({
        transition: "dissolve",
        durationFrames: 12,
      });
    }
  });

  it("leaves the timeline alone for patch-only ops and pending items", () => {
    const before = makeTimeline();
    const after = applyAccepted(before, {
      schemaVersion: "0.1.0",
      id: "cs",
      baseRevision: "live",
      items: [
        { ...item("s", "set_speed", { rate: 2 }, "clip-a"), status: "accepted" },
        { ...item("g", "set_gain", { gainDb: -3 }, "clip-a"), status: "accepted" },
        { ...item("m", "mute_clip", undefined, "clip-a"), status: "accepted" },
        {
          ...item("t", "add_transition", { transition: "d", durationFrames: 4 }, "clip-a"),
          status: "accepted",
        },
        { ...item("p", "add_marker", { marker: { id: "m9", name: "N" } }), status: "pending" },
      ],
    });
    expect(after).toEqual(before);
  });
});

describe("buildUndoChangeset", () => {
  function entry(itemId: string, taskId = "task-1"): HistoryEntry {
    const timeline = makeTimeline();
    const inverted = invertItem(item(itemId, "add_marker", { marker: { id: `m-${itemId}` } }), timeline);
    if (!inverted.ok) throw new Error("fixture must invert");
    return {
      taskId,
      changesetId: "cs-1",
      itemId,
      op: "add_marker",
      baseRevision: "live",
      forward: {},
      inverse: inverted.inverse,
      acceptedAt: "2026-11-01T12:00:00.000Z",
      acceptedBy: "you",
    };
  }

  it("rewinds N..tip in reverse as one pending changeset", () => {
    const history = [entry("a"), entry("b"), entry("c")];
    const undone = buildUndoChangeset(history, "b");
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.changeset.id).toBe("cs-undo-b");
    expect(undone.changeset.baseRevision).toBe("live");
    expect(undone.changeset.items.map((item) => item.id)).toEqual(["undo-c", "undo-b"]);
    expect(undone.changeset.items.map((item) => item.op)).toEqual([
      "remove_marker",
      "remove_marker",
    ]);
    expect(undone.changeset.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("refuses when another task accepted after the undo point", () => {
    const history = [entry("a", "task-1"), entry("b", "task-2"), entry("c", "task-1")];
    const undone = buildUndoChangeset(history, "a");
    expect(undone.ok).toBe(false);
    if (!undone.ok) {
      expect(undone.reason).toMatch(/Task task-2 accepted add_marker \(b\) after this point/);
    }
    // Strict stack: unwind the global tip first, then the earlier task frees up.
    expect(buildUndoChangeset(history, "b").ok).toBe(false);
    const tip = buildUndoChangeset(history, "c");
    expect(tip.ok).toBe(true);
    if (tip.ok) expect(tip.changeset.items.map((item) => item.id)).toEqual(["undo-c"]);
  });

  it("refuses unknown entries", () => {
    expect(buildUndoChangeset([entry("a")], "missing")).toEqual({
      ok: false,
      reason: "That edit isn't in the accepted history — nothing to undo.",
    });
    expect(buildUndoChangeset([], "a").ok).toBe(false);
  });
});

describe("live path: accept, undo to here, earlier state", () => {
  it("accepts three edits, rewinds to the first, and matches it exactly", () => {
    const t0 = makeTimeline();
    const first = acceptForTest(
      t0,
      item("item-add", "add_clip", { clipId: "clip-new" }, "v1"),
    );
    const second = acceptForTest(
      first.timeline,
      item("item-trim", "trim", { edge: "head", frames: 24 }, "clip-a"),
    );
    const third = acceptForTest(
      second.timeline,
      item("item-move", "move", { toTrackId: "a1", startFrames: 96 }, "clip-b"),
    );
    const history = [first.history, second.history, third.history];

    const undone = buildUndoChangeset(history, "item-trim");
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.changeset.items.map((item) => item.id)).toEqual([
      "undo-item-move",
      "undo-item-trim",
    ]);

    const rewound = applyAccepted(third.timeline, accepted(undone.changeset));
    expect(rewound).toEqual(first.timeline);
    // Source media rode along untouched: same refs, nothing rewritten.
    const refs = (timeline: Timeline) =>
      timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.mediaRef));
    expect(refs(rewound)).toEqual(refs(first.timeline));
    expect(refs(rewound)).toContain("media://clip-a.mov");
  });
});
