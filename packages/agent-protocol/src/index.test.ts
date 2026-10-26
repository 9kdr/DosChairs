import { describe, expect, it } from "vitest";
import { TOOLS } from "./index";

describe("agent protocol", () => {
  it("keeps every tool non-destructive", () => {
    expect(TOOLS.every((tool) => tool.destructive === false)).toBe(true);
    expect(TOOLS.map((tool) => tool.name)).toContain("render_preview");
  });
});
