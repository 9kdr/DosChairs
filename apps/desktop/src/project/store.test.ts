import { describe, expect, it } from "vitest";
import type { Changeset } from "@chair/timeline-ir";
import { acceptAllPending, historyEntryForItem, historyForTask, reviewItem } from "./store";

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

describe("acceptAllPending", () => {
  it("accepts every pending item and reports what it accepted", () => {
    const before = makeChangeset();
    const { changeset: after, accepted } = acceptAllPending(before);

    expect(after.items.map((item) => item.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(accepted.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
    // The input is untouched: review builds a new changeset.
    expect(before.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("leaves decided items alone and reports nothing new", () => {
    const decided = reviewItem(makeChangeset(), "item-trim-interview", "rejected");
    const { changeset: after, accepted } = acceptAllPending(decided);

    expect(after.items.find((item) => item.id === "item-trim-interview")?.status).toBe("rejected");
    expect(accepted).toHaveLength(2);
    expect(acceptAllPending(after).accepted).toHaveLength(0);
    expect(acceptAllPending(after).changeset).toBe(after);
  });
});

describe("historyEntryForItem", () => {
  it("shapes one accepted item like the history entry in #75", () => {
    const changeset = makeChangeset();
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
    const changeset = makeChangeset();
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
      makeChangeset(),
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
