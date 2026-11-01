import { describe, expect, it } from "vitest";
import * as RunningTasksModule from "./RunningTasks";
import { canStopTask, type RunningTask } from "./RunningTasks";

const live: RunningTask = {
  id: "task-prompt-7",
  name: "trim the silence",
  status: "Queued on the agent",
  lane: "edit",
  jobId: "req_live1",
  jobStatus: "queued",
};

describe("canStopTask", () => {
  it("stops queued live rows: the agent only cancels queued jobs", () => {
    expect(canStopTask(live)).toBe(true);
  });

  it("hides Stop on working rows: the agent refuses to cancel those", () => {
    expect(canStopTask({ ...live, status: "The agent is working", jobStatus: "in_progress" })).toBe(
      false,
    );
  });

  it("keeps the legacy rule for rows without a live job", () => {
    const { jobId: _jobId, jobStatus: _jobStatus, ...unsubmitted } = live;
    expect(canStopTask({ ...unsubmitted, status: "Running" })).toBe(true);
    expect(canStopTask({ ...unsubmitted, status: "completed" })).toBe(false);
    expect(canStopTask({ ...unsubmitted, status: "queued" })).toBe(false);
  });
});

describe("stand-ins", () => {
  it("exports no fake rows; the board only ever lists live jobs", () => {
    expect("STANDIN_TASKS" in RunningTasksModule).toBe(false);
  });
});
