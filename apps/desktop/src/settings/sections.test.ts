import { describe, expect, it } from "vitest";
import { SECTIONS } from "./sections";

describe("settings sections", () => {
  it("lists the three areas, Providers first", () => {
    expect(SECTIONS.map((section) => section.id)).toEqual([
      "keys",
      "editors",
      "preferences",
    ]);
  });

  it("labels each area for the segmented control", () => {
    expect(SECTIONS.map((section) => section.label)).toEqual([
      "Providers",
      "Editors",
      "Preferences",
    ]);
  });
});
