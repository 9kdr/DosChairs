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
import type { RunningTask, TaskLane } from "./RunningTasks";
import type { TaskActivity } from "./TaskActivity";
import { readTaskThread, writeTaskThread } from "./threadStore";
import { gatedAgentText, spawnSubagents } from "./taskSetup";
import type { Subagent } from "./taskSetup";

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

/**
 * Opening turns for a task: the demo stand-in behind the flag, else the
 * stored thread with in-flight placeholders dropped (they never
 * completed), else one fresh live turn per lane subagent. Live data
 * replaces stored text as it loads, per the #132 rule.
 */
export function initialTurnsFor(
  task: RunningTask,
  demo: boolean,
  agents: Subagent[] = spawnSubagents(task),
): Turn[] {
  if (demo) {
    return [
      {
        id: "open",
        role: "assistant",
        text: `${DEMO_OPENING[task.id] ?? task.status} This is a stand-in, not a live agent.`,
      },
    ];
  }
  const stored = readTaskThread(task.id)?.turns.filter(
    (turn) => turn.role !== "assistant" || turn.text !== SENDING,
  );
  if (stored && stored.length > 0) return stored;
  return agents.map((agent, index) => ({
    id: openTurnScope(task.id, agent.lane, index === 0).id,
    role: "assistant",
    text: agent.runnable ? SENDING : gatedAgentText(agent),
  }));
}

/**
 * A failed opening turn fills in from the store, never with the error:
 * stored (or already-streamed) text stays; only a turn that never got
 * going shows the failure. The rail still carries the error headline.
 */
export function withOpenTurnError(turns: Turn[], errorText: string): Turn[] {
  return turns.map((turn) =>
    turn.id === "open" && turn.text === SENDING ? { ...turn, text: errorText } : turn,
  );
}

/** Stable per task, so reopening a task resumes its opening turn. */
export function openingKey(taskId: string): string {
  return `${IDEMPOTENCY_PREFIX}:${taskId}:open`;
}

/** One turn per note, scoped to its task. */
export function noteKey(taskId: string, noteId: number): string {
  return `${IDEMPOTENCY_PREFIX}:${taskId}:${noteId}`;
}

/**
 * Identity for one subagent's opening turn. The primary lane keeps the
 * original key and changeset so reopening still resumes its turn.
 */
export function openTurnScope(
  taskId: string,
  lane: TaskLane,
  primary: boolean,
): { id: string; key: string; changesetId: string } {
  return {
    id: `open-${lane}`,
    key: primary ? openingKey(taskId) : `${openingKey(taskId)}:${lane}`,
    changesetId: primary ? `cs-${taskId}-open` : `cs-${taskId}-open-${lane}`,
  };
}

export function briefForOpening(task: RunningTask): string {
  return `${task.name}. ${task.status}.`;
}

/**
 * The task's proxy media for one turn. Loaded media resolves to real
 * context; a task with no footage stays declared absent with empty values
 * instead of inventing media context.
 */
export function mediaForTurn(task: RunningTask): {
  proxy_url: string;
  base_revision: string;
  total_frames: number;
} {
  return {
    proxy_url: task.media?.proxyUrl ?? "",
    base_revision: task.media?.baseRevision ?? "",
    total_frames: task.media?.totalFrames ?? 0,
  };
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
    ...mediaForTurn(task),
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
 * demo flag owns the rail). Opening the task spawns one turn per lane
 * subagent; lanes with no connected tools report honestly instead of
 * submitting. Notes the local resolver answers (undo summaries) stay local;
 * every other note starts a live turn. Sending never changes the timeline.
 * Turns persist per task and restore on reopen, surviving restarts; the
 * demo stand-in stays out of the store either way.
 */
export function useTaskThread(
  task: RunningTask,
  note: TaskNote | null,
  resolveLocalReply?: (text: string) => string | null,
): { turns: Turn[]; activity: TaskActivity | null } {
  const client = useServicesClient();
  const demo = useMemo(() => isThreadDemo(), []);
  const agents = useMemo(() => spawnSubagents(task), [task]);
  const [turns, setTurns] = useState<Turn[]>(() => initialTurnsFor(task, demo, agents));
  const [activity, setActivity] = useState<TaskActivity | null>(() =>
    demo ? null : activityForLivePending(),
  );
  const openedRef = useRef<string | null>(null);
  const seenNote = useRef<number | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (demo) return;
    writeTaskThread({
      taskId: task.id,
      taskName: task.name,
      lane: task.lane,
      status: task.status,
      turns,
      savedAt: new Date().toISOString(),
    });
  }, [turns, task, demo]);

  useEffect(() => {
    if (demo || openedRef.current === task.id) return;
    openedRef.current = task.id;
    seenNote.current = null;
    const id = task.id;
    const live = (apply: () => void) => {
      if (taskRef.current.id === id) apply();
    };
    const multi = agents.length > 1;
    agents.forEach((agent, index) => {
      if (!agent.runnable) return;
      const primary = index === 0;
      const scope = openTurnScope(id, agent.lane, primary);
      const say = (text: string) => (multi ? `${agent.label}: ${text}` : text);
      const paint = (text: string) =>
        setTurns((current) =>
          current.map((turn) => (turn.id === scope.id ? { ...turn, text } : turn)),
        );
      void runTurn(client, {
        task,
        brief: briefForOpening(task),
        key: scope.key,
        changesetId: scope.changesetId,
        onUpdate: (job) => {
          if (isAgentTerminal(job.status)) return;
          live(() => {
            paint(say(textForJob(job)));
            if (primary) setActivity(activityForLiveJob(job));
          });
        },
      }).then(
        (job) =>
          live(() => {
            paint(say(textForJob(job)));
            if (primary) setActivity(activityForLiveJob(job));
          }),
        (error: unknown) =>
          live(() => {
            // A failed opening turn fills in from the store, never with the
            // error: stored (or already-streamed) text stays; only a turn
            // that never got going shows the failure.
            setTurns((current) =>
              current.map((turn) =>
                turn.id === scope.id && turn.text === SENDING
                  ? { ...turn, text: say(replyForSubmitError(error)) }
                  : turn,
              ),
            );
            if (primary) setActivity(activityForLiveError(headlineForSubmitError(error)));
          }),
      );
    });
  }, [task, client, demo, agents]);

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
