import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createServicesClient,
  ServiceError,
  type FetchFn,
  type ServicesClient,
} from "../lib/services/client";
import type { AgentJob, AgentJobStatus } from "../lib/services/types";
import type { RunningTask } from "./RunningTasks";
import {
  activeStepLabel,
  activityForLiveError,
  activityForLiveJob,
  activityForLivePending,
  applyFinishedCut,
  applyFinishedSound,
  clearPollFailure,
  hasCutItems,
  hasSoundItems,
  headerStatusFor,
  headlineForSubmitError,
  initialTurnsFor,
  inputForTurn,
  isThreadDemo,
  landedFor,
  landedRowsFor,
  liveJobEntries,
  liveRowsForJobs,
  liveSubmitError,
  maybeApplyFinishedCut,
  maybeApplyFinishedSound,
  noteKey,
  notePollFailure,
  noteTurnText,
  openingBrief,
  openingKey,
  openTurnScope,
  POLL_FAIL_LIMIT,
  recordLiveJob,
  redoLandedWrite,
  replyForSubmitError,
  resetLiveJobs,
  retryLandedWrite,
  retryLiveTask,
  runTurn,
  selectionForNote,
  stopLiveTask,
  submitLiveTurn,
  taskForLiveJob,
  textForJob,
  undoLandedWrite,
  waitingRowsFor,
  withOpenTurnError,
  type HeaderState,
} from "./taskThread";
import { writeTaskThread } from "./threadStore";

/** Node has no localStorage; stand in with a map behind the same calls. */
function installMemoryStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  });
  return backing;
}

beforeEach(() => {
  installMemoryStorage();
  resetLiveJobs();
});

const task: RunningTask = {
  id: "task-3",
  name: "Detect silence and jump cuts",
  status: "Scanning audio pauses",
  lane: "edit",
};

function job(status: AgentJobStatus, extra: Record<string, unknown> = {}): AgentJob {
  return {
    request_id: "req_0123456789abcdef",
    task: "edit",
    input: {},
    status,
    created_at: "2026-10-31T00:00:00Z",
    artifacts: [],
    status_url: "http://127.0.0.1:8787/jobs/req_0123456789abcdef",
    cancel_url: "http://127.0.0.1:8787/jobs/req_0123456789abcdef/cancel",
    ...extra,
  } as AgentJob;
}

describe("turn identity", () => {
  it("resumes the opening turn with a stable per-task key", () => {
    expect(openingKey("task-3")).toBe(openingKey("task-3"));
    expect(openingKey("task-3")).not.toBe(openingKey("task-1"));
  });

  it("scopes each note turn to its task and note", () => {
    expect(noteKey("task-3", 7)).not.toBe(noteKey("task-3", 8));
    expect(noteKey("task-3", 7)).not.toBe(noteKey("task-1", 7));
  });

  it("keeps the primary lane on the resumable opening key", () => {
    const primary = openTurnScope("task-3", "edit", true);
    expect(primary).toMatchObject({
      id: "open-edit",
      key: openingKey("task-3"),
      changesetId: "cs-task-3-open",
    });
    const extra = openTurnScope("task-3", "colour", false);
    expect(extra).toMatchObject({
      id: "open-colour",
      key: `${openingKey("task-3")}:colour`,
      changesetId: "cs-task-3-open-colour",
    });
    expect(extra.key).not.toBe(primary.key);
  });

  it("briefs the opening turn from the stable prompt, not the live status", () => {
    const prompted: RunningTask = {
      ...task,
      plan: { brief: "detect the silence", lanes: ["edit"] },
    };
    expect(openingBrief(prompted)).toBe("detect the silence");
    expect(openingBrief(task)).toBe("Detect silence and jump cuts");
  });

  it("declares missing media context empty instead of inventing it", () => {
    const input = inputForTurn(task, "trim the pause", "cs-task-3-open");
    expect(input).toMatchObject({
      brief: "trim the pause",
      task_id: "task-3",
      lane: "edit",
      target_id: "task-3",
      changeset_id: "cs-task-3-open",
      proxy_url: "",
      base_revision: "",
      total_frames: 0,
    });
    expect(input).not.toHaveProperty("spans");
    expect(input).not.toHaveProperty("preview_urls");
  });

  it("passes project_id when task has projectId", () => {
    const taskWithProject: RunningTask = {
      ...task,
      projectId: "kdenlive:shelf",
    };
    const input = inputForTurn(taskWithProject, "trim the pause", "cs-task-3-open");
    expect(input).toMatchObject({
      project_id: "kdenlive:shelf",
    });
  });

  it("resolves the task's loaded proxy media into the turn", () => {
    const loaded: RunningTask = {
      ...task,
      media: { proxyUrl: "file:///proxies/silence.mp4", baseRevision: "rev-9", totalFrames: 900 },
    };
    const input = inputForTurn(loaded, "trim the pause", "cs-task-3-open");
    expect(input).toMatchObject({
      proxy_url: "file:///proxies/silence.mp4",
      base_revision: "rev-9",
      total_frames: 900,
    });
  });
});

describe("thread copy", () => {
  it("keeps the stand-in thread behind the demo flag, off by default", () => {
    expect(isThreadDemo({})).toBe(false);
    expect(isThreadDemo({ VITE_CHAIR_THREAD_DEMO: "1" })).toBe(true);
  });

  it("keeps request ids out of the agent's thread text", () => {
    const queued = textForJob(job("queued"));
    const working = textForJob(job("in_progress"));
    const done = textForJob(job("completed"));
    for (const text of [queued, working, done]) {
      expect(text).not.toContain("req_0123456789abcdef");
      expect(text).not.toContain("req-");
      expect(text).not.toContain("stand-in");
    }
    expect(queued).toContain("queued on the agent");
    expect(working).toContain("working on it");
  });

  it("says a finished sound turn landed, with Undo on the card", () => {
    const text = textForJob(
      job("completed", {
        artifacts: [{ url: "http://127.0.0.1:8787/p/preview.mp4" }],
        changeset: { status: "proposed", ops: [{ op: "set_gain", patch: { gainDb: -6 } }] },
      }),
    );
    expect(text).toContain("1 preview");
    expect(text).toContain("1 edit");
    expect(text).toContain("http://127.0.0.1:8787/p/preview.mp4");
    expect(text).toContain("Landed on a copy in Resolve.");
    expect(text).toContain("Undo is on the card.");
    expect(text).not.toContain("proposed");
    expect(text).not.toContain("accept");
  });

  it("says plainly when nothing could land", () => {
    const text = textForJob(
      job("completed", {
        changeset: {
          status: "proposed",
          ops: [{ op: "set_speed", targetId: "clip-a", patch: { rate: 2 } }],
        },
      }),
    );
    expect(text).toBe("Done: no previews, 1 edit. Nothing landed in Resolve yet.");
    expect(text).not.toContain("Landed on a copy");
    expect(text).not.toContain("proposed");
    expect(text).not.toContain("accept");
  });

  it("says plainly when the turn produced nothing", () => {
    const text = textForJob(job("completed"));
    expect(text).toContain("no previews, no edits");
    expect(text).toContain("Nothing changed");
    expect(text).not.toContain("proposed");
    expect(text).not.toContain("accept");
  });

  it("says a finished cut turn landed, with Undo on the card", () => {
    const text = textForJob(
      job("completed", {
        changeset: {
          status: "proposed",
          ops: [{ op: "trim", targetId: "clip-a", patch: { trimStartFrames: 12 } }],
        },
      }),
    );
    expect(text).toContain("Done: no previews, 1 edit.");
    expect(text).toContain("Landed on a copy in Resolve.");
    expect(text).toContain("Undo is on the card.");
    expect(text).not.toContain("proposed");
    expect(text).not.toContain("accept");
  });

  it("repeats the agent's verbatim error and promises nothing changed", () => {
    const reason = "ValueError: brief names no cleanup v1 plans";
    expect(textForJob(job("failed", { error: reason }))).toContain(reason);
    expect(textForJob(job("failed", { error: reason }))).toContain("Nothing changed");
    expect(textForJob(job("moderated", { error: "blocked" }))).toContain("blocked");
    expect(textForJob(job("canceled"))).toContain("Nothing changed");
  });

  it("tells an unreachable agent apart from a refused turn", () => {
    const down = replyForSubmitError(new ServiceError("agent", "fetch failed"));
    expect(down).toContain("Couldn't reach the agent (http://127.0.0.1:8787)");
    expect(down).toContain("mise run dev:agent");
    expect(down).toContain("Nothing changed");
    expect(headlineForSubmitError(new ServiceError("agent", "fetch failed"))).toBe(
      "Agent unreachable",
    );

    const refused = new ServiceError("agent", "idempotency key was used by another job", {
      status: 409,
      code: "idempotency_conflict",
    });
    expect(replyForSubmitError(refused)).toContain("The agent refused this turn");
    expect(replyForSubmitError(refused)).not.toContain("mise run dev:agent");
    expect(headlineForSubmitError(refused)).toBe("Turn refused");
  });
});

describe("live activity", () => {
  it("keeps the headline, progress, steps shape through the run", () => {
    const pending = activityForLivePending();
    const queued = activityForLiveJob(job("queued"));
    const working = activityForLiveJob(job("in_progress"));
    const done = activityForLiveJob(job("completed"));
    for (const activity of [pending, queued, working, done]) {
      expect(Object.keys(activity).sort()).toEqual(["headline", "progress", "steps"]);
      expect(activity.steps).toHaveLength(3);
    }
    expect(pending.progress).toBe(0);
    expect(queued.progress).toBe(1 / 3);
    expect(working.progress).toBe(2 / 3);
    expect(done.progress).toBe(1);
    expect(working.steps[1]).toMatchObject({ id: "working", state: "active" });
  });

  it("carries the real counts and errors into the rail", () => {
    const done = activityForLiveJob(
      job("completed", { changeset: { status: "proposed", ops: [{ id: "op-1" }] } }),
    );
    expect(done.headline).toContain("1 edit");
    expect(done.headline).not.toContain("proposed");
    const failed = activityForLiveJob(job("failed", { error: "no preview rendered" }));
    expect(failed.headline).toContain("Couldn't finish");
    expect(failed.steps[2]?.label).toContain("no preview rendered");
    expect(failed.progress).toBe(1);
  });

  it("parks the rail honestly when the turn never sends", () => {
    const activity = activityForLiveError("Agent unreachable");
    expect(activity.headline).toBe("Agent unreachable");
    expect(activity.progress).toBe(0);
    expect(activity.steps[0]).toMatchObject({ id: "sent", state: "queued" });
  });
});

describe("thread restore", () => {
  it("reopens a task on its stored thread", () => {
    writeTaskThread({
      taskId: "task-3",
      taskName: "Detect silence and jump cuts",
      lane: "edit",
      status: "Scanning audio pauses",
      turns: [
        {
          id: "open",
          role: "assistant",
          text: "Done (req_0123456789): no previews, no proposed changes.",
        },
        { id: "user-1", role: "user", text: "trim the pause" },
        {
          id: "assistant-1",
          role: "assistant",
          text: "Done (req_abcdef0123): 1 preview, no proposed changes.",
        },
      ],
      savedAt: "2026-11-01T10:00:00.000Z",
    });
    const restored = initialTurnsFor(task, false);
    expect(restored).toHaveLength(3);
    expect(restored[1]).toMatchObject({ role: "user", text: "trim the pause" });
  });

  it("starts one fresh live turn per lane when nothing is stored", () => {
    expect(initialTurnsFor(task, false)).toEqual([
      { id: "open-edit", role: "assistant", text: "Sending the turn to the agent…" },
    ]);
  });

  it("drops in-flight placeholders on restore; they never completed", () => {
    writeTaskThread({
      taskId: "task-3",
      taskName: "Detect silence and jump cuts",
      lane: "edit",
      status: "Scanning audio pauses",
      turns: [
        {
          id: "open",
          role: "assistant",
          text: "Done (req_0123456789): no previews, no proposed changes.",
        },
        { id: "user-9", role: "user", text: "one more pass" },
        { id: "assistant-9", role: "assistant", text: "Sending the turn to the agent…" },
      ],
      savedAt: "2026-11-01T10:00:00.000Z",
    });
    const restored = initialTurnsFor(task, false);
    expect(restored.map((turn) => turn.id)).toEqual(["open", "user-9"]);
  });

  it("keeps the demo stand-in out of the store either way", () => {
    writeTaskThread({
      taskId: "task-3",
      taskName: "Detect silence and jump cuts",
      lane: "edit",
      status: "Scanning audio pauses",
      turns: [{ id: "open", role: "assistant", text: "stored live text" }],
      savedAt: "2026-11-01T10:00:00.000Z",
    });
    const demo = initialTurnsFor(task, true);
    expect(demo).toHaveLength(1);
    expect(demo[0]?.text).toContain("stand-in, not a live agent");
  });
});

describe("opening-turn failure", () => {
  it("shows the error only when the turn never got going", () => {
    const fresh = withOpenTurnError(
      [{ id: "open", role: "assistant", text: "Sending the turn to the agent…" }],
      "Couldn't reach the agent.",
    );
    expect(fresh[0]?.text).toBe("Couldn't reach the agent.");
  });

  it("keeps stored text when the agent is unreachable; the store fills in", () => {
    const turns = withOpenTurnError(
      [
        {
          id: "open",
          role: "assistant",
          text: "Done (req_0123456789): no previews, no proposed changes.",
        },
        { id: "user-1", role: "user", text: "trim the pause" },
      ],
      "Couldn't reach the agent.",
    );
    expect(turns[0]?.text).toContain("Done (req_0123456789)");
    expect(turns[1]?.text).toBe("trim the pause");
  });
});

describe("runTurn", () => {
  it("submits the scoped edit turn and polls it to terminal", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const bodies: AgentJob[] = [job("queued"), job("in_progress"), job("completed")];
    const fetchFn: FetchFn = async (input, init) => {
      seen.push({ url: input, init });
      const next =
        input.endsWith("/jobs") && init?.method === "POST"
          ? {
              request_id: "req_0123456789abcdef",
              status: "queued",
              status_url: "http://127.0.0.1:8787/jobs/req_0123456789abcdef",
              cancel_url: "http://127.0.0.1:8787/jobs/req_0123456789abcdef/cancel",
            }
          : (bodies.shift() ?? bodies[0]);
      return { ok: true, status: 200, json: async () => next };
    };
    const client = createServicesClient({ fetchFn });
    const updates: AgentJobStatus[] = [];
    const loaded: RunningTask = {
      ...task,
      media: { proxyUrl: "file:///proxies/silence.mp4", baseRevision: "rev-9", totalFrames: 900 },
    };
    const finished = await runTurn(client, {
      task: loaded,
      brief: "remove the silence",
      key: noteKey("task-3", 7),
      changesetId: "cs-task-3-7",
      onUpdate: (current) => updates.push(current.status),
      delayForAttempt: () => 0,
    });

    expect(finished.status).toBe("completed");
    expect(updates).toEqual(["queued", "in_progress", "completed"]);
    const submit = seen[0];
    expect(submit?.url).toBe("http://127.0.0.1:8787/jobs");
    const headers = submit?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Idempotency-Key"]).toBe(noteKey("task-3", 7));
    const body = submit?.init?.body;
    expect(JSON.parse(typeof body === "string" ? body : "{}")).toMatchObject({
      task: "edit",
      input: {
        brief: "remove the silence",
        task_id: "task-3",
        proxy_url: "file:///proxies/silence.mp4",
        base_revision: "rev-9",
        total_frames: 900,
      },
    });
  });

  it("records the submitted turn so the live list can poll it", async () => {
    const fetchFn: FetchFn = async (input, init) =>
      input.endsWith("/jobs") && init?.method === "POST"
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              request_id: "req_live0000000001",
              status: "queued",
              status_url: "http://127.0.0.1:8787/jobs/req_live0000000001",
              cancel_url: "http://127.0.0.1:8787/jobs/req_live0000000001/cancel",
            }),
          }
        : {
            ok: true,
            status: 200,
            json: async () => job("completed", { request_id: "req_live0000000001" }),
          };
    const client = createServicesClient({ fetchFn });
    const finished = await runTurn(client, {
      task,
      brief: "remove the silence",
      key: noteKey("task-3", 9),
      changesetId: "cs-task-3-9",
      delayForAttempt: () => 0,
    });
    expect(finished.request_id).toBe("req_live0000000001");
    expect(liveJobEntries()).toEqual([["req_live0000000001", task]]);
  });
});

describe("live task list", () => {
  const prompted: RunningTask = {
    id: "task-prompt-7",
    name: "trim the silence",
    status: "Running",
    lane: "edit",
    plan: { brief: "trim the silence", lanes: ["edit"] },
  };

  it("maps a live job to its task row with lane and status", () => {
    const row = taskForLiveJob(
      job("in_progress", { request_id: "req_live1", input: { lane: "colour" } }),
      prompted,
    )!;
    expect(row).toMatchObject({
      id: "task-prompt-7",
      name: "trim the silence",
      status: "The agent is working",
      lane: "colour",
      jobId: "req_live1",
      jobStatus: "in_progress",
    });
    expect(row.plan).toEqual(prompted.plan);
    const queued = taskForLiveJob(job("queued", { request_id: "req_live2" }), prompted)!;
    expect(queued).toMatchObject({
      status: "Queued on the agent",
      lane: "edit",
      jobId: "req_live2",
      jobStatus: "queued",
    });
  });

  it("keeps the task lane when the job names none usable", () => {
    expect(taskForLiveJob(job("queued", { input: { lane: "grade" } }), prompted)!.lane).toBe(
      "edit",
    );
    expect(taskForLiveJob(job("queued", { input: {} }), prompted)!.lane).toBe("edit");
  });

  it("drops terminal and unknown jobs; empty in, empty out", () => {
    const terminal = (["completed", "failed", "moderated", "canceled"] as const).map(
      (status, index) => ({
        requestId: `req_terminal${index}`,
        task: prompted,
        job: job(status, { request_id: `req_terminal${index}` }),
      }),
    );
    const merged = liveRowsForJobs([
      ...terminal,
      { requestId: "req_unknown", task: prompted, job: null },
    ]);
    expect(merged.rows).toEqual([]);
    expect(merged.forget).toHaveLength(5);
    // Terminal jobs never resubmit; unknown ones may come back under the same key.
    expect(merged.settle).toHaveLength(4);
    expect(liveRowsForJobs([])).toEqual({ rows: [], forget: [], settle: [] });
  });

  it("keeps one row per task when turns overlap", () => {
    const merged = liveRowsForJobs([
      {
        requestId: "req_first",
        task: prompted,
        job: job("queued", { request_id: "req_first" }),
      },
      {
        requestId: "req_second",
        task: prompted,
        job: job("in_progress", { request_id: "req_second" }),
      },
    ]);
    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]).toMatchObject({ id: prompted.id, jobId: "req_second" });
    expect(merged.forget).toEqual([]);
    expect(merged.settle).toEqual([]);
  });

  it("reuses the opening job when the thread opens a live row", () => {
    const scope = openTurnScope(prompted.id, prompted.lane, true);
    const creationInput = inputForTurn(prompted, openingBrief(prompted), scope.changesetId);
    const row = taskForLiveJob(
      job("in_progress", { request_id: "req_live1", input: { lane: "edit" } }),
      prompted,
    )!;
    const reopen = openTurnScope(row.id, row.lane, true);
    expect(reopen.key).toBe(scope.key);
    expect(inputForTurn(row, openingBrief(row), reopen.changesetId)).toEqual(creationInput);
  });
});

describe("waiting and failed rows", () => {
  const prompted: RunningTask = {
    id: "task-prompt-7",
    name: "trim the silence",
    status: "Running",
    lane: "edit",
    plan: { brief: "trim the silence", lanes: ["edit"] },
  };

  it("shows a fresh task as waiting for the agent", () => {
    const rows = waitingRowsFor([prompted]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: prompted.id, name: "trim the silence" });
    expect(rows[0]?.status).toBe("Waiting for the agent");
  });

  it("marks a failed submit with the plain error, never swallowed", async () => {
    const failing: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const client = createServicesClient({ fetchFn: failing });
    await submitLiveTurn(client, prompted);
    expect(liveSubmitError(prompted.id)).toBe(
      "agent is unreachable at http://127.0.0.1:8787/jobs",
    );
    const rows = waitingRowsFor([prompted]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(
      "Failed: agent is unreachable at http://127.0.0.1:8787/jobs",
    );
  });

  it("clears the failure once a later submit succeeds", async () => {
    let calls = 0;
    const flaky: FetchFn = async (input, init) => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          request_id: "req_retry00000001",
          status: "queued",
          status_url: "http://127.0.0.1:8787/jobs/req_retry00000001",
          cancel_url: "http://127.0.0.1:8787/jobs/req_retry00000001/cancel",
        }),
      };
    };
    const client = createServicesClient({ fetchFn: flaky });
    await submitLiveTurn(client, prompted);
    expect(waitingRowsFor([prompted])[0]?.status).toContain("Failed:");
    await submitLiveTurn(client, prompted);
    expect(liveSubmitError(prompted.id)).toBeUndefined();
    // The job is live now, so the task leaves the waiting list.
    expect(waitingRowsFor([prompted])).toEqual([]);
  });

  it("retry clears the recorded failure so the next poll resubmits", async () => {
    const failing: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const client = createServicesClient({ fetchFn: failing });
    await submitLiveTurn(client, prompted);
    expect(waitingRowsFor([prompted])[0]?.status).toContain("Failed:");
    retryLiveTask(prompted.id);
    expect(liveSubmitError(prompted.id)).toBeUndefined();
    expect(waitingRowsFor([prompted])[0]?.status).toBe("Waiting for the agent");
  });

  it("hides submitted and settled tasks from the waiting list", () => {
    recordLiveJob("req_waiting1", prompted);
    expect(waitingRowsFor([prompted])).toEqual([]);
  });
});

describe("turn model and files", () => {
  it("carries the draft model and files on the turn input", () => {
    const input = inputForTurn(task, "trim the pause", "cs-task-3-7", {
      model: "muse-spark-1 (Meta)",
      files: ["silence.mp4"],
    });
    expect(input).toMatchObject({
      brief: "trim the pause",
      model: "muse-spark-1 (Meta)",
      files: ["silence.mp4"],
    });
  });

  it("leaves model and files off opening turns", () => {
    const input = inputForTurn(task, "trim the pause", "cs-task-3-open");
    expect(input).not.toHaveProperty("model");
    expect(input).not.toHaveProperty("files");
  });

  it("pairs a composer draft with the note it sent", () => {
    const draft = { text: "trim the pause", files: ["a.mp4"], model: "Chair fast" };
    expect(selectionForNote({ id: 7, text: "trim the pause" }, draft)).toEqual({
      files: ["a.mp4"],
      model: "Chair fast",
    });
    expect(selectionForNote({ id: 7, text: "other words" }, draft)).toBeNull();
    expect(selectionForNote({ id: 7, text: "trim the pause" }, null)).toBeNull();
  });

  it("names attachments in the user turn and the brief", () => {
    expect(noteTurnText({ id: 7, text: "trim the pause" })).toBe("trim the pause");
    expect(noteTurnText({ id: 7, text: "  trim the pause  ", files: ["a.mp4"] })).toBe(
      "trim the pause\nAttached files: a.mp4",
    );
    expect(noteTurnText({ id: 7, text: "   ", files: ["a.mp4", "b.webm"] })).toBe(
      "Attached files: a.mp4, b.webm",
    );
    expect(noteTurnText({ id: 7, text: "   " })).toBe("");
  });

  it("names the turn model on live and terminal copy", () => {
    const queued = textForJob(job("queued", { input: { model: "Chair fast" } }));
    expect(queued).toContain("Model: Chair fast.");
    const done = textForJob(
      job("completed", { input: { model: "muse-spark-1 (Meta)" } }),
    );
    expect(done).toContain("Model: muse-spark-1 (Meta).");
    expect(textForJob(job("completed"))).not.toContain("Model:");
  });

  it("submits note turns with model and files in the body", async () => {
    let body: unknown = null;
    const fetchFn: FetchFn = async (input, init) => {
      if (input.endsWith("/jobs") && init?.method === "POST") {
        body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            request_id: "req_model00000001",
            status: "queued",
            status_url: "http://127.0.0.1:8787/jobs/req_model00000001",
            cancel_url: "http://127.0.0.1:8787/jobs/req_model00000001/cancel",
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => job("completed", { request_id: "req_model00000001" }),
      };
    };
    const client = createServicesClient({ fetchFn });
    await runTurn(client, {
      task,
      brief: "remove the silence",
      key: noteKey("task-3", 7),
      changesetId: "cs-task-3-7",
      model: "Chair fast",
      files: ["a.mp4"],
      delayForAttempt: () => 0,
    });
    expect(body).toMatchObject({
      task: "edit",
      input: {
        brief: "remove the silence",
        model: "Chair fast",
        files: ["a.mp4"],
      },
    });
  });
});

describe("stopLiveTask", () => {
  const live: RunningTask = {
    id: "task-prompt-7",
    name: "trim the silence",
    status: "Queued on the agent",
    lane: "edit",
    jobId: "req_live1",
    jobStatus: "queued",
  };

  it("cancels the row's live job", async () => {
    const cancelAgentJob = vi.fn(async () => job("canceled", { request_id: "req_live1" }));
    const client = { cancelAgentJob } as unknown as ServicesClient;
    const stopped = await stopLiveTask(client, live);
    expect(cancelAgentJob).toHaveBeenCalledWith("req_live1");
    expect(stopped?.status).toBe("canceled");
  });

  it("cancels nothing when the row has no live job", async () => {
    const cancelAgentJob = vi.fn(async () => job("canceled"));
    const client = { cancelAgentJob } as unknown as ServicesClient;
    const { jobId: _jobId, jobStatus: _jobStatus, ...unsubmitted } = live;
    expect(await stopLiveTask(client, unsubmitted)).toBeNull();
    expect(cancelAgentJob).not.toHaveBeenCalled();
  });
});

describe("poll failures", () => {
  it("counts consecutive misses per job and clears on a good poll", () => {
    expect(POLL_FAIL_LIMIT).toBe(3);
    expect(notePollFailure("req-a", "down")).toBe(1);
    expect(notePollFailure("req-a", "down")).toBe(2);
    expect(notePollFailure("req-b", "down")).toBe(1);
    clearPollFailure("req-a");
    expect(notePollFailure("req-a", "down")).toBe(1);
  });
});

describe("hasSoundItems", () => {
  const done = (ops: Record<string, unknown>[]) =>
    job("completed", { changeset: { status: "proposed", ops } });

  it("sees ducking, audio tracks, and sound clips", () => {
    expect(hasSoundItems(done([{ op: "set_gain", patch: { gainDb: -12 } }]))).toBe(true);
    expect(
      hasSoundItems(done([{ op: "add_track", patch: { track: { id: "audio-sfx-1", kind: "audio" } } }])),
    ).toBe(true);
    expect(
      hasSoundItems(
        done([{ op: "add_clip", targetId: "audio-sfx-1", patch: { clipId: "sfx-riser-1", kind: "riser" } }]),
      ),
    ).toBe(true);
  });

  it("ignores picture edits and effect ops", () => {
    expect(hasSoundItems(done([{ op: "trim", patch: {} }]))).toBe(false);
    expect(
      hasSoundItems(done([{ op: "add_track", patch: { track: { id: "v2", kind: "video" } } }])),
    ).toBe(false);
    expect(
      hasSoundItems(done([{ op: "add_clip", targetId: "v1", patch: { clipId: "clip-b" } }])),
    ).toBe(false);
    expect(hasSoundItems(done([{ op: "add_effect", patch: {} }]))).toBe(false);
    expect(hasSoundItems(job("completed"))).toBe(false);
  });
});

describe("finished sound writes", () => {
  const soundJob = () =>
    job("completed", {
      request_id: "req_sound1",
      changeset: { status: "proposed", ops: [{ op: "set_gain", patch: { gainDb: -12 } }] },
    });
  const appliedBody = {
    timeline_name: "Demo Cut (sound copy)",
    original_timeline: "Demo Cut",
    tracks_added: 1,
    clips_added: 2,
    skipped: [{ intent: "sting", reason: "no sting in the library" }],
    fallback: "set the Fairlight ducking by hand",
  };
  const reply =
    (status: number, body: unknown): FetchFn =>
    async () => ({ ok: status < 400, status, json: async () => body });

  it("writes by job id and lands the card line with skipped reasons", async () => {
    let seen: unknown = null;
    const fetchFn: FetchFn = async (_url, init) => {
      seen = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => appliedBody };
    };
    await applyFinishedSound({ requestId: "req_sound1", task, job: soundJob() }, { fetchFn });
    expect(seen).toEqual({ jobId: "req_sound1" });
    const landed = landedFor(task.id)!;
    expect(landed.state).toBe("landed");
    expect(landed.line).toBe("Added to Demo Cut (sound copy) · 1 skipped");
    expect(landed.detail).toContain("Skipped sting: no sting in the library");
    expect(landed.detail).toContain("Fallback: set the Fairlight ducking by hand");
    expect(landedRowsFor([task])).toMatchObject([{ id: task.id, status: landed.line }]);
  });

  it("records a failed write the card can retry", async () => {
    const fetchFn = reply(503, { error: "Resolve is not running" });
    await applyFinishedSound({ requestId: "req_sound1", task, job: soundJob() }, { fetchFn });
    expect(landedFor(task.id)).toMatchObject({ state: "failed", line: "Failed: Resolve is not running" });
    expect(landedRowsFor([task])).toHaveLength(1);
    retryLandedWrite(task.id, { fetchFn: reply(200, appliedBody) });
    await vi.waitFor(() => expect(landedFor(task.id)?.state).toBe("landed"));
  });

  it("leaves non-sound jobs alone", async () => {
    const fetchFn = vi.fn(reply(200, appliedBody));
    const plain = job("completed", { changeset: { status: "proposed", ops: [{ op: "trim" }] } });
    await applyFinishedSound({ requestId: "req_plain", task, job: plain }, { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(landedFor(task.id)).toBeUndefined();
    expect(landedRowsFor([task])).toEqual([]);
  });

  it("undoes back to the original and redoes as a new copy", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push(`${url} ${String(init?.body)}`);
      if (url.endsWith("/sounds/revert")) {
        return { ok: true, status: 200, json: async () => ({ timeline: "Demo Cut", project: "" }) };
      }
      return { ok: true, status: 200, json: async () => appliedBody };
    };
    await applyFinishedSound({ requestId: "req_sound1", task, job: soundJob() }, { fetchFn });
    expect(await undoLandedWrite(task.id, { fetchFn })).toBe(true);
    expect(landedFor(task.id)).toMatchObject({
      state: "undone",
      line: "Back on Demo Cut — copy kept",
    });
    expect(calls[1]).toContain("/sounds/revert");
    expect(calls[1]).toContain('"originalTimeline":"Demo Cut"');
    expect(await redoLandedWrite(task.id, { fetchFn })).toBe(true);
    expect(landedFor(task.id)).toMatchObject({ state: "landed" });
    expect(calls[2]).toContain("/sounds/apply");
  });

  it("keeps Undo available when the revert fails", async () => {
    await applyFinishedSound(
      { requestId: "req_sound1", task, job: soundJob() },
      { fetchFn: reply(200, appliedBody) },
    );
    const ok = await undoLandedWrite(task.id, { fetchFn: reply(404, {}) });
    expect(ok).toBe(false);
    expect(landedFor(task.id)).toMatchObject({
      state: "landed",
      line: "Undo failed: Undo isn't available on this agent yet.",
    });
  });
});

describe("maybeApplyFinishedSound", () => {
  const soundEntry = (requestId: string) => ({
    requestId,
    task,
    job: job("completed", {
      request_id: requestId,
      changeset: { status: "proposed", ops: [{ op: "set_gain", patch: { gainDb: -12 } }] },
    }),
  });

  it("settles once the card's write state lands, firing only once per job", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        timeline_name: "Demo Cut (sound copy)",
        original_timeline: "Demo Cut",
        tracks_added: 1,
        clips_added: 1,
        skipped: [],
      }),
    }));
    const first = maybeApplyFinishedSound(soundEntry("req_shared"), { fetchFn });
    const second = maybeApplyFinishedSound(soundEntry("req_shared"), { fetchFn });
    expect(second).toBe(first);
    expect(landedFor(task.id)).toBeUndefined();
    await first;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(landedFor(task.id)?.state).toBe("landed");
  });

  it("resolves at once when there is nothing to write", async () => {
    const plain = job("completed", { changeset: { status: "proposed", ops: [{ op: "trim" }] } });
    await expect(
      maybeApplyFinishedSound({ requestId: "req_plain2", task, job: plain }),
    ).resolves.toBeUndefined();
    expect(landedFor(task.id)).toBeUndefined();
  });
});

describe("maybeApplyFinishedCut", () => {
  const cutEntry = (requestId: string) => ({
    requestId,
    task,
    job: job("completed", {
      request_id: requestId,
      changeset: {
        status: "proposed",
        ops: [{ op: "trim", targetId: "clip-a", patch: { trimStartFrames: 4 } }],
      },
    }),
  });

  it("settles once the card's write state lands, firing only once per job", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        timeline_name: "Demo Cut (cut copy)",
        original_timeline: "Demo Cut",
        clips_changed: 1,
        skipped: [],
      }),
    }));
    const first = maybeApplyFinishedCut(cutEntry("req_shared_cut"), { fetchFn });
    const second = maybeApplyFinishedCut(cutEntry("req_shared_cut"), { fetchFn });
    expect(second).toBe(first);
    expect(landedFor(task.id)).toBeUndefined();
    await first;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(landedFor(task.id)).toMatchObject({ state: "landed", kind: "cut" });
  });

  it("resolves at once when there is nothing to write", async () => {
    const sound = job("completed", {
      changeset: { status: "proposed", ops: [{ op: "set_gain", patch: { gainDb: -12 } }] },
    });
    await expect(
      maybeApplyFinishedCut({ requestId: "req_sound2", task, job: sound }),
    ).resolves.toBeUndefined();
    expect(landedFor(task.id)).toBeUndefined();
  });
});

describe("thread header status", () => {
  const base: HeaderState = {
    terminal: null,
    landed: null,
    step: null,
    live: true,
    fallback: "Waiting for the agent",
  };

  it("reads the live step off the rail", () => {
    expect(activeStepLabel(activityForLiveJob(job("in_progress")))).toBe("Agent working");
    expect(activeStepLabel(activityForLivePending())).toBe("Sending the turn…");
    expect(activeStepLabel(activityForLiveError("Agent unreachable"))).toBeNull();
    expect(activeStepLabel(null)).toBeNull();
  });

  it("names the card's write state first", () => {
    expect(headerStatusFor({ ...base, terminal: "completed", landed: "landed" })).toBe("Landed");
    expect(headerStatusFor({ ...base, terminal: "completed", landed: "undone" })).toBe("Undone");
    expect(headerStatusFor({ ...base, terminal: "completed", landed: "failed" })).toBe("Failed");
  });

  it("names the settled turn when nothing wrote", () => {
    expect(headerStatusFor({ ...base, terminal: "failed" })).toBe("Failed");
    expect(headerStatusFor({ ...base, terminal: "canceled" })).toBe("Stopped");
    expect(headerStatusFor({ ...base, terminal: "moderated" })).toBe("Stopped");
    expect(headerStatusFor({ ...base, terminal: "completed" })).toBe("Planned");
  });

  it("shows the live step while running, else the spinner or the fallback", () => {
    expect(headerStatusFor({ ...base, step: "Sending the turn…" })).toBe("Sending the turn…");
    expect(headerStatusFor({ ...base })).toBeNull();
    expect(headerStatusFor({ ...base, live: false })).toBe("Waiting for the agent");
    expect(headerStatusFor({ ...base, terminal: "in_progress", step: "Agent working" })).toBe(
      "Agent working",
    );
  });
});

describe("hasCutItems", () => {
  const done = (ops: Record<string, unknown>[]) =>
    job("completed", { changeset: { status: "proposed", ops } });

  it("sees trims, moves, ripples, removals, markers, and picture inserts", () => {
    expect(hasCutItems(done([{ op: "trim", patch: { trimStartFrames: 4 } }]))).toBe(true);
    expect(
      hasCutItems(done([{ op: "move", patch: { toTrackId: "v2", startFrames: 96 } }])),
    ).toBe(true);
    expect(hasCutItems(done([{ op: "ripple", patch: { shiftFrames: 24 } }]))).toBe(true);
    expect(hasCutItems(done([{ op: "remove_clip", patch: {} }]))).toBe(true);
    expect(
      hasCutItems(done([{ op: "add_clip", targetId: "v1", patch: { clipId: "clip-b" } }])),
    ).toBe(true);
    expect(
      hasCutItems(done([{ op: "add_track", patch: { track: { id: "v2", kind: "video" } } }])),
    ).toBe(true);
    expect(hasCutItems(done([{ op: "add_marker", patch: {} }]))).toBe(true);
  });

  it("ignores sound shapes, effect ops, and unsupported cuts", () => {
    expect(hasCutItems(done([{ op: "set_gain", patch: { gainDb: -12 } }]))).toBe(false);
    expect(
      hasCutItems(done([{ op: "add_track", patch: { track: { id: "audio-sfx-1", kind: "audio" } } }])),
    ).toBe(false);
    expect(
      hasCutItems(
        done([{ op: "add_clip", targetId: "audio-sfx-1", patch: { clipId: "sfx-riser-1", kind: "riser" } }]),
      ),
    ).toBe(false);
    expect(hasCutItems(done([{ op: "add_effect", patch: {} }]))).toBe(false);
    expect(hasCutItems(done([{ op: "set_speed", patch: { rate: 2 } }]))).toBe(false);
    expect(hasCutItems(done([{ op: "add_transition", patch: {} }]))).toBe(false);
    expect(hasCutItems(job("completed"))).toBe(false);
  });
});

describe("finished cut writes", () => {
  const cutJob = () =>
    job("completed", {
      request_id: "req_cut1",
      changeset: {
        status: "proposed",
        ops: [{ op: "trim", targetId: "clip-a", patch: { trimStartFrames: 12 } }],
      },
    });
  const appliedBody = {
    timeline_name: "Demo Cut (cut copy)",
    original_timeline: "Demo Cut",
    clips_added: 0,
    clips_removed: 0,
    clips_changed: 1,
    markers_added: 0,
    skipped: [{ intent: "spd-1", reason: "retime the clip in Studio by hand" }],
    fallback: null,
  };
  const reply =
    (status: number, body: unknown): FetchFn =>
    async () => ({ ok: status < 400, status, json: async () => body });

  it("writes by job id and lands the card line with skipped reasons", async () => {
    let seen: unknown = null;
    const fetchFn: FetchFn = async (_url, init) => {
      seen = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => appliedBody };
    };
    await applyFinishedCut({ requestId: "req_cut1", task, job: cutJob() }, { fetchFn });
    expect(seen).toEqual({ jobId: "req_cut1" });
    const landed = landedFor(task.id)!;
    expect(landed.state).toBe("landed");
    expect(landed.kind).toBe("cut");
    expect(landed.line).toBe("Added to Demo Cut (cut copy) · 1 skipped");
    expect(landed.detail).toContain("Skipped spd-1: retime the clip in Studio by hand");
    expect(landed.skipped).toEqual([
      { intent: "spd-1", reason: "retime the clip in Studio by hand" },
    ]);
    expect(landedRowsFor([task])).toMatchObject([{ id: task.id, status: landed.line }]);
  });

  it("records a failed write the card can retry", async () => {
    const fetchFn = reply(503, { error: "Resolve is not running" });
    await applyFinishedCut({ requestId: "req_cut1", task, job: cutJob() }, { fetchFn });
    expect(landedFor(task.id)).toMatchObject({ state: "failed", line: "Failed: Resolve is not running" });
    expect(landedRowsFor([task])).toHaveLength(1);
    retryLandedWrite(task.id, { fetchFn: reply(200, appliedBody) });
    await vi.waitFor(() => expect(landedFor(task.id)?.state).toBe("landed"));
  });

  it("leaves sound and mixed jobs on the sound route", async () => {
    const fetchFn = vi.fn(reply(200, appliedBody));
    const sound = job("completed", {
      changeset: { status: "proposed", ops: [{ op: "set_gain", patch: { gainDb: -12 } }] },
    });
    await applyFinishedCut({ requestId: "req_sound", task, job: sound }, { fetchFn });
    const mixed = job("completed", {
      changeset: {
        status: "proposed",
        ops: [
          { op: "trim", targetId: "clip-a", patch: { trimStartFrames: 12 } },
          { op: "set_gain", patch: { gainDb: -12 } },
        ],
      },
    });
    await applyFinishedCut({ requestId: "req_mixed", task, job: mixed }, { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(landedFor(task.id)).toBeUndefined();
  });

  it("undoes back to the original and redoes as a new copy", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push(`${url} ${String(init?.body)}`);
      if (url.endsWith("/cuts/undo")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ current_timeline: "Demo Cut", deleted: false }),
        };
      }
      return { ok: true, status: 200, json: async () => appliedBody };
    };
    await applyFinishedCut({ requestId: "req_cut1", task, job: cutJob() }, { fetchFn });
    expect(await undoLandedWrite(task.id, { fetchFn })).toBe(true);
    expect(landedFor(task.id)).toMatchObject({
      state: "undone",
      line: "Back on Demo Cut — copy kept",
    });
    expect(calls[1]).toContain("/cuts/undo");
    expect(calls[1]).toContain('"original_timeline":"Demo Cut"');
    expect(await redoLandedWrite(task.id, { fetchFn })).toBe(true);
    expect(landedFor(task.id)).toMatchObject({ state: "landed", kind: "cut" });
    expect(calls[2]).toContain("/cuts/apply");
  });

  it("keeps Undo available when the revert fails", async () => {
    await applyFinishedCut(
      { requestId: "req_cut1", task, job: cutJob() },
      { fetchFn: reply(200, appliedBody) },
    );
    const ok = await undoLandedWrite(task.id, { fetchFn: reply(404, {}) });
    expect(ok).toBe(false);
    expect(landedFor(task.id)).toMatchObject({
      state: "landed",
      line: "Undo failed: Undo isn't available on this agent yet.",
    });
  });
});
