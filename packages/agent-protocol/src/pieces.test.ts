import { describe, expect, it } from "vitest";
import {
  DIRECTOR_DEFAULTS,
  directorDefaults,
  pieceDefaults,
  searchPieces,
  type Piece,
} from "./pieces";

const kineticTitle: Piece = {
  id: "kinetic-title",
  effect: "motion_graphics",
  title: "Kinetic title card",
  summary: "Beat-grid kinetic type with a whip-pan drop.",
  endpoint: "motion_graphics",
  inputs: ["text:phrases", "audio:music-bed", "beat-grid:markers"],
  outputs: ["video:overlay-clip"],
  requiredRefs: ["music bed with beat grid"],
  enums: {
    template: { values: ["lower-third", "title-card", "callout"], default: "lower-third" },
    loop: { values: ["once", "loop"], default: "once" },
  },
  example: {
    brief: "24 s teaser with huge words on every beat.",
    plan: { effect: "motion_graphics", prompt: "YOU ARE THE POST.", params: { template: "title-card" } },
    checks: ["Still frames under 25%."],
  },
};

const warmInterview: Piece = {
  id: "warm-interview",
  effect: "grade",
  title: "Warm interview grade",
  summary: "Medium-strength preset grade for daylight rooms.",
  endpoint: "grade",
  inputs: ["clip:video"],
  outputs: ["grade:look"],
  requiredRefs: [],
  enums: {
    intensity: { values: ["subtle", "medium", "strong"], default: "medium" },
    source: { values: ["preset", "reference"], default: "preset" },
  },
  example: {
    brief: "Daylight interview, warm and trustworthy.",
    plan: { effect: "grade", prompt: "Warm interview grade", params: {} },
    checks: ["Skin tones stay natural."],
  },
};

const pieces = [warmInterview, kineticTitle];

describe("piece search", () => {
  it("ranks the requested effect first with refs and defaults", () => {
    const hits = searchPieces(pieces, { effect: "grade" });
    expect(hits[0]!.piece.id).toBe("warm-interview");
    expect(hits[0]!.requiredRefs).toEqual([]);
    expect(hits[0]!.defaults).toEqual({ intensity: "medium", source: "preset" });
  });

  it("matches query text and input types", () => {
    expect(searchPieces(pieces, { query: "whip-pan drop" })[0]!.piece.id).toBe("kinetic-title");
    expect(searchPieces(pieces, { inputs: ["beat-grid:markers"] })[0]!.piece.id).toBe(
      "kinetic-title",
    );
  });

  it("fills piece enums and rejects unknown names or values", () => {
    expect(pieceDefaults(warmInterview, {})).toEqual({ intensity: "medium", source: "preset" });
    expect(() => pieceDefaults(warmInterview, { lens: "35mm" })).toThrow("unknown piece params");
    expect(() => pieceDefaults(warmInterview, { intensity: "blazing" })).toThrow(
      "invalid value for intensity",
    );
  });

  it("fills the shared director knobs", () => {
    expect(directorDefaults({})).toEqual(DIRECTOR_DEFAULTS);
    expect(directorDefaults({ camera_move: "whip-pan" }).lens).toBe("35mm");
    expect(() => directorDefaults({ dolly: "zoom" })).toThrow("unknown director knobs");
    expect(() => directorDefaults({ audio: "loud" })).toThrow("invalid value for audio");
  });
});
