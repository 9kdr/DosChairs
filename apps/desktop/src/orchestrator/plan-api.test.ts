import { describe, expect, it } from "vitest";
import { parsePlanMarkdown, planOf } from "./plan-api";

describe("parsePlanMarkdown", () => {
  it("reads the script, beats, and board items", () => {
    const front = parsePlanMarkdown(
      [
        "# Script",
        "One room, one argument.",
        "",
        "## Beat 1 hook",
        "Open on the oven door.",
        "",
        "## Beat 2 turn",
        "The oven fails.",
        "",
        "![grade still](https://example.com/still.jpg)",
        "[campaign deck](https://example.com/deck)",
      ].join("\n"),
    );
    expect(front.script_md).toContain("One room");
    expect(front.beats.map((beat) => [beat.id, beat.role])).toEqual([
      ["beat-1", "hook"],
      ["beat-2", "turn"],
    ]);
    expect(front.beats[0]!.text).toContain("oven door");
    expect(front.board).toHaveLength(2);
    expect(front.board[0]).toMatchObject({ kind: "reference", title: "grade still" });
    expect(front.board[1]).toMatchObject({ kind: "link", url: "https://example.com/deck" });
  });
});

describe("planOf", () => {
  it("reads a plan payload and drops unknown fields", () => {
    const plan = planOf(
      {
        id: "resolve:dawn",
        status: "draft",
        front: { script_md: "# x", beats: [{ id: "b1", nope: 1 }], board: [] },
        frontHash: "abc",
        back: { tasks: [{ id: "t1", title: "Cut" }], constraints: { do: ["a"], dont: [] }, digests: {}, stale: true },
      },
      "resolve:dawn",
    );
    expect(plan?.front.beats).toEqual([{ id: "b1", role: "", text: "" }]);
    expect(plan?.back.stale).toBe(true);
  });
});
