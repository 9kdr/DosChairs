import { describe, expect, it } from "vitest";
import { skeletonGroupsForText } from "./planSkeleton";

const BRIEF =
  "One speaker, one room, cut so the argument lands before the viewer looks away. The story opens on a line you can repeat, spends the middle earning it, and ends on a pay-off that does not need a recap.\n\nLeave a rough cut Resolve can still grade. Keep the face on the A-roll, park extra shots on the B-roll shelf, and hold the words for the caption pass.";

describe("skeletonGroupsForText", () => {
  it("returns one group per paragraph", () => {
    expect(skeletonGroupsForText(BRIEF)).toHaveLength(2);
  });

  it("varies bar counts and last widths with paragraph length", () => {
    const [first, second] = skeletonGroupsForText(BRIEF);
    expect(first).toEqual(["100%", "100%", "30%"]);
    expect(second).toEqual(["100%", "70%"]);
  });

  it("treats headings, lists, and quotes as plain groups", () => {
    const groups = skeletonGroupsForText("# The hook\n\n- one\n- two\n\n> quoted");
    expect(groups).toHaveLength(3);
    expect(groups[1]).toHaveLength(2);
  });

  it("caps bars for very long lines", () => {
    expect(skeletonGroupsForText("x".repeat(600))).toEqual([Array(6).fill("100%")]);
  });

  it("shows one short bar for an empty doc", () => {
    expect(skeletonGroupsForText("  ")).toEqual([["38%"]]);
  });
});
