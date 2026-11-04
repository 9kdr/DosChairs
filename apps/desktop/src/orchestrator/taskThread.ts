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
  /** Attachment names from the composer draft that sent this note. */
  files?: readonly string[];
  /** The orchestrator model picked for this note's turn. */
  model?: string;
};

export type DraftSelection = {
  files: readonly string[];
  model: string;
};

/**
 * Pair a composer draft with the note it sent: the parent shell owns the
 * note channel and only carries text, so the thread matches the pending
 * draft by its text. Anything else (the Undo chip, a row button) sends
 * without a draft and runs unadorned.
 */
export function selectionForNote(
  note: TaskNote,
  pending: { text: string; files: readonly string[]; model: string } | null,
): DraftSelection | null {
  if (pending === null || pending.text !== note.text) return null;
  return { files: [...pending.files], model: pending.model };
}

/**
 * One note's turn text and agent brief: trimmed words plus attachment
 * names, or the attachment names alone when no words were sent.
 */
export function noteTurnText(note: TaskNote): string {
  const text = note.text.trim();
  const files = note.files ?? [];
  if (!text) return files.length > 0 ? `Attached files: ${files.join(", ")}` : "";
  return files.length > 0 ? `${text}\nAttached files: ${files.join(", ")}` : text;
}

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

/**
 * The opening turn's brief. Stable across live status changes: the agent
 * compares the whole input on an idempotent resubmit, so a brief built
 * from the row's status would 409 once the job goes live.
 */
export function openingBrief(task: RunningTask): string {
  return task.plan?.brief ?? task.name;
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
  selection: DraftSelection = { files: [], model: "" },
): Record<string, unknown> {
  return {
    brief,
    task_id: task.id,
    lane: task.lane,
    target_id: task.id,
    changeset_id: changesetId,
    ...mediaForTurn(task),
    ...(task.projectId ? { project_id: task.projectId } : {}),
    // Note turns carry the composer's pick and attachments; opening
    // turns leave both off so their idempotent resubmit stays stable.
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.files.length > 0 ? { files: [...selection.files] } : {}),
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
    model?: string;
    files?: readonly string[];
    onUpdate?: (job: AgentJob) => void;
    delayForAttempt?: (attempt: number) => number;
  },
): Promise<AgentJob> {
  const handle = await client.submitAgentJob(
    EDIT_TASK,
    inputForTurn(turn.task, turn.brief, turn.changesetId, {
      files: turn.files ?? [],
      model: turn.model ?? "",
    }),
    { idempotencyKey: turn.key },
  );
  recordLiveJob(handle.request_id, turn.task);
  return client.pollAgentJob(handle.request_id, {
    onUpdate: turn.onUpdate,
    delayForAttempt: turn.delayForAttempt,
  });
}

/** Live jobs this session submitted, request id to the task owning the turn. */
const liveJobs = new Map<string, RunningTask>();
/** Tasks whose jobs all reached terminal: out of the list, never resubmitted. */
const settledTasks = new Set<string>();
/**
 * Tasks whose opening turn failed to submit, task id to the plain error.
 * They stay visible as failed rows (never swallowed) and resubmit on the
 * next poll; clearing the entry by hand retries even sooner.
 */
const submitErrors = new Map<string, string>();

/** The plain submit error for a task, if its turn failed to send. */
export function liveSubmitError(taskId: string): string | undefined {
  return submitErrors.get(taskId);
}

/** Forget a submit failure so the next poll resubmits the turn now. */
export function retryLiveTask(taskId: string): void {
  submitErrors.delete(taskId);
}

/** Remember a submitted turn so the live list can poll it. */
export function recordLiveJob(requestId: string, task: RunningTask): void {
  liveJobs.set(requestId, task);
}

/** Drop a job the list no longer polls (terminal, or unknown to the agent). */
export function forgetLiveJob(requestId: string): void {
  liveJobs.delete(requestId);
}

/** Settle a task out of the live list; its jobs reached terminal. */
export function settleLiveTask(taskId: string): void {
  settledTasks.add(taskId);
}

/** True once the task's jobs reached terminal. */
export function isLiveTaskSettled(taskId: string): boolean {
  return settledTasks.has(taskId);
}

/** Every remembered job, oldest first, for the live list to poll. */
export function liveJobEntries(): [string, RunningTask][] {
  return [...liveJobs.entries()];
}

/** Test support: clear remembered jobs, failures, and settled tasks. */
export function resetLiveJobs(): void {
  liveJobs.clear();
  settledTasks.clear();
  submitErrors.clear();
}

/** One row per task from a live job. Null when the job already finished. */
export function taskForLiveJob(job: AgentJob, task: RunningTask): RunningTask | null {
  if (isAgentTerminal(job.status)) return null;
  const lane = job.input.lane;
  return {
    ...task,
    status: job.status === "queued" ? "Queued on the agent" : "The agent is working",
    lane: lane === "edit" || lane === "effects" || lane === "colour" ? lane : task.lane,
    jobId: job.request_id,
    jobStatus: job.status,
  };
}

export type LiveJobEntry = { requestId: string; task: RunningTask; job: AgentJob | null };

/**
 * Merge one poll round into rows. Terminal jobs settle their task out of
 * the list; unknown (null) jobs are only forgotten, so the task resubmits
 * under its idempotent key. Overlapping turns on one task share its row.
 */
export function liveRowsForJobs(entries: LiveJobEntry[]): {
  rows: RunningTask[];
  forget: string[];
  settle: string[];
} {
  const rows = new Map<string, RunningTask>();
  const forget: string[] = [];
  const settle: string[] = [];
  for (const entry of entries) {
    const row = entry.job === null ? null : taskForLiveJob(entry.job, entry.task);
    if (row === null) {
      forget.push(entry.requestId);
      if (entry.job !== null) settle.push(entry.task.id);
      continue;
    }
    rows.set(entry.task.id, row);
  }
  return { rows: [...rows.values()], forget, settle };
}

/** Cancel the row's live job. Rows without one cancel nothing. */
export function stopLiveTask(client: ServicesClient, task: RunningTask): Promise<AgentJob | null> {
  if (task.jobId === undefined) return Promise.resolve(null);
  return client.cancelAgentJob(task.jobId);
}

const LIVE_POLL_MS = 2000;

/**
 * Rows for created tasks with no live job yet: waiting until the turn
 * sends, then failed with the plain error when sending fails. The board
 * renders task.status, so these need no row change elsewhere.
 */
export function waitingRowsFor(tasks: readonly RunningTask[]): RunningTask[] {
  const submitted = new Set(liveJobEntries().map(([, entry]) => entry.id));
  return tasks
    .filter((task) => !isLiveTaskSettled(task.id) && !submitted.has(task.id))
    .map((task) => {
      const failure = submitErrors.get(task.id);
      return failure === undefined
        ? { ...task, status: "Waiting for the agent" }
        : { ...task, status: `Failed: ${failure}` };
    });
}

/**
 * The board's live rows: waiting tasks first, then one per running job.
 *
 * New tasks submit their opening turn on arrival; the thread's identical
 * key and input resume that same job on open, never a duplicate. A task
 * stays visible from creation: waiting while the turn sends, failed with
 * the plain error when sending fails (retried on the next poll). Each
 * poll then refreshes every remembered job. Failed polls keep the last
 * rows, so a flaky agent never blanks the list.
 */
/**
 * Submit one task's opening turn for the live list. Failures land in the
 * submit-error map (never swallowed) so the row stays visible as failed;
 * the next poll resubmits under the same idempotent key.
 */
export async function submitLiveTurn(
  client: ServicesClient,
  task: RunningTask,
): Promise<void> {
  if (isLiveTaskSettled(task.id)) return;
  const scope = openTurnScope(task.id, task.lane, true);
  // Same key and input as the thread's primary opening turn, so opening
  // the row resumes this job instead of conflicting.
  try {
    const handle = await client.submitAgentJob(
      EDIT_TASK,
      inputForTurn(task, openingBrief(task), scope.changesetId),
      { idempotencyKey: scope.key },
    );
    recordLiveJob(handle.request_id, task);
    submitErrors.delete(task.id);
  } catch (error) {
    submitErrors.set(task.id, error instanceof Error ? error.message : "unreachable");
  }
}

export function useLiveTasks(createdTasks: readonly RunningTask[]): RunningTask[] {
  const client = useServicesClient();
  const [rows, setRows] = useState<RunningTask[]>([]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    let live = true;
    let ticking = false;
    const controller = new AbortController();

    async function tick(tasks: readonly RunningTask[]) {
      if (ticking) return;
      ticking = true;
      try {
        const submitted = new Set(liveJobEntries().map(([, entry]) => entry.id));
        for (const task of tasks) {
          if (isLiveTaskSettled(task.id) || submitted.has(task.id)) continue;
          submitted.add(task.id);
          // Failures land in the submit-error map; the next poll retries.
          void submitLiveTurn(client, task);
        }
        const entries: LiveJobEntry[] = [];
        const stale: RunningTask[] = [];
        for (const [requestId, task] of liveJobEntries()) {
          try {
            entries.push({
              requestId,
              task,
              job: await client.agentJob(requestId, { signal: controller.signal }),
            });
          } catch (error) {
            if (error instanceof ServiceError && error.status === 404) {
              entries.push({ requestId, task, job: null });
              continue;
            }
            const previous = rowsRef.current.find((row) => row.jobId === requestId);
            if (previous !== undefined) stale.push(previous);
          }
        }
        const merged = liveRowsForJobs(entries);
        for (const requestId of merged.forget) forgetLiveJob(requestId);
        for (const taskId of merged.settle) {
          settleLiveTask(taskId);
          submitErrors.delete(taskId);
        }
        if (live) setRows([...waitingRowsFor(tasks), ...stale, ...merged.rows]);
      } finally {
        ticking = false;
      }
    }

    void tick(createdTasks);
    const timer = window.setInterval(() => void tick(createdTasks), LIVE_POLL_MS);
    return () => {
      live = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [client, createdTasks]);

  return rows;
}

export function shortRequestId(requestId: string): string {
  return requestId.length > 13 ? `${requestId.slice(0, 13)}…` : requestId;
}

/** The turn's model, as the job record carries it — empty when none was sent. */
function modelSuffix(job: AgentJob): string {
  const model = job.input.model;
  return typeof model === "string" && model.trim() ? ` Model: ${model.trim()}.` : "";
}

/** The thread line for a live job: running status, or the real terminal reply. */
export function textForJob(job: AgentJob): string {
  const model = modelSuffix(job);
  if (job.status === "queued") return `Turn sent — queued on the agent.${model}`;
  if (job.status === "in_progress") return `The agent is working on it.${model}`;
  if (job.status === "failed") {
    return `The agent couldn't finish this turn: ${job.error ?? "it failed without a reason"}. Nothing changed.${model}`;
  }
  if (job.status === "moderated") {
    return `The agent stopped this turn: ${job.error ?? "moderated"}. Nothing changed.${model}`;
  }
  if (job.status === "canceled") return `This turn was canceled. Nothing changed.${model}`;
  const previews = job.artifacts.length;
  const ops = job.changeset?.ops.length ?? 0;
  const previewBit =
    previews === 0 ? "no previews" : previews === 1 ? "1 preview" : `${previews} previews`;
  const opBit =
    ops === 0 ? "no proposed changes" : ops === 1 ? "1 proposed change" : `${ops} proposed changes`;
  let text =
    `Done: ${previewBit}, ${opBit}. ` +
    "Proposed edits stay proposals until you accept each one from Review — the timeline is unchanged.";
  if (previews > 0) {
    text += ` Preview files: ${job.artifacts.map((artifact) => artifact.url).join(", ")}.`;
  }
  return text + model;
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
 * every other note starts a live turn carrying its model pick and
 * attachments. Sending never changes the timeline.
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
        brief: openingBrief(task),
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
    const files = note.files ?? [];
    if (!text && files.length === 0) return;
    const local = text ? (resolveLocalReply?.(text) ?? null) : null;
    const userTurn: Turn = { id: `user-${note.id}`, role: "user", text: noteTurnText(note) };
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
      brief: noteTurnText(note),
      key: noteKey(id, note.id),
      changesetId: `cs-${id}-${note.id}`,
      model: note.model,
      files,
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
