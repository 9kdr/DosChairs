import { describe, expect, it } from "vitest";
import { moveSectionIndex, SECTIONS } from "./sections";

describe("settings sections", () => {
  it("lists the three areas, Keys and models first", () => {
    expect(SECTIONS.map((section) => section.id)).toEqual([
      "keys",
      "editors",
      "preferences",
    ]);
  });
});

describe("moveSectionIndex", () => {
  it("moves one step with the arrows and stops at the ends", () => {
    expect(moveSectionIndex(3, 0, "ArrowDown")).toBe(1);
    expect(moveSectionIndex(3, 2, "ArrowDown")).toBe(2);
    expect(moveSectionIndex(3, 2, "ArrowUp")).toBe(1);
    expect(moveSectionIndex(3, 0, "ArrowUp")).toBe(0);
  });

  it("jumps with Home and End", () => {
    expect(moveSectionIndex(3, 1, "Home")).toBe(0);
    expect(moveSectionIndex(3, 1, "End")).toBe(2);
  });

  it("ignores other keys", () => {
    expect(moveSectionIndex(3, 1, "Enter")).toBeNull();
    expect(moveSectionIndex(3, 1, "ArrowLeft")).toBeNull();
    expect(moveSectionIndex(3, 1, "ArrowRight")).toBeNull();
  });

  it("clamps a stale index instead of failing", () => {
    expect(moveSectionIndex(3, 9, "ArrowUp")).toBe(1);
    expect(moveSectionIndex(0, 0, "ArrowDown")).toBeNull();
  });
});
