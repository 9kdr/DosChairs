/**
 * Thread store: one persisted thread (user notes plus agent turns) per
 * task, in localStorage so reopening a task — or restarting the app —
 * restores it. Terminal task threads stay retained so #151 can list and
 * revisit them read-only; nothing here ever deletes a thread.
 *
 * The agent does not persist job records (its job controller is
 * in-memory), so the store keeps copies of turn text, not references.
 * The #132 rule still holds: live data wins when it loads — stored text
 * only fills in until the live turn replaces it.
 *
 * The JSON helpers mirror `lib/storage.ts` from #183 while that PR is
 * unmerged; converge on the shared module once it lands.
 */
import type { Turn } from "./taskThread";
import type { TaskLane } from "./RunningTasks";

const THREAD_KEY_PREFIX = "chair.task.thread.";
const INDEX_KEY = "chair.task.threads";

export type ThreadSnapshot = {
  taskId: string;
  taskName: string;
  lane: TaskLane;
  status: string;
  turns: Turn[];
  savedAt: string;
};

/** What #151 needs to list previous tasks without building the view here. */
export type ThreadSummary = {
  taskId: string;
  taskName: string;
  status: string;
  terminal: boolean;
  turnCount: number;
  savedAt: string;
};

function loadJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / unavailable storage / quota: staying in memory is fine
  }
}

function threadKey(taskId: string): string {
  return `${THREAD_KEY_PREFIX}${taskId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTurn(value: unknown): value is Turn {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string"
  );
}

/** Shape-check a stored thread; anything else reads as missing. */
function snapshotFromJson(value: unknown): ThreadSnapshot | null {
  if (!isRecord(value)) return null;
  const { taskId, taskName, lane, status, turns, savedAt } = value;
  if (
    typeof taskId !== "string" ||
    typeof taskName !== "string" ||
    (lane !== "edit" && lane !== "effects" && lane !== "colour") ||
    typeof status !== "string" ||
    !Array.isArray(turns) ||
    typeof savedAt !== "string"
  ) {
    return null;
  }
  if (!turns.every(isTurn)) return null;
  return value as unknown as ThreadSnapshot;
}

function indexFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** The stored thread for one task, if any. */
export function readTaskThread(taskId: string): ThreadSnapshot | null {
  return snapshotFromJson(loadJson(threadKey(taskId)));
}

export function writeTaskThread(snapshot: ThreadSnapshot): void {
  saveJson(threadKey(snapshot.taskId), snapshot);
  const index = indexFromJson(loadJson(INDEX_KEY));
  if (!index.includes(snapshot.taskId)) {
    saveJson(INDEX_KEY, [...index, snapshot.taskId]);
  }
}

/** Terminal task states keep their threads for #151 to revisit read-only. */
export function isTerminalTaskStatus(status: string): boolean {
  switch (status.trim().toLowerCase()) {
    case "completed":
    case "failed":
    case "canceled":
    case "cancelled":
    case "moderated":
      return true;
    default:
      return false;
  }
}

/**
 * Every retained thread, newest first, for the #151 previous-tasks view.
 * Entries that no longer read are skipped, never surfaced as broken rows.
 */
export function listTaskThreads(): ThreadSummary[] {
  const summaries: ThreadSummary[] = [];
  for (const taskId of indexFromJson(loadJson(INDEX_KEY))) {
    const snapshot = readTaskThread(taskId);
    if (snapshot === null) continue;
    summaries.push({
      taskId: snapshot.taskId,
      taskName: snapshot.taskName,
      status: snapshot.status,
      terminal: isTerminalTaskStatus(snapshot.status),
      turnCount: snapshot.turns.length,
      savedAt: snapshot.savedAt,
    });
  }
  summaries.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  return summaries;
}
