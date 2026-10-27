import { describe, expect, it } from "vitest";
import { EDITORS, editorById, formatEditedAt } from "./data";

describe("formatEditedAt", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z");

  it("formats recent minutes", () => {
    expect(formatEditedAt("2026-10-27T11:50:00.000Z", now)).toBe("10m ago");
  });

  it("formats hours", () => {
    expect(formatEditedAt("2026-10-27T06:00:00.000Z", now)).toBe("6h ago");
  });

  it("formats days", () => {
    expect(formatEditedAt("2026-10-24T12:00:00.000Z", now)).toBe("3d ago");
  });
});

describe("EDITORS", () => {
  it("marks DaVinci Resolve as inProject", () => {
    expect(editorById("resolve").status).toBe("inProject");
    expect(EDITORS.some((editor) => editor.status === "inProject")).toBe(true);
  });
});
