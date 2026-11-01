import { describe, expect, it } from "vitest";
import {
  EDITOR_IDS,
  EDITOR_META,
  LIBRARY_ASSETS,
  editorById,
  editorName,
  formatEditedAt,
} from "./data";

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

describe("editor meta", () => {
  it("names every known editor without a status", () => {
    expect(EDITOR_IDS).toEqual(["resolve", "kdenlive", "otio"]);
    expect(editorName("resolve")).toBe("DaVinci Resolve");
    expect(EDITOR_META.otio.short).toBe("OTIO");
    // Statuses always come from detection; the default admits ignorance.
    expect(editorById("resolve").status).toBe("stopped");
    expect(editorById("resolve", "inProject").status).toBe("inProject");
  });
});

describe("LIBRARY_ASSETS", () => {
  it("covers every reusable kind with stand-ins", () => {
    const kinds = new Set(LIBRARY_ASSETS.map((asset) => asset.kind));
    expect(kinds).toEqual(new Set(["music", "image", "video", "sfx"]));
  });
});
