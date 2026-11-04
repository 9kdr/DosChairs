import { describe, expect, it } from "vitest";
import type { Changeset, HistoryEntry, Timeline } from "@chair/timeline-ir";
import { emptyTimeline } from "@chair/timeline-ir";
import {
  advanceMirror,
  canUndoTask,
  historyForTask,
  reviewItem,
  tryHistoryEntry,
  undoSummaryForTask,
} from "./store";

/** Three pending items, shaped like a parsed review proposal. */
function makeChangeset(): Changeset {
  return {
    schemaVersion: "0.1.0",
    id: "cs-req-1",
    baseRevision: "live",
    items: [
      {
        id: "item-hook-marker",
        op: "add_marker",
        rationale: "Mark the hook so the opener lands on the beat.",
        patch: {
          marker: {
            id: "mark-hook-beat",
            name: "Hook beat",
            time: { value: 86410, rate: 24 },
            kind: "beat",
            beatId: "beat-opener",
          },
        },
        status: "pending",
      },
      {
        id: "item-trim-interview",
        op: "trim",
        targetId: "clip-interview",
        beatId: "beat-opener",
        rationale: "Trim the pause at the head of the interview.",
        patch: { edge: "head", frames: 12 },
        status: "pending",
      },
      {
        id: "item-broll-cutaway",
        op: "add_clip",
        targetId: "v1",
        rationale: "Cut away to the desk shot while the answer lands.",
        patch: {
          clipId: "clip-desk-wide",
          timelineStart: { value: 86424, rate: 24 },
          duration: { value: 24, rate: 24 },
        },
        status: "pending",
      },
    ],
  };
}

function makeTimeline(): Timeline {
  const timeline = emptyTimeline("tl", "Demo");
  timeline.tracks[0]!.clips.push({
    id: "clip-interview",
    name: "Interview",
    mediaRef: "media://interview.mov",
    sourceRange: {
      start: { value: 0, rate: 24 },
      duration: { value: 240, rate: 24 },
    },
    timelineRange: {
      start: { value: 0, rate: 24 },
      duration: { value: 240, rate: 24 },
    },
  });
  return timeline;
}

describe("reviewItem", () => {
  it("accepts one item and leaves the rest pending", () => {
    const before = makeChangeset();
    const after = reviewItem(before, "item-trim-interview", "accepted");

    expect(after.items.find((item) => item.id === "item-trim-interview")?.status).toBe("accepted");
    expect(
      after.items.filter((item) => item.id !== "item-trim-interview").map((item) => item.status),
    ).toEqual(["pending", "pending"]);
    // The input is untouched: review builds a new changeset.
    expect(before.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("rejects one item", () => {
    const after = reviewItem(makeChangeset(), "item-hook-marker", "rejected");
    expect(after.items.find((item) => item.id === "item-hook-marker")?.status).toBe("rejected");
  });

  it("ignores unknown ids", () => {
    const before = makeChangeset();
    expect(reviewItem(before, "item-missing", "accepted")).toBe(before);
  });
});

describe("tryHistoryEntry", () => {
  it("shapes one accepted item with its real inverse", () => {
    const changeset = makeChangeset();
    const item = changeset.items[1]!;
    const checked = tryHistoryEntry(
      changeset,
      item,
      makeTimeline(),
      "you",
      "2026-10-31T12:00:00.000Z",
    );

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.entry).toEqual({
      taskId: "task-stand-in",
      changesetId: changeset.id,
      itemId: item.id,
      op: item.op,
      targetId: item.targetId,
      beatId: "beat-opener",
      baseRevision: changeset.baseRevision,
      forward: item.patch,
      inverse: {
        op: "trim",
        targetId: "clip-interview",
        patch: {
          restoreSourceRange: {
            start: { value: 0, rate: 24 },
            duration: { value: 240, rate: 24 },
          },
          restoreTimelineRange: {
            start: { value: 0, rate: 24 },
            duration: { value: 240, rate: 24 },
          },
        },
      },
      acceptedAt: "2026-10-31T12:00:00.000Z",
      acceptedBy: "you",
      actor: "user",
    });
  });

  it("marks agent applies and carries the adapter fallback", () => {
    const changeset = makeChangeset();
    const item = {
      ...changeset.items[0]!,
      fallback: {
        capability: "fusionComps",
        reason: "Resolve can't place this directly — pre-rendered clip instead",
      },
    };
    const checked = tryHistoryEntry(
      changeset,
      item,
      makeTimeline(),
      "agent",
      "2026-10-31T12:00:00.000Z",
      "task-1",
      "agent",
    );

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.entry.actor).toBe("agent");
    expect(checked.entry.acceptedBy).toBe("agent");
    expect(checked.entry.fallback).toEqual({
      capability: "fusionComps",
      reason: "Resolve can't place this directly — pre-rendered clip instead",
    });
  });

  it("fails closed with a reason when no inverse can be built", () => {
    const changeset = makeChangeset();
    const checked = tryHistoryEntry(
      changeset,
      {
        id: "item-cut-missing",
        op: "remove_clip",
        targetId: "clip-missing",
        rationale: "Cut a clip that is not there.",
        status: "pending",
      },
      makeTimeline(),
      "you",
      "2026-10-31T12:00:00.000Z",
    );

    expect(checked).toEqual({
      ok: false,
      reason: "remove_clip needs clip-missing on the timeline to snapshot it",
    });
  });

  it("carries an explicit task id when given", () => {
    const checked = tryHistoryEntry(
      makeChangeset(),
      makeChangeset().items[0]!,
      makeTimeline(),
      "you",
      "2026-10-31T12:00:00.000Z",
      "task-1",
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.entry.taskId).toBe("task-1");
  });
});

describe("advanceMirror", () => {
  it("moves the local copy with what applied so the next inverse snapshots it", () => {
    const timeline = makeTimeline();
    const changeset = makeChangeset();
    const marker = tryHistoryEntry(
      changeset,
      changeset.items[0]!,
      timeline,
      "agent",
      "2026-10-31T12:00:00.000Z",
      "task-1",
      "agent",
    );
    const trim = tryHistoryEntry(
      changeset,
      changeset.items[1]!,
      timeline,
      "agent",
      "2026-10-31T12:00:00.000Z",
      "task-1",
      "agent",
    );
    if (!marker.ok || !trim.ok) throw new Error("fixtures must invert");

    const next = advanceMirror(timeline, [marker.entry, trim.entry]);
    expect(next.markers.map((entry) => entry.id)).toEqual(["mark-hook-beat"]);
    expect(next.tracks[0]!.clips[0]!.timelineRange.start).toEqual({ value: 12, rate: 24 });
    // The input mirror is untouched: the advance is a copy.
    expect(timeline.markers).toEqual([]);
    expect(timeline.tracks[0]!.clips[0]!.timelineRange.start).toEqual({ value: 0, rate: 24 });
  });

  it("leaves the mirror alone with no entries", () => {
    const timeline = makeTimeline();
    expect(advanceMirror(timeline, [])).toBe(timeline);
  });
});

function acceptedEntry(itemId: string, taskId: string): HistoryEntry {
  const changeset = makeChangeset();
  const checked = tryHistoryEntry(
    changeset,
    { ...changeset.items[0]!, id: itemId },
    makeTimeline(),
    "you",
    "2026-10-31T12:00:00.000Z",
    taskId,
  );
  if (!checked.ok) throw new Error("fixture must invert");
  return checked.entry;
}

describe("historyForTask", () => {
  it("returns one task's entries oldest first", () => {
    const history = [acceptedEntry("a", "task-1"), acceptedEntry("b", "task-2"), acceptedEntry("c", "task-1")];

    expect(historyForTask(history, "task-1").map((entry) => entry.itemId)).toEqual(["a", "c"]);
    expect(historyForTask(history, "task-2").map((entry) => entry.itemId)).toEqual(["b"]);
  });

  it("returns no entries for unknown tasks", () => {
    expect(historyForTask([acceptedEntry("a", "task-1")], "task-missing")).toEqual([]);
  });
});

describe("canUndoTask", () => {
  const history = [acceptedEntry("a", "task-1")];

  it("is true for a completed task with accepted history", () => {
    expect(canUndoTask({ id: "task-1", status: "completed" }, history)).toBe(true);
    expect(canUndoTask({ id: "task-1", status: "Completed" }, history)).toBe(true);
  });

  it("is false while running or with nothing to rewind", () => {
    expect(canUndoTask({ id: "task-1", status: "Arranging A-roll on V1" }, history)).toBe(false);
    expect(canUndoTask({ id: "task-2", status: "completed" }, history)).toBe(false);
    expect(canUndoTask({ id: "task-1", status: "completed" }, [])).toBe(false);
  });
});

describe("undoSummaryForTask", () => {
  it("lists the task's edits newest first with the way back", () => {
    const history = [acceptedEntry("a", "task-1"), acceptedEntry("b", "task-2"), acceptedEntry("c", "task-1")];

    expect(undoSummaryForTask(history, "task-1", "Assemble rough cut")).toBe(
      "2 applied edits for Assemble rough cut, newest first: " +
        "Add Marker; Add Marker. " +
        "Press u or pick Undo to here in History to rewind.",
    );
  });

  it("says so honestly with nothing to rewind", () => {
    expect(undoSummaryForTask([], "task-1", "Assemble rough cut")).toBe(
      "No applied edits to rewind for Assemble rough cut yet.",
    );
  });
});
