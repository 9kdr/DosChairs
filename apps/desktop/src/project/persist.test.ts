import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTimeline, type Changeset } from "@chair/timeline-ir";
import {
  readOpenProject,
  readReviewSnapshot,
  withStoredDecisions,
  writeOpenProject,
  writeReviewSnapshot,
} from "./persist";

/** Node has no localStorage; stand in with a map behind the same calls. */
function installMemoryStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  });
  return backing;
}

function makeChangeset(id: string, statuses: Changeset["items"][number]["status"][]): Changeset {
  return {
    schemaVersion: "0.1.0",
    id,
    baseRevision: "live",
    items: statuses.map((status, index) => ({
      id: `item-${index + 1}`,
      op: "trim" as const,
      rationale: "Trim the pause.",
      status,
    })),
  };
}

beforeEach(() => {
  installMemoryStorage();
});

describe("open project", () => {
  it("round-trips the open project id", () => {
    expect(readOpenProject()).toBeNull();
    writeOpenProject("proj_talking_head");
    expect(readOpenProject()).toBe("proj_talking_head");
  });

  it("clears the open project on null", () => {
    writeOpenProject("proj_talking_head");
    writeOpenProject(null);
    expect(readOpenProject()).toBeNull();
  });
});

describe("review snapshot", () => {
  it("round-trips the mirror with its decided proposal", () => {
    const snapshot = {
      timeline: emptyTimeline("tl-1", "Rough cut"),
      changeset: makeChangeset("cs-req-1", ["accepted", "pending", "rejected"]),
      savedAt: "2026-11-01T10:00:00.000Z",
    };
    writeReviewSnapshot("proj-1", snapshot);
    expect(readReviewSnapshot("proj-1")).toEqual(snapshot);
  });

  it("keeps projects apart", () => {
    writeReviewSnapshot("proj-1", {
      timeline: emptyTimeline("tl-1", "Rough cut"),
      changeset: null,
      savedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(readReviewSnapshot("proj-2")).toBeNull();
  });

  it("reads corrupt and wrong-shaped values as missing", () => {
    const backing = installMemoryStorage();
    backing.set("chair.project.review.proj-1", "{nope");
    expect(readReviewSnapshot("proj-1")).toBeNull();
    backing.set("chair.project.review.proj-1", JSON.stringify({ timeline: {} }));
    expect(readReviewSnapshot("proj-1")).toBeNull();
  });
});

describe("withStoredDecisions", () => {
  it("re-applies stored decisions onto the same proposal", () => {
    const fresh = makeChangeset("cs-req-1", ["pending", "pending", "pending"]);
    const stored = makeChangeset("cs-req-1", ["accepted", "pending", "rejected"]);

    const merged = withStoredDecisions(fresh, stored);
    expect(merged.items.map((item) => item.status)).toEqual(["accepted", "pending", "rejected"]);
    expect(fresh.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("leaves a new proposal undecided", () => {
    const fresh = makeChangeset("cs-req-2", ["pending"]);
    expect(withStoredDecisions(fresh, makeChangeset("cs-req-1", ["accepted"]))).toBe(fresh);
    expect(withStoredDecisions(fresh, null)).toBe(fresh);
  });

  it("ignores stored ids the fresh proposal does not carry", () => {
    const fresh = makeChangeset("cs-req-1", ["pending"]);
    const stored: Changeset = {
      ...makeChangeset("cs-req-1", ["accepted"]),
      items: [{ id: "item-gone", op: "trim", rationale: "Trim the pause.", status: "accepted" }],
    };
    expect(withStoredDecisions(fresh, stored)).toBe(fresh);
  });
});
