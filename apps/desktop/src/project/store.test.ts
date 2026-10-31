import { describe, expect, it } from "vitest";
import {
  acceptAllPending,
  historyEntryForItem,
  historyForTask,
  reviewItem,
  sampleChangeset,
  sampleTimeline,
} from "./store";

describe("reviewItem", () => {
  it("accepts one item and leaves the rest pending", () => {
    const before = sampleChangeset();
    const after = reviewItem(before, "item-trim-interview", "accepted");

    expect(after.items.find((item) => item.id === "item-trim-interview")?.status).toBe("accepted");
    expect(
      after.items.filter((item) => item.id !== "item-trim-interview").map((item) => item.status),
    ).toEqual(["pending", "pending"]);
    // The input is untouched: review builds a new changeset.
    expect(before.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("rejects one item", () => {
    const after = reviewItem(sampleChangeset(), "item-hook-marker", "rejected");
    expect(after.items.find((item) => item.id === "item-hook-marker")?.status).toBe("rejected");
  });

  it("ignores unknown ids", () => {
    const before = sampleChangeset();
    expect(reviewItem(before, "item-missing", "accepted")).toBe(before);
  });
});

describe("acceptAllPending", () => {
  it("accepts every pending item and reports what it accepted", () => {
    const before = sampleChangeset();
    const { changeset: after, accepted } = acceptAllPending(before);

    expect(after.items.map((item) => item.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(accepted.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
    // The input is untouched: review builds a new changeset.
    expect(before.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("leaves decided items alone and reports nothing new", () => {
    const decided = reviewItem(sampleChangeset(), "item-trim-interview", "rejected");
    const { changeset: after, accepted } = acceptAllPending(decided);

    expect(after.items.find((item) => item.id === "item-trim-interview")?.status).toBe("rejected");
    expect(accepted).toHaveLength(2);
    expect(acceptAllPending(after).accepted).toHaveLength(0);
    expect(acceptAllPending(after).changeset).toBe(after);
  });
});

describe("historyEntryForItem", () => {
  it("shapes one accepted item like the history entry in #75", () => {
    const changeset = sampleChangeset();
    const item = changeset.items[1]!;
    const entry = historyEntryForItem(changeset, item, "you", "2026-10-31T12:00:00.000Z");

    expect(entry).toEqual({
      taskId: "task-stand-in",
      changesetId: changeset.id,
      itemId: item.id,
      op: item.op,
      targetId: item.targetId,
      baseRevision: changeset.baseRevision,
      forward: item.patch,
      inverse: { op: item.op, standIn: true },
      acceptedAt: "2026-10-31T12:00:00.000Z",
      acceptedBy: "you",
    });
  });

  it("defaults a missing forward patch to an empty object", () => {
    const changeset = sampleChangeset();
    const entry = historyEntryForItem(
      changeset,
      { id: "item-bare", op: "move" },
      "you",
      "2026-10-31T12:00:00.000Z",
    );
    expect(entry.forward).toEqual({});
    expect(entry.targetId).toBeUndefined();
  });

  it("carries an explicit task id when given", () => {
    const entry = historyEntryForItem(
      sampleChangeset(),
      { id: "item-bare", op: "move" },
      "you",
      "2026-10-31T12:00:00.000Z",
      "task-1",
    );
    expect(entry.taskId).toBe("task-1");
  });
});

describe("historyForTask", () => {
  it("returns stand-in history shaped like #75, oldest first", () => {
    const entries = historyForTask("task-1");

    expect(entries.map((entry) => entry.itemId)).toEqual(["item-task-1-a", "item-task-1-b"]);
    expect(entries[0]).toMatchObject({
      taskId: "task-1",
      changesetId: "cs-task-1-1",
      op: "add_clip",
      targetId: "v1",
      baseRevision: "r0",
      forward: { clipId: "clip-a-roll" },
      inverse: { op: "add_clip", standIn: true },
      acceptedBy: "you",
    });
  });

  it("returns no entries for unknown tasks", () => {
    expect(historyForTask("task-missing")).toEqual([]);
  });
});

describe("sampleTimeline", () => {
  it("mirrors a cut with tracks, clips, and markers", () => {
    const timeline = sampleTimeline("proj_talking_head", "Talking head rough-cut");
    expect(timeline.tracks.map((track) => track.id)).toEqual(["v1", "a1", "s1"]);
    expect(timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0)).toBe(3);
    expect(timeline.markers).toHaveLength(3);
  });
});
