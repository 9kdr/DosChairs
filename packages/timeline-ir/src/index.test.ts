import { describe, expect, it } from "vitest";
import { applyAccepted, emptyTimeline } from "./index";
import type { Changeset, Marker } from "./index";

describe("timeline ir", () => {
  it("ignores pending changeset items", () => {
    const timeline = emptyTimeline("tl", "Demo");
    const marker: Marker = {
      id: "m1",
      name: "Hook",
      kind: "hook",
      time: { value: 0, rate: 24 },
    };
    const changeset: Changeset = {
      schemaVersion: "0.1.0",
      id: "cs",
      baseRevision: "r0",
      items: [
        {
          id: "i1",
          op: "add_marker",
          rationale: "Mark the hook",
          status: "pending",
          patch: { marker },
        },
      ],
    };
    expect(applyAccepted(timeline, changeset).markers).toHaveLength(0);
    changeset.items[0]!.status = "accepted";
    expect(applyAccepted(timeline, changeset).markers).toHaveLength(1);
  });
});
