import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServicesClient, ServiceError, type FetchFn } from "../lib/services/client";
import type { AgentJob, AgentJobStatus } from "../lib/services/types";
import type { RunningTask } from "./RunningTasks";
import {
  activityForLiveError,
  activityForLiveJob,
  activityForLivePending,
  briefForOpening,
  headlineForSubmitError,
  initialTurnsFor,
  inputForTurn,
  isThreadDemo,
  noteKey,
  openingKey,
  openTurnScope,
  replyForSubmitError,
  runTurn,
  shortRequestId,
  textForJob,
  withOpenTurnError,
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

  it("briefs the opening turn from the task itself", () => {
    const brief = briefForOpening(task);
    expect(brief).toContain("Detect silence and jump cuts");
    expect(brief).toContain("Scanning audio pauses");
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
      spans: [],
      preview_urls: [],
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

  it("streams the live request id while the turn runs", () => {
    const queued = textForJob(job("queued"));
    const working = textForJob(job("in_progress"));
    expect(queued).toContain(shortRequestId("req_0123456789abcdef"));
    expect(working).toContain(shortRequestId("req_0123456789abcdef"));
    expect(queued).not.toContain("stand-in");
    expect(working).not.toContain("stand-in");
  });

  it("reports the real completed result as proposals only", () => {
    const text = textForJob(
      job("completed", {
        artifacts: [{ url: "http://127.0.0.1:8787/p/preview.mp4" }],
        changeset: { status: "proposed", ops: [{ id: "op-1" }, { id: "op-2" }] },
      }),
    );
    expect(text).toContain("1 preview");
    expect(text).toContain("2 proposed changes");
    expect(text).toContain("http://127.0.0.1:8787/p/preview.mp4");
    expect(text).toContain("stay proposals until you accept each one from Review");
    expect(text).toContain("the timeline is unchanged");
  });

  it("says plainly when the agent proposed nothing", () => {
    const text = textForJob(job("completed"));
    expect(text).toContain("no previews, no proposed changes");
    expect(text).toContain("the timeline is unchanged");
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
    expect(done.headline).toContain("1 proposed change");
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
});
