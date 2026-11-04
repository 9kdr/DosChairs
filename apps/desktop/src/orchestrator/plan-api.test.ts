import { describe, expect, it } from "vitest";
import { fetchPlan, parsePlanMarkdown, planOf } from "./plan-api";

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

describe("fetchPlan errors", () => {
  it("keeps the agent's plain message and code", async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: "invalid_plan", message: "digest needs an 'itemId' string" } }),
    });
    await expect(fetchPlan("proj-1", { fetchFn })).rejects.toMatchObject({
      message: "digest needs an 'itemId' string",
      status: 400,
      code: "invalid_plan",
    });
  });

  it("falls back to the status when the body says nothing", async () => {
    const fetchFn = async () => ({ ok: false, status: 500, json: async () => null });
    await expect(fetchPlan("proj-1", { fetchFn })).rejects.toMatchObject({
      message: "agent failed (500)",
      status: 500,
    });
  });
});
