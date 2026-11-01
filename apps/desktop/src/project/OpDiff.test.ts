import { describe, expect, it } from "vitest";
import type { ChangesetItem, EditOp } from "@chair/timeline-ir";
import { diffSummary } from "./OpDiff";

function item(op: EditOp, patch?: Record<string, unknown>, targetId?: string): ChangesetItem {
  return { id: `item-${op}`, op, rationale: "test", patch, targetId, status: "pending" };
}

describe("diffSummary", () => {
  it("names the marker, trim, and clip the samples propose", () => {
    expect(
      diffSummary(
        item("add_marker", {
          marker: { id: "mark-hook-beat", name: "Hook beat" },
        }),
      ),
    ).toBe("Adds marker “Hook beat”.");
    expect(diffSummary(item("trim", { edge: "head", frames: 12 }, "clip-interview"))).toBe(
      "Trims 12 frames off the head of clip-interview.",
    );
    expect(
      diffSummary(item("add_clip", { clipId: "clip-desk-wide" }, "v1")),
    ).toBe("Adds clip clip-desk-wide to v1.");
  });

  it("covers every other op kind", () => {
    expect(diffSummary(item("remove_clip", undefined, "clip-b"))).toBe("Removes clip-b.");
    expect(diffSummary(item("ripple", undefined, "clip-b"))).toBe(
      "Ripples clip-b to close the gap.",
    );
    expect(diffSummary(item("move", undefined, "clip-b"))).toBe(
      "Moves clip-b to its new position.",
    );
    expect(diffSummary(item("set_speed", { speed: 2 }, "clip-b"))).toBe(
      "Sets clip-b to 2× speed.",
    );
    expect(diffSummary(item("add_transition", undefined, "clip-b"))).toBe(
      "Adds a transition to clip-b.",
    );
    expect(diffSummary(item("add_effect", { presetName: "Halation" }, "clip-b"))).toBe(
      "Adds the Halation effect to clip-b.",
    );
    expect(diffSummary(item("add_track", undefined, "v2"))).toBe("Adds track v2.");
    expect(diffSummary(item("set_gain", { gainDb: -6 }, "clip-b"))).toBe(
      "Sets clip-b gain to -6 dB.",
    );
    expect(diffSummary(item("mute_clip", undefined, "clip-b"))).toBe("Mutes clip-b.");
  });

  it("names the removal ops undo proposals emit", () => {
    expect(
      diffSummary(item("remove_marker", { marker: { id: "m1", name: "Hook" } }, "m1")),
    ).toBe("Removes marker “Hook”.");
    expect(diffSummary(item("remove_marker"))).toBe("Removes a marker.");
    expect(
      diffSummary(item("remove_effect", { effectId: "fx-1" }, "clip-b")),
    ).toBe("Removes effect fx-1 from clip-b.");
    expect(
      diffSummary(item("remove_effect", { presetName: "Halation" }, "clip-b")),
    ).toBe("Removes the Halation effect from clip-b.");
    expect(
      diffSummary(item("remove_transition", undefined, "clip-b")),
    ).toBe("Removes the transition from clip-b.");
    expect(diffSummary(item("remove_track", undefined, "v2"))).toBe("Removes track v2.");
  });

  it("falls back to plain words when the patch or target is missing", () => {
    expect(diffSummary(item("add_marker"))).toBe("Adds a marker.");
    expect(diffSummary(item("trim"))).toBe("Trims the head of a clip.");
    expect(diffSummary(item("trim", { edge: "tail", frames: 8 }))).toBe(
      "Trims 8 frames off the tail.",
    );
    expect(diffSummary(item("add_clip"))).toBe("Adds a clip.");
    expect(diffSummary(item("remove_clip"))).toBe("Removes a clip.");
    expect(diffSummary(item("set_speed"))).toBe("Changes playback speed.");
    expect(diffSummary(item("add_effect"))).toBe("Adds an effect.");
    expect(diffSummary(item("set_gain", undefined, "clip-b"))).toBe("Adjusts gain on clip-b.");
    expect(diffSummary(item("mute_clip"))).toBe("Mutes a clip.");
  });
});
