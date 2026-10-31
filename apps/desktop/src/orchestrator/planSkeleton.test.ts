import { describe, expect, it } from "vitest";
import { skeletonGroupsForText } from "./planSkeleton";

const BRIEF =
  "One speaker, one room, cut so the argument lands before the viewer looks away. The story opens on a line you can repeat, spends the middle earning it, and ends on a pay-off that does not need a recap.\n\nLeave a rough cut Resolve can still grade. Keep the face on the A-roll, park extra shots on the B-roll shelf, and hold the words for the caption pass.";

describe("skeletonGroupsForText", () => {
  it("returns one group per paragraph", () => {
    const groups = skeletonGroupsForText(BRIEF);
    expect(groups.map((group) => group.kind)).toEqual(["text", "text"]);
  });

  it("varies bar counts and last widths with paragraph length", () => {
    const [first, second] = skeletonGroupsForText(BRIEF);
    expect(first!.widths).toEqual(["100%", "100%", "30%"]);
    expect(second!.widths).toEqual(["100%", "70%"]);
  });

  it("marks headings distinct from body text", () => {
    const groups = skeletonGroupsForText("# The hook\n\nTwo short lines here.");
    expect(groups.map((group) => group.kind)).toEqual(["h1", "text"]);
    expect(groups[0]!.widths).toHaveLength(1);
  });

  it("groups list items and quotes like the renderer does", () => {
    const groups = skeletonGroupsForText("- one\n- two\n\n> quoted");
    expect(groups.map((group) => group.kind)).toEqual(["list", "quote"]);
    expect(groups[0]!.widths).toHaveLength(2);
  });

  it("shows one short bar for an empty doc", () => {
    expect(skeletonGroupsForText("  ")).toEqual([{ kind: "text", widths: ["38%"] }]);
  });
});
