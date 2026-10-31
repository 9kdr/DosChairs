/**
 * Thread data for one running task: live agent turns over the service link.
 *
 * Opening a task starts (or resumes, via a stable idempotency key) one real
 * agent turn scoped to that task; every note after that starts its own turn.
 * Poll updates stream each turn's live status into the thread, and the
 * terminal job record becomes the reply: real request ids, real artifact and
 * proposal counts, or the agent's verbatim error. Nothing here applies a
 * changeset or touches the timeline; finished turns only describe proposals.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ServiceError, type ServicesClient } from "../lib/services/client";
import { agentBaseUrl } from "../lib/services/config";
import { isAgentTerminal } from "../lib/services/types";
import type { AgentJob } from "../lib/services/types";
import { useServicesClient } from "../lib/services/useServices";
import type { RunningTask } from "./RunningTasks";
import type { TaskActivity } from "./TaskActivity";

export type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type TaskNote = {
  id: number;
  text: string;
};

/** Offline demos keep the old stand-in thread behind this flag. Default is live. */
export function isThreadDemo(env?: Record<string, string | undefined>): boolean {
  const source =
    env ?? (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return source?.VITE_CHAIR_THREAD_DEMO === "1";
}

const DEMO_OPENING: Record<string, string> = {
  "task-1": "A-roll is lining up on V1. The face stays through the question.",
  "task-2": "The highlight is sitting on the hook, not on the room.",
  "task-3": "Pauses are marked. Nothing has been cut yet.",
  "task-4": "Shot 04 is being balanced to the reference still.",
};

const DEMO_NOTE_REPLY = (name: string) =>
  `Still on ${name}. I kept that note. The timeline is unchanged.`;

const EDIT_TASK = "edit";
const IDEMPOTENCY_PREFIX = "chair-task-thread-v1";
const SENDING = "Sending the turn to the agent…";

/** Stable per task, so reopening a task resumes its opening turn. */
export function openingKey(taskId: string): string {
  return `${IDEMPOTENCY_PREFIX}:${taskId}:open`;
}

/** One turn per note, scoped to its task. */
export function noteKey(taskId: string, noteId: number): string {
  return `${IDEMPOTENCY_PREFIX}:${taskId}:${noteId}`;
}

export function briefForOpening(task: RunningTask): string {
  return `${task.name}. ${task.status}.`;
}

export function inputForTurn(
  task: RunningTask,
  brief: string,
  changesetId: string,
): Record<string, unknown> {
  return {
    brief,
    task_id: task.id,
    lane: task.lane,
    target_id: task.id,
    changeset_id: changesetId,
    // Declared absent, not stand-in: the thread has no proxy loaded, so it
    // says so with empty values instead of inventing media context.
    proxy_url: "",
    base_revision: "",
    total_frames: 0,
    spans: [],
    preview_urls: [],
  };
}

/** Submit one turn and poll it to a terminal state, streaming updates. */
export async function runTurn(
  client: ServicesClient,
  turn: {
    task: RunningTask;
    brief: string;
    key: string;
    changesetId: string;
    onUpdate?: (job: AgentJob) => void;
    delayForAttempt?: (attempt: number) => number;
  },
): Promise<AgentJob> {
  const handle = await client.submitAgentJob(
    EDIT_TASK,
    inputForTurn(turn.task, turn.brief, turn.changesetId),
    { idempotencyKey: turn.key },
  );
  return client.pollAgentJob(handle.request_id, {
    onUpdate: turn.onUpdate,
    delayForAttempt: turn.delayForAttempt,
  });
}

export function shortRequestId(requestId: string): string {
  return requestId.length > 13 ? `${requestId.slice(0, 13)}…` : requestId;
}

/** The thread line for a live job: running status, or the real terminal reply. */
export function textForJob(job: AgentJob): string {
  const id = shortRequestId(job.request_id);
  if (job.status === "queued") return `Turn sent — queued on the agent (${id}).`;
  if (job.status === "in_progress") return `The agent is working on it (${id}).`;
  if (job.status === "failed") {
    return `The agent couldn't finish this turn (${id}): ${job.error ?? "it failed without a reason"}. Nothing changed.`;
  }
  if (job.status === "moderated") {
    return `The agent stopped this turn (${id}): ${job.error ?? "moderated"}. Nothing changed.`;
  }
  if (job.status === "canceled") return `This turn was canceled (${id}). Nothing changed.`;
  const previews = job.artifacts.length;
  const ops = job.changeset?.ops.length ?? 0;
  const previewBit =
    previews === 0 ? "no previews" : previews === 1 ? "1 preview" : `${previews} previews`;
  const opBit =
    ops === 0 ? "no proposed changes" : ops === 1 ? "1 proposed change" : `${ops} proposed changes`;
  let text =
    `Done (${id}): ${previewBit}, ${opBit}. ` +
    "Proposed edits stay proposals until you accept each one from Review — the timeline is unchanged.";
  if (previews > 0) {
    text += ` Preview files: ${job.artifacts.map((artifact) => artifact.url).join(", ")}.`;
  }
  return text;
}

/** Honest submit failure: down (with the fix) versus refused (with the reason). */
export function replyForSubmitError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unreachable";
  if (error instanceof ServiceError && error.status != null) {
    return `The agent refused this turn: ${message}. Nothing changed.`;
  }
  return (
    `Couldn't reach the agent (${agentBaseUrl()}): ${message}. ` +
    "Start it with mise run dev:agent, then reopen the task. Nothing changed."
  );
}

export function headlineForSubmitError(error: unknown): string {
  return error instanceof ServiceError && error.status != null
    ? "Turn refused"
    : "Agent unreachable";
}

/** Same { headline, progress, steps } shape as the rail already uses, from the live run. */
export function activityForLiveJob(job: AgentJob): TaskActivity {
  const id = shortRequestId(job.request_id);
  const sent = { id: "sent", label: `Turn sent (${id})`, state: "done" as const };
  if (job.status === "queued") {
    return {
      headline: "Queued on the agent",
      progress: 1 / 3,
      steps: [
        sent,
        { id: "working", label: "Waiting for the agent", state: "active" },
        { id: "result", label: "Result", state: "queued" },
      ],
    };
  }
  if (job.status === "in_progress") {
    return {
      headline: "The agent is working",
      progress: 2 / 3,
      steps: [
        sent,
        { id: "working", label: "Agent working", state: "active" },
        { id: "result", label: "Result", state: "queued" },
      ],
    };
  }
  const previews = job.artifacts.length;
  const ops = job.changeset?.ops.length ?? 0;
  const previewBit =
    previews === 0 ? "no previews" : previews === 1 ? "1 preview" : `${previews} previews`;
  const opBit =
    ops === 0 ? "no proposed changes" : ops === 1 ? "1 proposed change" : `${ops} proposed changes`;
  const done =
    job.status === "completed"
      ? { headline: `Done: ${opBit}, ${previewBit}`, result: `Done: ${opBit}, ${previewBit}` }
      : job.status === "failed"
        ? {
            headline: "Couldn't finish the turn",
            result: `Failed: ${firstLine(job.error ?? "failed")}`,
          }
        : job.status === "moderated"
          ? {
              headline: "Turn stopped: moderated",
              result: `Stopped: ${firstLine(job.error ?? "moderated")}`,
            }
          : { headline: "Turn canceled", result: "Canceled" };
  return {
    headline: done.headline,
    progress: 1,
    steps: [
      sent,
      { id: "working", label: "Agent finished", state: "done" },
      { id: "result", label: done.result, state: "done" },
    ],
  };
}

export function activityForLivePending(): TaskActivity {
  return {
    headline: "Starting the turn…",
    progress: 0,
    steps: [
      { id: "sent", label: "Sending the turn…", state: "active" },
      { id: "working", label: "Agent working", state: "queued" },
      { id: "result", label: "Result", state: "queued" },
    ],
  };
}

export function activityForLiveError(headline: string): TaskActivity {
  return {
    headline,
    progress: 0,
    steps: [
      { id: "sent", label: "Turn not sent", state: "queued" },
      { id: "working", label: "Agent working", state: "queued" },
      { id: "result", label: "Result", state: "queued" },
    ],
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.slice(0, 90);
}

/**
 * One task's thread: turns plus the activity rail's live state (null while the
 * demo flag owns the rail). Notes the local resolver answers (undo summaries)
 * stay local; every other note starts a live turn. Sending never changes the
 * timeline.
 */
export function useTaskThread(
  task: RunningTask,
  note: TaskNote | null,
  resolveLocalReply?: (text: string) => string | null,
): { turns: Turn[]; activity: TaskActivity | null } {
  const client = useServicesClient();
  const demo = useMemo(() => isThreadDemo(), []);
  const [turns, setTurns] = useState<Turn[]>(() => [
    {
      id: "open",
      role: "assistant",
      text: demo
        ? `${DEMO_OPENING[task.id] ?? task.status} This is a stand-in, not a live agent.`
        : SENDING,
    },
  ]);
  const [activity, setActivity] = useState<TaskActivity | null>(() =>
    demo ? null : activityForLivePending(),
  );
  const openedRef = useRef<string | null>(null);
  const seenNote = useRef<number | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (demo || openedRef.current === task.id) return;
    openedRef.current = task.id;
    seenNote.current = null;
    const id = task.id;
    const live = (apply: () => void) => {
      if (taskRef.current.id === id) apply();
    };
    void runTurn(client, {
      task,
      brief: briefForOpening(task),
      key: openingKey(id),
      changesetId: `cs-${id}-open`,
      onUpdate: (job) => {
        if (isAgentTerminal(job.status)) return;
        live(() => {
          setTurns((current) =>
            current.map((turn) => (turn.id === "open" ? { ...turn, text: textForJob(job) } : turn)),
          );
          setActivity(activityForLiveJob(job));
        });
      },
    }).then(
      (job) =>
        live(() => {
          setTurns((current) =>
            current.map((turn) => (turn.id === "open" ? { ...turn, text: textForJob(job) } : turn)),
          );
          setActivity(activityForLiveJob(job));
        }),
      (error: unknown) =>
        live(() => {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === "open" ? { ...turn, text: replyForSubmitError(error) } : turn,
            ),
          );
          setActivity(activityForLiveError(headlineForSubmitError(error)));
        }),
    );
  }, [task, client, demo]);

  useEffect(() => {
    if (!note || seenNote.current === note.id) return;
    seenNote.current = note.id;
    const text = note.text.trim();
    if (!text) return;
    const local = resolveLocalReply?.(text) ?? null;
    const userTurn: Turn = { id: `user-${note.id}`, role: "user", text };
    if (demo || local) {
      const reply = local ?? DEMO_NOTE_REPLY(task.name);
      setTurns((current) => [
        ...current,
        userTurn,
        { id: `assistant-${note.id}`, role: "assistant", text: reply },
      ]);
      return;
    }
    const id = task.id;
    const liveId = `assistant-${note.id}`;
    const live = (apply: () => void) => {
      if (taskRef.current.id === id) apply();
    };
    setTurns((current) => [...current, userTurn, { id: liveId, role: "assistant", text: SENDING }]);
    setActivity(activityForLivePending());
    void runTurn(client, {
      task,
      brief: text,
      key: noteKey(id, note.id),
      changesetId: `cs-${id}-${note.id}`,
      onUpdate: (job) => {
        if (isAgentTerminal(job.status)) return;
        live(() => {
          setTurns((current) =>
            current.map((turn) => (turn.id === liveId ? { ...turn, text: textForJob(job) } : turn)),
          );
          setActivity(activityForLiveJob(job));
        });
      },
    }).then(
      (job) =>
        live(() => {
          setTurns((current) =>
            current.map((turn) => (turn.id === liveId ? { ...turn, text: textForJob(job) } : turn)),
          );
          setActivity(activityForLiveJob(job));
        }),
      (error: unknown) =>
        live(() => {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === liveId ? { ...turn, text: replyForSubmitError(error) } : turn,
            ),
          );
          setActivity(activityForLiveError(headlineForSubmitError(error)));
        }),
    );
  }, [note, task, client, demo, resolveLocalReply]);

  return useMemo(() => ({ turns, activity }), [turns, activity]);
}
