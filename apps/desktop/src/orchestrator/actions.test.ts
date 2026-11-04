import { describe, expect, it } from "vitest";
import { ACTIONS, filterActions, parseAction } from "./actions";

describe("composer actions", () => {
  it("has no accept action: finished work lands with Undo instead", () => {
    expect(ACTIONS.map((action) => action.key)).not.toContain("accept");
    expect(parseAction("/accept")).toBeNull();
    expect(parseAction("accept")).toBeNull();
    expect(filterActions("/").map((action) => action.key)).not.toContain("accept");
    const hints = ACTIONS.map((action) => action.hint).join("\n");
    expect(hints).not.toContain("Accept");
  });

  it("still parses the remaining actions", () => {
    expect(parseAction("/brief")).toMatchObject({ key: "brief" });
    expect(parseAction("again")).toMatchObject({ key: "again" });
    expect(parseAction("preset: Halation")).toMatchObject({ key: "preset", slot: "Halation" });
    expect(parseAction("trim the pause")).toBeNull();
    expect(filterActions("")).toHaveLength(ACTIONS.length);
  });
});
