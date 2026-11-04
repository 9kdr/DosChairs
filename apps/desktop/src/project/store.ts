import { useEffect, useState } from "react";
import type { Changeset, ChangesetItem, EditOp, Timeline } from "@chair/timeline-ir";
import { buildUndoChangeset, invertItem } from "@chair/timeline-ir";
import type { HistoryEntry } from "@chair/timeline-ir";
import { readReviewSnapshot, withStoredDecisions, writeReviewSnapshot } from "./persist";
import { fetchProjectReview, type ReviewJob } from "./review";

export type { HistoryEntry } from "@chair/timeline-ir";

/**
 * The project store: one open timeline plus its proposals. Opening a
 * project loads the timeline mirror and the pending proposal through the
 * review endpoint; review only flips item status. Nothing here applies an
 * item to the timeline. Every accept appends a history entry with the
 * item's inverse; undo-to-here proposes those inverses as a new pending
 * changeset that needs its own accept.
 */

export type Decision = "accepted" | "rejected";

/** "Add Clip": the human label for an op, shared by every history view. */
export function opLabel(op: string): string {
  return op
    .split("_")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Review one item: flip its status and leave everything else alone.
 * Unknown ids are a no-op. The timeline is never touched.
 */
export function reviewItem(
  changeset: Changeset,
  id: string,
  decision: ChangesetItem["status"],
): Changeset {
  let found = false;
  const items = changeset.items.map((item): ChangesetItem => {
    if (item.id !== id) return item;
    found = true;
    return item.status === decision ? item : { ...item, status: decision };
  });
  return found ? { ...changeset, items } : changeset;
}

/** Fallbacks until live agent output (#61) names the task and the editor. */
export const STAND_IN_TASK_ID = "task-stand-in";
export const STAND_IN_ACCEPTED_BY = "you";

export type AcceptCheck =
  | { ok: true; entry: HistoryEntry }
  | { ok: false; reason: string };

/**
 * Build the history entry for one accepted item: the forward patch verbatim
 * plus the inverse the timeline can unwind through. Fails closed — an item
 * with no inverse (or whose before-state is missing from the mirror)
 * refuses with a reason instead of accepting without a way back. Rejected
 * items never call this.
 */
export function tryHistoryEntry(
  changeset: Changeset,
  item: ChangesetItem,
  timeline: Timeline,
  acceptedBy: string,
  acceptedAt: string,
  taskId: string = STAND_IN_TASK_ID,
): AcceptCheck {
  const inverted = invertItem(item, timeline);
  if (!inverted.ok) return inverted;
  return {
    ok: true,
    entry: {
      taskId,
      changesetId: changeset.id,
      itemId: item.id,
      op: item.op,
      targetId: item.targetId,
      beatId: item.beatId,
      baseRevision: changeset.baseRevision,
      forward: structuredClone(item.patch ?? {}),
      inverse: inverted.inverse,
      acceptedAt,
      acceptedBy,
    },
  };
}

/** One task's accepted history, oldest first. Unknown tasks have none. */
export function historyForTask(history: readonly HistoryEntry[], taskId: string): HistoryEntry[] {
  return history.filter((entry) => entry.taskId === taskId);
}

/** True when a task is completed and has at least one accepted history entry to rewind. */
export function canUndoTask(
  task: { id: string; status: string },
  history: readonly HistoryEntry[],
): boolean {
  return task.status.toLowerCase() === "completed" && historyForTask(history, task.id).length > 0;
}

/**
 * What an undo prompt answers with: the task's accepted edits newest first,
 * like the rewind would run, pointing at the History card that proposes it.
 */
export function undoSummaryForTask(
  history: readonly HistoryEntry[],
  taskId: string,
  taskName: string,
): string {
  const entries = historyForTask(history, taskId);
  if (entries.length === 0) return `No accepted edits to rewind for ${taskName} yet.`;
  const list = [...entries]
    .reverse()
    .map((entry) =>
      entry.targetId ? `${opLabel(entry.op)} on ${entry.targetId}` : opLabel(entry.op),
    )
    .join("; ");
  const count = entries.length === 1 ? "1 accepted edit" : `${entries.length} accepted edits`;
  return (
    `${count} for ${taskName}, newest first: ${list}. ` +
    `Pick Undo to here in History to propose the rewind — it lands in Review for accept.`
  );
}

/** A refused accept or undo, with the reason, for the board to explain. */
export type Refusal = {
  itemId?: string;
  reason: string;
};

/**
 * One decided item the board can take back: its id plus the status it
 * had before the decision. Undo restores the status and drops the
 * history entry when the decision had accepted the item.
 */
export type DecisionRecord = {
  id: string;
  prev: ChangesetItem["status"];
  next: ChangesetItem["status"];
};

/**
 * Where one project open stands: loading the review, ready with a
 * proposal, empty with no proposal yet, or failed with `error` set.
 */
export type ReviewPhase = "loading" | "ready" | "empty" | "error";

export type ProjectStore = {
  phase: ReviewPhase;
  timeline: Timeline | null;
  changeset: Changeset | null;
  /** The pending undo proposal, if one was asked for. Needs its own accept. */
  rollback: Changeset | null;
  history: HistoryEntry[];
  pendingCount: number;
  error: string | null;
  /** The last refused accept or undo, cleared by the next attempt. */
  refusal: Refusal | null;
  acceptItem: (id: string) => void;
  rejectItem: (id: string) => void;
  /** Take back the last accept or reject; returns the restored item id. */
  undoDecision: () => string | null;
  canUndoDecision: boolean;
  acceptAll: () => void;
  acceptAllUndo: () => void;
  undoToHere: (itemId: string) => void;
  retry: () => void;
};

/**
 * Open a project: load its timeline mirror plus its pending proposal
 * through the review endpoint. Accept and reject only flip item
 * status; the mirror never changes. The shell passes the gallery name
 * along with the id; the mirror names the cut once it loads.
 */
export function useProject(projectId: string, projectName: string): ProjectStore {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [changeset, setChangeset] = useState<Changeset | null>(null);
  const [rollback, setRollback] = useState<Changeset | null>(null);
  const [job, setJob] = useState<ReviewJob | null>(null);
  const [phase, setPhase] = useState<ReviewPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setPhase("loading");
    setError(null);
    setTimeline(null);
    setChangeset(null);
    setRollback(null);
    setJob(null);
    setHistory([]);
    setRefusal(null);
    setDecisions([]);
    void (async () => {
      try {
        const review = await fetchProjectReview(projectId, { signal: controller.signal });
        if (!live) return;
        setTimeline(review.timeline);
        if (review.kind === "proposal") {
          const cached = readReviewSnapshot(projectId);
          setChangeset(withStoredDecisions(review.changeset, cached?.changeset ?? null));
          setJob(review.job);
          setPhase("ready");
        } else {
          setPhase("empty");
        }
      } catch (reason) {
        if (!live) return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        const cached = readReviewSnapshot(projectId);
        if (cached) {
          setTimeline(cached.timeline);
          setChangeset(cached.changeset);
          setPhase("ready");
          return;
        }
        setError(reason instanceof Error ? reason.message : "could not load the review");
        setPhase("error");
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [projectId, nonce]);

  // Keep the mirror plus the person's decisions on disk so both survive
  // a restart (#132). Every accept and reject flows through here.
  useEffect(() => {
    if (timeline === null || (phase !== "ready" && phase !== "empty")) return;
    writeReviewSnapshot(projectId, {
      timeline,
      changeset,
      savedAt: new Date().toISOString(),
    });
  }, [projectId, phase, timeline, changeset]);

  const taskId = job ? job.request_id : STAND_IN_TASK_ID;

  /** Flip every invertible pending item in one list; refuse the rest by name. */
  const acceptPendingIn = (
    list: Changeset,
    mirror: Timeline,
    stamp: string,
  ): { next: Changeset; entries: HistoryEntry[]; refusal: Refusal | null } => {
    const entries: HistoryEntry[] = [];
    let refusal: Refusal | null = null;
    for (const target of list.items) {
      if (target.status !== "pending") continue;
      const checked = tryHistoryEntry(list, target, mirror, STAND_IN_ACCEPTED_BY, stamp, taskId);
      if (!checked.ok) {
        refusal ??= { itemId: target.id, reason: checked.reason };
        continue;
      }
      entries.push(checked.entry);
    }
    if (entries.length === 0) return { next: list, entries, refusal };
    const ids = new Set(entries.map((entry) => entry.itemId));
    return {
      next: {
        ...list,
        items: list.items.map((entry) =>
          ids.has(entry.id) ? { ...entry, status: "accepted" as const } : entry,
        ),
      },
      entries,
      refusal,
    };
  };

  const appendEntries = (entries: HistoryEntry[]) => {
    if (entries.length === 0) return;
    setHistory((current) => {
      const known = new Set(current.map((entry) => entry.itemId));
      const fresh = entries.filter((entry) => !known.has(entry.itemId));
      if (fresh.length === 0) return current;
      return [...current, ...fresh];
    });
  };

  const acceptItem = (id: string) => {
    if (!timeline) return;
    const stamp = new Date().toISOString();
    for (const list of [changeset, rollback] as const) {
      if (!list) continue;
      const target = list.items.find((entry) => entry.id === id);
      if (!target || target.status !== "pending") continue;
      const checked = tryHistoryEntry(
        list,
        target,
        timeline,
        STAND_IN_ACCEPTED_BY,
        stamp,
        taskId,
      );
      if (!checked.ok) {
        setRefusal({ itemId: id, reason: checked.reason });
        return;
      }
      const next = reviewItem(list, id, "accepted");
      if (list === changeset) setChangeset(next);
      else setRollback(next);
      appendEntries([checked.entry]);
      setRefusal(null);
      setDecisions((current) => [...current, { id, prev: target.status, next: "accepted" }]);
      return;
    }
  };

  const acceptAll = () => {
    if (!changeset || !timeline) return;
    const { next, entries, refusal: blocked } = acceptPendingIn(
      changeset,
      timeline,
      new Date().toISOString(),
    );
    if (entries.length > 0) {
      setChangeset(next);
      appendEntries(entries);
    }
    setRefusal(blocked);
  };

  const acceptAllUndo = () => {
    if (!rollback || !timeline) return;
    const { next, entries, refusal: blocked } = acceptPendingIn(
      rollback,
      timeline,
      new Date().toISOString(),
    );
    if (entries.length > 0) {
      setRollback(next);
      appendEntries(entries);
    }
    setRefusal(blocked);
  };

  const rejectItem = (id: string) => {
    const target =
      changeset?.items.find((entry) => entry.id === id) ??
      rollback?.items.find((entry) => entry.id === id);
    if (!target || target.status === "rejected") {
      if (!target) return;
      setRefusal((current) => (current?.itemId === id ? null : current));
      return;
    }
    if (changeset?.items.some((entry) => entry.id === id)) {
      setChangeset(reviewItem(changeset, id, "rejected"));
    } else if (rollback) {
      setRollback(reviewItem(rollback, id, "rejected"));
    }
    setDecisions((current) => [...current, { id, prev: target.status, next: "rejected" }]);
    setRefusal((current) => (current?.itemId === id ? null : current));
  };

  /**
   * Take back the last accept or reject. The item returns to the
   * status it had before, and an undone accept leaves History too.
   * Returns the restored item id so the board can focus it.
   */
  const undoDecision = (): string | null => {
    const record = decisions[decisions.length - 1];
    if (!record) return null;
    if (changeset?.items.some((entry) => entry.id === record.id)) {
      setChangeset(reviewItem(changeset, record.id, record.prev));
    } else if (rollback?.items.some((entry) => entry.id === record.id)) {
      setRollback(reviewItem(rollback, record.id, record.prev));
    } else {
      setDecisions((current) => current.slice(0, -1));
      return null;
    }
    if (record.next === "accepted") {
      setHistory((current) => current.filter((entry) => entry.itemId !== record.id));
    }
    setDecisions((current) => current.slice(0, -1));
    return record.id;
  };

  /** Propose rewinding one entry plus its tail. The proposal needs accept. */
  const undoToHere = (itemId: string) => {
    const undone = buildUndoChangeset(history, itemId);
    if (!undone.ok) {
      setRefusal({ itemId, reason: undone.reason });
      return;
    }
    setRollback(undone.changeset);
    setRefusal(null);
  };

  return {
    phase,
    timeline,
    changeset,
    rollback,
    history,
    pendingCount: changeset
      ? changeset.items.filter((item) => item.status === "pending").length
      : 0,
    error,
    refusal,
    acceptItem,
    rejectItem,
    undoDecision,
    canUndoDecision: decisions.length > 0,
    acceptAll,
    acceptAllUndo,
    undoToHere,
    retry: () => setNonce((current) => current + 1),
  };
}
