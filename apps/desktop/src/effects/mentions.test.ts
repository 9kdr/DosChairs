import { describe, expect, it } from "vitest";
import { findMention, textBeforeCaret } from "./mentions";

describe("findMention", () => {
  it("finds a bare @ and what follows it", () => {
    expect(findMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(findMention("make @low", 9)).toEqual({ start: 5, end: 9, query: "low" });
  });

  it("only reads up to the caret", () => {
    expect(findMention("make @lower third", 11)).toEqual({ start: 5, end: 11, query: "lower" });
  });

  it("ignores an @ inside a word, after a space, or behind the caret", () => {
    expect(findMention("mail me@home", 12)).toBeNull();
    expect(findMention("make @lower third", 17)).toBeNull();
    expect(findMention("@low then", 9)).toBeNull();
    expect(findMention("plain words", 5)).toBeNull();
  });
});

describe("textBeforeCaret", () => {
  it("reads text runs verbatim up to the caret", () => {
    const pieces = [
      { type: "text", value: "make @glo" },
      { type: "text", value: "w more" },
    ] as const;
    expect(textBeforeCaret([...pieces], 9)).toBe("make @glo");
    expect(textBeforeCaret([...pieces], 3)).toBe("mak");
  });

  it("counts each chip as one slot so mention offsets line up", () => {
    const pieces = [{ type: "text", value: "use " }, { type: "ref" }, { type: "text", value: " @a" }] as const;
    const before = textBeforeCaret([...pieces], 8);
    expect(before.length).toBe(8);
    expect(findMention(before, before.length)).toEqual({ start: 6, end: 8, query: "a" });
  });

  it("stops at the caret even mid-chip-run", () => {
    const pieces = [{ type: "text", value: "@" }, { type: "ref" }, { type: "text", value: "x" }] as const;
    expect(textBeforeCaret([...pieces], 1)).toBe("@");
    expect(textBeforeCaret([...pieces], 0)).toBe("");
  });
});
