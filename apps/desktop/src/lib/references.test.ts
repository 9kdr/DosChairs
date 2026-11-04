import { describe, expect, it } from "vitest";
import { emptyTimeline, type Timeline } from "@chair/timeline-ir";
import {
  EMPTY_GROUPS,
  assetsOfListing,
  boardOfPlan,
  clipsOfTimeline,
  piecesOfListing,
  searchReferences,
  type ReferenceGroups,
} from "./references";

function timeline(): Timeline {
  const base = emptyTimeline("t", "Cut");
  const range = { start: { value: 0, rate: 30 }, duration: { value: 90, rate: 30 } };
  base.tracks = [
    {
      id: "v1",
      kind: "video",
      name: "V1",
      clips: [
        { id: "c1", name: "Interview", sourceRange: range, timelineRange: range },
        { id: "c2", name: "B-roll street", sourceRange: range, timelineRange: range },
      ],
    },
    {
      id: "a1",
      kind: "audio",
      name: "A1",
      clips: [{ id: "c3", name: "Music", sourceRange: range, timelineRange: range }],
    },
  ];
  return base;
}

describe("clipsOfTimeline", () => {
  it("lists video-track clips with their track, skipping audio", () => {
    expect(clipsOfTimeline(timeline())).toEqual([
      { ref: { kind: "clip", id: "c1", label: "Interview" }, detail: "V1" },
      { ref: { kind: "clip", id: "c2", label: "B-roll street" }, detail: "V1" },
    ]);
  });

  it("reads a missing timeline as no footage", () => {
    expect(clipsOfTimeline(null)).toEqual([]);
  });
});

describe("listings", () => {
  it("maps assets, pieces and board items to options", () => {
    expect(assetsOfListing([{ id: "a1", name: "A001.mov", kind: "video", proxy: "ready" }])).toEqual([
      { ref: { kind: "asset", id: "a1", label: "A001.mov" }, detail: "video" },
    ]);
    expect(
      piecesOfListing([
        { id: "p1", name: "Glow", kind: "effect", origin: "catalog", source: "catalog", summary: "", controls: [] },
      ]),
    ).toEqual([{ ref: { kind: "piece", id: "p1", label: "Glow" }, detail: "effect" }]);
    expect(
      boardOfPlan([{ id: "mood", kind: "style", title: "Night grade", images: [], notes: "", tags: [] }]),
    ).toEqual([{ ref: { kind: "plan", id: "board:mood", label: "Night grade" }, detail: "style" }]);
  });
});

describe("searchReferences", () => {
  const groups: ReferenceGroups = {
    ...EMPTY_GROUPS,
    footage: clipsOfTimeline(timeline()),
    assets: assetsOfListing([{ id: "a1", name: "Interview raw.mov", kind: "video", proxy: "ready" }]),
  };

  it("filters every group by name and drops the empty ones", () => {
    const sections = searchReferences(groups, "interview");
    expect(sections.map((section) => section.id)).toEqual(["footage", "assets"]);
    expect(sections[0]!.options.map((option) => option.ref.label)).toEqual(["Interview"]);
  });

  it("caps each group and keeps the group order", () => {
    const sections = searchReferences(groups, "", 1);
    expect(sections.map((section) => section.label)).toEqual([
      "Footage on the timeline",
      "Assets",
    ]);
    expect(sections[0]!.options).toHaveLength(1);
  });
});
