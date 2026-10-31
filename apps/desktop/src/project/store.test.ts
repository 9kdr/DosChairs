import { describe, expect, it } from "vitest";
import { reviewItem, sampleChangeset, sampleTimeline } from "./store";

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

describe("sampleTimeline", () => {
  it("mirrors a cut with tracks, clips, and markers", () => {
    const timeline = sampleTimeline("proj_talking_head", "Talking head rough-cut");
    expect(timeline.tracks.map((track) => track.id)).toEqual(["v1", "a1", "s1"]);
    expect(timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0)).toBe(3);
    expect(timeline.markers).toHaveLength(3);
  });
});
