import { describe, expect, it } from "vitest";
import type { Timeline } from "@chair/timeline-ir";
import type { RunningTask } from "./RunningTasks";
import { suggestionsFor } from "./suggestions";

function task(overrides: Partial<RunningTask> = {}): RunningTask {
  return { id: "task-1", name: "Trim the intro", status: "Done", lane: "edit", ...overrides };
}

function timelineWithClips(): Timeline {
  return {
    name: "cut",
    tracks: [
      {
        id: "v1",
        name: "V1",
        kind: "video",
        clips: [
          {
            id: "clip-1",
            name: "Shot 01",
            timelineRange: {
              start: { value: 0, rate: 30 },
              duration: { value: 90, rate: 30 },
            },
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

describe("suggestionsFor", () => {
  it("renders nothing for an empty project", () => {
    expect(suggestionsFor({ timeline: null, tasks: [] })).toEqual([]);
  });

  it("renders nothing when clips exist but a sound task already ran", () => {
    const tasks = [task({ id: "task-9", name: "Duck music under my voice", status: "Done" })];
    expect(suggestionsFor({ timeline: timelineWithClips(), tasks })).toEqual([]);
  });

  it("offers the duck prompt for clips with no sound task yet", () => {
    const tasks = [task({ status: "Done" })];
    expect(suggestionsFor({ timeline: timelineWithClips(), tasks })).toEqual([
      {
        kind: "prompt",
        label: "Duck the music under the dialogue",
        text: "Duck the music under the dialogue",
      },
    ]);
  });

  it("offers a failed task's retry", () => {
    const tasks = [task({ id: "task-2", name: "Balance shot 04", status: "Failed: refused" })];
    expect(suggestionsFor({ timeline: null, tasks })[0]).toEqual({
      kind: "retry",
      taskId: "task-2",
      label: "Retry Balance shot 04",
    });
  });

  it("returns at most two suggestions", () => {
    const tasks = [
      task({ id: "task-2", name: "Balance shot 04", status: "Failed: refused" }),
      task({ id: "task-3", name: "Trim the intro", status: "Failed: offline" }),
    ];
    expect(suggestionsFor({ timeline: timelineWithClips(), tasks })).toHaveLength(2);
  });
});
