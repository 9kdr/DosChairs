import { describe, expect, it } from "vitest";
import { dragItemsFor } from "./AssetShelf";

const assets = [
  { id: "a1", name: "A001_C004.mov", kind: "video" as const },
  { id: "a2", name: "dialogue.wav", kind: "audio" as const },
];
const folders = [{ id: "f1", name: "B-roll" }];
const pieces = [
  { id: "p1", name: "Opening hook" },
  { id: "p2", name: "Cold open alt" },
];

describe("dragItemsFor", () => {
  it("drags one piece with the piece kind and tone", () => {
    expect(dragItemsFor(["p1"], assets, folders, pieces, "p1", "Opening hook", "piece")).toEqual([
      { id: "p1", label: "Opening hook", tone: "piece", refKind: "piece" },
    ]);
  });

  it("drags a group of pieces the way it drags a group of assets", () => {
    expect(
      dragItemsFor(["p1", "p2"], assets, folders, pieces, "p1", "Opening hook", "piece"),
    ).toEqual([
      { id: "p1", label: "Opening hook", tone: "piece", refKind: "piece" },
      { id: "p2", label: "Cold open alt", tone: "piece", refKind: "piece" },
    ]);
  });

  it("keeps each card's kind in a mixed asset-and-piece group", () => {
    expect(
      dragItemsFor(["a1", "p1"], assets, folders, pieces, "p1", "Opening hook", "piece"),
    ).toEqual([
      { id: "a1", label: "A001_C004.mov", tone: "video", refKind: "asset" },
      { id: "p1", label: "Opening hook", tone: "piece", refKind: "piece" },
    ]);
  });

  it("keeps folders riding as asset refs", () => {
    expect(dragItemsFor(["f1"], assets, folders, pieces, "f1", "B-roll", "folder")).toEqual([
      { id: "f1", label: "B-roll", tone: "folder", refKind: "asset" },
    ]);
  });

  it("drags only the held card when it is outside the selection", () => {
    expect(
      dragItemsFor(["a1", "a2"], assets, folders, pieces, "p1", "Opening hook", "piece"),
    ).toEqual([{ id: "p1", label: "Opening hook", tone: "piece", refKind: "piece" }]);
  });

  it("falls back to the held card when the selection resolves to nothing", () => {
    expect(
      dragItemsFor(["gone", "also-gone"], assets, folders, pieces, "gone", "Missing", "piece"),
    ).toEqual([{ id: "gone", label: "Missing", tone: "piece", refKind: "piece" }]);
  });
});
