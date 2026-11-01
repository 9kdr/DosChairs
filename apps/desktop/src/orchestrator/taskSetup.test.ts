import { describe, expect, it } from "vitest";
import { lanesForPrompt, planPrompt, setupTask } from "./taskSetup";

describe("lanesForPrompt", () => {
  it("defaults bare prompts to edit", () => {
    expect(lanesForPrompt("do the thing")).toEqual(["edit"]);
  });

  it("routes colour and effects words to their lanes", () => {
    expect(lanesForPrompt("grade the hook")).toEqual(["colour"]);
    expect(lanesForPrompt("add a glow to the title")).toEqual(["effects"]);
  });

  it("orders wanted lanes by mention, primary first", () => {
    expect(lanesForPrompt("cut the silence and grade the hook")).toEqual(["edit", "colour"]);
    expect(lanesForPrompt("grade the hook, then cut the silence")).toEqual(["colour", "edit"]);
  });

  it("matches whole words, not substrings", () => {
    expect(lanesForPrompt("execute the plan")).toEqual(["edit"]);
  });
});

describe("setupTask", () => {
  it("sets up a planned running task from the prompt", () => {
    const task = setupTask("cut the silence and grade the hook", 42);
    expect(task).toMatchObject({
      id: "task-prompt-42",
      name: "cut the silence and grade the hook",
      status: "Running",
      lane: "edit",
      plan: { brief: "cut the silence and grade the hook", lanes: ["edit", "colour"] },
    });
  });

  it("keeps one stable id per command", () => {
    expect(setupTask("grade it", 7).id).toBe(setupTask("grade it", 7).id);
    expect(setupTask("grade it", 7).id).not.toBe(setupTask("grade it", 8).id);
  });
});
