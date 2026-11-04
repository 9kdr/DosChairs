import { describe, expect, it } from "vitest";
import { findMention, insertMention, mentionTag } from "./mentions";

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

describe("insertMention", () => {
  it("swaps the typed query for a tag and puts the caret after it", () => {
    const mention = findMention("make @low spring", 9)!;
    const next = insertMention("make @low spring", mention, "My Lower Third");
    expect(next.text).toBe("make @MyLowerThird spring");
    expect(next.caret).toBe("make @MyLowerThird ".length);
  });

  it("does not double the space when one follows", () => {
    const next = insertMention("@ x", { start: 0, end: 1, query: "" }, "Glow Pulse");
    expect(next.text).toBe("@GlowPulse x");
  });
});

describe("mentionTag", () => {
  it("drops spaces and punctuation but keeps letters and digits", () => {
    expect(mentionTag("Soft Wipe (v2)")).toBe("@SoftWipev2");
    expect(mentionTag("Lower-third")).toBe("@Lower-third");
  });
});
