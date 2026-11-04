import { describe, expect, it } from "vitest";
import type { RunningTask } from "./RunningTasks";
import type { ProjectPlan } from "./plan-api";
import { suggestionsFor } from "./suggestions";

function task(overrides: Partial<RunningTask> = {}): RunningTask {
  return { id: "task-1", name: "Trim the intro", status: "Done", lane: "edit", ...overrides };
}

function plan(
  steps: { title: string; detail?: string }[],
  beats: string[] = [],
): ProjectPlan {
  return {
    id: "otio:proof",
    status: "draft",
    front: {
      script_md: "",
      board: [],
      beats: beats.map((text, index) => ({ id: `beat-${index}`, role: "hook", text })),
    },
    frontHash: "h",
    back: {
      tasks: steps.map((step, index) => ({ id: `step-${index}`, ...step })),
    },
  } as unknown as ProjectPlan;
}

const THREE = plan([
  { title: "Cut the hook on the oven door", detail: "First six seconds." },
  { title: "Grade the morning warm", detail: "Amber highlights." },
  { title: "Land the payoff before the viewer leaves" },
]);

describe("suggestionsFor", () => {
  it("gives nothing without a plan", () => {
    expect(suggestionsFor({ plan: null, tasks: [] })).toEqual([]);
    expect(suggestionsFor({ plan: null, tasks: [task()] })).toEqual([]);
  });

  it("suggests the first two steps of a fresh plan, in order, with the full text", () => {
    expect(suggestionsFor({ plan: THREE, tasks: [] })).toEqual([
      {
        kind: "prompt",
        label: "Cut the hook on the oven door",
        text: "Cut the hook on the oven door. First six seconds.",
      },
      {
        kind: "prompt",
        label: "Grade the morning warm",
        text: "Grade the morning warm. Amber highlights.",
      },
    ]);
  });

  it("skips a step a task already ran and suggests the next two in order", () => {
    const tasks = [task({ name: "cut the hook on the OVEN door!", status: "Running" })];
    expect(suggestionsFor({ plan: THREE, tasks }).map((item) => item.label)).toEqual([
      "Grade the morning warm",
      "Land the payoff before the viewer leaves",
    ]);
  });

  it("matches a step against the task brief too, for landed and planned tasks", () => {
    const tasks = [
      task({
        name: "Warm grade",
        plan: { brief: "Grade the morning warm. Amber highlights.", lanes: ["colour"] },
      }),
    ];
    expect(suggestionsFor({ plan: THREE, tasks }).map((item) => item.label)).toEqual([
      "Cut the hook on the oven door",
      "Land the payoff before the viewer leaves",
    ]);
  });

  it("puts a failed task's Retry first, ahead of the plan steps", () => {
    const tasks = [task({ id: "task-2", name: "Balance shot 04", status: "Failed: refused" })];
    const found = suggestionsFor({ plan: THREE, tasks });
    expect(found[0]).toEqual({ kind: "retry", taskId: "task-2", label: "Retry Balance shot 04" });
    expect(found).toHaveLength(3);
  });

  it("brings a failed task's step back only as Retry", () => {
    const tasks = [
      task({ id: "task-3", name: "Cut the hook on the oven door", status: "Failed: offline" }),
    ];
    const found = suggestionsFor({ plan: THREE, tasks });
    expect(found.map((item) => item.label)).toEqual([
      "Retry Cut the hook on the oven door",
      "Grade the morning warm",
      "Land the payoff before the viewer leaves",
    ]);
  });

  it("gives nothing when every step has run", () => {
    const tasks = [
      task({ id: "a", name: "Cut the hook on the oven door" }),
      task({ id: "b", name: "Grade the morning warm" }),
      task({ id: "c", name: "Land the payoff before the viewer leaves", status: "Running" }),
    ];
    expect(suggestionsFor({ plan: THREE, tasks })).toEqual([]);
  });

  it("shortens a long step to about 40 characters but keeps its full text", () => {
    const long = plan([
      { title: "Replace every long pause in the interview with a tight jump cut" },
    ]);
    const [item] = suggestionsFor({ plan: long, tasks: [] });
    expect(item?.kind).toBe("prompt");
    if (item?.kind !== "prompt") return;
    expect(item.label.length).toBeLessThanOrEqual(40);
    expect(item.label.endsWith("…")).toBe(true);
    expect(item.text).toBe("Replace every long pause in the interview with a tight jump cut");
  });

  it("falls back to the beats when no tasks are built yet", () => {
    const beats = plan([], ["Open on the oven door.", "The oven fails.", "Land the payoff."]);
    expect(suggestionsFor({ plan: beats, tasks: [] })).toEqual([
      { kind: "prompt", label: "Open on the oven door", text: "Open on the oven door." },
      { kind: "prompt", label: "The oven fails", text: "The oven fails." },
    ]);
  });

  it("gives nothing for a plan with no steps and no beats", () => {
    expect(suggestionsFor({ plan: plan([]), tasks: [] })).toEqual([]);
  });
});
