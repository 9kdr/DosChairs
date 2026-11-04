import { beforeEach, describe, expect, it } from "vitest";
import * as RunningTasksModule from "./RunningTasks";
import {
  canStopTask,
  displayStatusFor,
  isFailedTask,
  stepTextFor,
  type RunningTask,
} from "./RunningTasks";
import { applyFinishedSound, resetLiveJobs } from "./taskThread";

beforeEach(() => {
  resetLiveJobs();
});

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

  it("hides Stop on failed rows: they retry instead", () => {
    const { jobId: _jobId, jobStatus: _jobStatus, ...unsubmitted } = live;
    expect(
      canStopTask({
        ...unsubmitted,
        status: "Failed: agent is unreachable at http://127.0.0.1:8787",
      }),
    ).toBe(false);
    expect(canStopTask({ ...live, jobStatus: "failed" })).toBe(false);
  });
});

describe("isFailedTask", () => {
  it("sees failed jobs and Failed: lines", () => {
    expect(isFailedTask({ ...live, jobStatus: "failed" })).toBe(true);
    expect(isFailedTask({ ...live, jobStatus: undefined, status: "Failed: boom" })).toBe(true);
    expect(isFailedTask(live)).toBe(false);
    expect(isFailedTask({ ...live, jobStatus: "completed", status: "Added to Demo Cut" })).toBe(
      false,
    );
  });
});

describe("displayStatusFor", () => {
  it("reads the raw address as Agent offline, with the full line in the tooltip", () => {
    const full = "Failed: agent is unreachable at http://127.0.0.1:8787";
    expect(displayStatusFor({ ...live, status: full })).toEqual({
      short: "Failed: Agent offline",
      detail: full,
    });
  });

  it("shows other lines verbatim with no tooltip", () => {
    expect(displayStatusFor({ ...live, status: "The agent is working" })).toEqual({
      short: "The agent is working",
      detail: null,
    });
  });

  it("carries a landed write's skipped reasons in the tooltip", async () => {
    const done = {
      request_id: "req_sound9",
      task: "edit",
      input: {},
      status: "completed",
      created_at: "2026-11-04T00:00:00Z",
      artifacts: [],
      changeset: { status: "proposed", ops: [{ op: "set_gain", patch: {} }] },
      status_url: "",
      cancel_url: "",
    } as const;
    await applyFinishedSound(
      { requestId: "req_sound9", task: live, job: done as never },
      {
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            timeline_name: "Demo Cut (sound copy)",
            original_timeline: "Demo Cut",
            tracks_added: 1,
            clips_added: 1,
            skipped: [{ intent: "sting", reason: "no sting in the library" }],
            fallback: null,
          }),
        }),
      },
    );
    expect(
      displayStatusFor({ ...live, status: "Added to Demo Cut (sound copy) · 1 skipped" }),
    ).toEqual({
      short: "Added to Demo Cut (sound copy) · 1 skipped",
      detail: "Skipped sting: no sting in the library",
    });
  });
});

describe("stepTextFor", () => {
  it("quiets machinery lines so the tile shows a spinner instead", () => {
    expect(stepTextFor({ ...live, status: "The agent is working" })).toBeNull();
    expect(stepTextFor({ ...live, status: "Waiting for the agent" })).toBeNull();
    expect(stepTextFor({ ...live, status: "Queued on the agent" })).toBeNull();
  });

  it("keeps real steps, outcomes, and landed lines", () => {
    expect(stepTextFor({ ...live, status: "Grading the hook" })).toBe("Grading the hook");
    expect(stepTextFor({ ...live, status: "Done", jobStatus: "completed" })).toBe("Done");
    expect(stepTextFor({ ...live, status: "Failed: no faces found" })).toBe(
      "Failed: no faces found",
    );
  });
});

describe("stand-ins", () => {
  it("exports no fake rows; the board only ever lists live jobs", () => {
    expect("STANDIN_TASKS" in RunningTasksModule).toBe(false);
  });
});
