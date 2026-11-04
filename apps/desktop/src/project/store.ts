import { useCallback, useEffect, useRef, useState } from "react";
import type { Changeset, ChangesetItem, EditOp, Timeline } from "@chair/timeline-ir";
import { applyChangesetItem, buildUndoChangeset, invertItem } from "@chair/timeline-ir";
import type { HistoryEntry } from "@chair/timeline-ir";
import type { PieceLanding } from "../effects/effect-model";
import { readReviewSnapshot, withStoredDecisions, writeReviewSnapshot } from "./persist";
import { fetchProjectReview, type ReviewJob } from "./review";

export type { HistoryEntry } from "@chair/timeline-ir";

/**
 * The project store: one open timeline plus its edits. Opening a
 * project loads the timeline mirror plus the latest proposal through
 * the review endpoint. In Auto mode agent edits apply on arrival
 * through the same accept pipeline as a manual accept, so history
 * entries and inverses stay identical; in Ask-first mode edits wait
 * as pending until the person accepts or rejects each one. Every
 * apply — agent or person, forward or undo — appends a history entry
 * with the item's inverse, and undo applies its inverses at once.
 * Nothing here writes source media: applies land on copies (a new
 * timeline, version, or track) on the agent side, and the local mirror
 * — the app's copy of the cut — follows every apply and undo so the
 * next inverse snapshots the state it needs.
 */

export type Decision = "accepted" | "rejected";

/** "Add Clip": the human label for an op, shared by every history view. */
export function opLabel(op: string): string {
  return op
    .split("_")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** HH:MM on the local clock for an accepted-at stamp. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  // taste-skill-ignore: clock fields are zero-padded by definition.
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
/** Who the history names when the agent applies on arrival. */
export const AGENT_ACCEPTED_BY = "agent";

export type AcceptCheck =
  | { ok: true; entry: HistoryEntry }
  | { ok: false; reason: string };

/**
 * Build the history entry for one applied item: the forward patch verbatim
 * plus the inverse the timeline can unwind through, marked with who
 * caused the apply (the agent on arrival, the person by hand). Fails
 * closed — an item with no inverse (or whose before-state is missing
 * from the mirror) refuses with a reason instead of applying without a
 * way back. Rejected items never call this. The item's adapter fallback
 * rides along when it has one, so history shows the same line.
 */
export function tryHistoryEntry(
  changeset: Changeset,
  item: ChangesetItem,
  timeline: Timeline,
  acceptedBy: string,
  acceptedAt: string,
  taskId: string = STAND_IN_TASK_ID,
  actor: HistoryEntry["actor"] = "user",
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
      actor,
      ...(item.fallback ? { fallback: { ...item.fallback } } : {}),
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
 * What an undo prompt answers with: the task's applied history newest first,
 * like the rewind would run, pointing at the History card that rewinds it.
 */
export function undoSummaryForTask(
  history: readonly HistoryEntry[],
  taskId: string,
  taskName: string,
): string {
  const entries = historyForTask(history, taskId);
  if (entries.length === 0) return `No applied edits to rewind for ${taskName} yet.`;
  const list = [...entries]
    .reverse()
    .map((entry) =>
      entry.targetId ? `${opLabel(entry.op)} on ${entry.targetId}` : opLabel(entry.op),
    )
    .join("; ");
  const count = entries.length === 1 ? "1 applied edit" : `${entries.length} applied edits`;
  return (
    `${count} for ${taskName}, newest first: ${list}. ` +
    `Press u or pick Undo to here in History to rewind — it applies at once onto a copy.`
  );
}

/** A refused accept or undo, with the reason, for the board to explain. */
export type Refusal = {
  itemId?: string;
  reason: string;
};

/**
 * Move the local mirror with what applied. The mirror is the app's copy
 * of the cut, not the source, so it follows every apply and undo — and
 * the next inverse snapshots the post-apply state it needs. Items the
 * applier cannot place skip; the accept path already failed closed on
 * anything without a way back.
 */
export function advanceMirror(mirror: Timeline, entries: HistoryEntry[]): Timeline {
  if (entries.length === 0) return mirror;
  const next = structuredClone(mirror);
  for (const entry of entries) {
    applyChangesetItem(next, {
      id: entry.itemId,
      op: entry.op,
      ...(entry.targetId ? { targetId: entry.targetId } : {}),
      ...(entry.beatId ? { beatId: entry.beatId } : {}),
      rationale: "",
      patch: entry.forward,
      status: "accepted",
    });
  }
  return next;
}

/**
 * Where one project open stands: loading the review, ready with a
 * proposal, empty with no proposal yet, or failed with `error` set.
 */
export type ReviewPhase = "loading" | "ready" | "empty" | "error";

export type ApplyMode = "auto" | "ask";

export type ProjectStore = {
  phase: ReviewPhase;
  timeline: Timeline | null;
  changeset: Changeset | null;
  history: HistoryEntry[];
  pendingCount: number;
  /** How edits land: applied on arrival (auto) or held for review (ask). */
  applyMode: ApplyMode;
  error: string | null;
  /** The last refused apply or undo, cleared by the next attempt. */
  refusal: Refusal | null;
  acceptItem: (id: string) => void;
  rejectItem: (id: string) => void;
  acceptAll: () => void;
  /**
   * Apply one person-made edit (Effect Maker) through the accept pipeline:
   * same history entry and inverse as a proposal item. Returns its item id
   * on success, or null with `refusal` set when it cannot be undone.
   */
  applyItem: (item: ChangesetItem) => string | null;
  /** Rewind one entry plus its tail, applying the inverses at once. */
  undoToHere: (itemId: string) => void;
  /** Rewind the newest entry, applying its inverse at once. */
  undoLast: () => void;
  retry: () => void;
  /** Where applied pieces landed in Resolve, by spec id, so re-applies find the same clip. */
  landings: Record<string, PieceLanding>;
  recordLanding: (specId: string, landing: PieceLanding) => void;
};

/**
 * Open a project: load its timeline mirror plus its latest proposal
 * through the review endpoint. The shell passes the gallery name
 * along with the id; the mirror names the cut once it loads.
 */
export function useProject(
  projectId: string,
  projectName: string,
  options: { applyMode?: ApplyMode } = {},
): ProjectStore {
  const applyMode = options.applyMode ?? "auto";
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [changeset, setChangeset] = useState<Changeset | null>(null);
  const [job, setJob] = useState<ReviewJob | null>(null);
  const [phase, setPhase] = useState<ReviewPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);
  const [landings, setLandings] = useState<Record<string, PieceLanding>>({});
  /** Changeset ids already passed through auto-apply; a new proposal starts over. */
  const autoApplied = useRef<{ project: string; ids: Set<string> }>({
    project: projectId,
    ids: new Set(),
  });
  if (autoApplied.current.project !== projectId) {
    autoApplied.current = { project: projectId, ids: new Set() };
  }

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setPhase("loading");
    setError(null);
    setTimeline(null);
    setChangeset(null);
    setJob(null);
    setHistory([]);
    setRefusal(null);
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

  /**
   * Apply every invertible pending item in one list through the accept
   * pipeline: the same history entries and inverses a manual accept
   * builds. Refuse the rest by name instead of applying without a way back.
   */
  const acceptPendingIn = (
    list: Changeset,
    mirror: Timeline,
    stamp: string,
    acceptedBy: string,
    actor: HistoryEntry["actor"],
  ): { next: Changeset; entries: HistoryEntry[]; refusal: Refusal | null } => {
    const entries: HistoryEntry[] = [];
    let refusal: Refusal | null = null;
    for (const target of list.items) {
      if (target.status !== "pending") continue;
      const checked = tryHistoryEntry(list, target, mirror, acceptedBy, stamp, taskId, actor);
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

  /**
   * Record an apply after its entries are built: the mirror follows so
   * the next inverse snapshots the post-apply state, then history grows.
   */
  const recordEntries = (entries: HistoryEntry[]) => {
    if (entries.length === 0) return;
    setTimeline((current) => (current ? advanceMirror(current, entries) : current));
    appendEntries(entries);
  };

  /** The person applies by hand: their entries read actor user. */
  const acceptItem = (id: string) => {
    if (!changeset || !timeline) return;
    const target = changeset.items.find((entry) => entry.id === id);
    if (!target || target.status !== "pending") return;
    const checked = tryHistoryEntry(
      changeset,
      target,
      timeline,
      STAND_IN_ACCEPTED_BY,
      new Date().toISOString(),
      taskId,
      "user",
    );
    if (!checked.ok) {
      setRefusal({ itemId: id, reason: checked.reason });
      return;
    }
    setChangeset(reviewItem(changeset, id, "accepted"));
    recordEntries([checked.entry]);
    setRefusal(null);
  };

  const acceptAll = () => {
    if (!changeset || !timeline) return;
    const { next, entries, refusal: blocked } = acceptPendingIn(
      changeset,
      timeline,
      new Date().toISOString(),
      STAND_IN_ACCEPTED_BY,
      "user",
    );
    if (entries.length > 0) {
      setChangeset(next);
      recordEntries(entries);
    }
    setRefusal(blocked);
  };

  const applyItem = (item: ChangesetItem): string | null => {
    if (!timeline) {
      setRefusal({ itemId: item.id, reason: "No cut is loaded to apply onto." });
      return null;
    }
    const own: Changeset = {
      schemaVersion: "0.1.0",
      id: `cs-${item.id}`,
      baseRevision: changeset?.baseRevision ?? "local",
      items: [{ ...item, status: "accepted" }],
    };
    const checked = tryHistoryEntry(
      own,
      own.items[0]!,
      timeline,
      STAND_IN_ACCEPTED_BY,
      new Date().toISOString(),
      STAND_IN_TASK_ID,
      "user",
    );
    if (!checked.ok) {
      setRefusal({ itemId: item.id, reason: checked.reason });
      return null;
    }
    recordEntries([checked.entry]);
    setRefusal(null);
    return item.id;
  };

  const rejectItem = (id: string) => {
    if (!changeset?.items.some((entry) => entry.id === id)) return;
    setChangeset(reviewItem(changeset, id, "rejected"));
    setRefusal((current) => (current?.itemId === id ? null : current));
  };

  /**
   * Rewind one entry plus its tail, applying the inverses at once onto a
   * copy. The undo entries read actor user and join the history after the
   * tail, so the history keeps showing every step in order.
   */
  const undoToHere = (itemId: string) => {
    if (!timeline) return;
    const undone = buildUndoChangeset(history, itemId);
    if (!undone.ok) {
      setRefusal({ itemId, reason: undone.reason });
      return;
    }
    const { entries, refusal: blocked } = acceptPendingIn(
      undone.changeset,
      timeline,
      new Date().toISOString(),
      STAND_IN_ACCEPTED_BY,
      "user",
    );
    if (entries.length > 0) recordEntries(entries);
    setRefusal(blocked);
  };

  /** Rewind the newest history entry. Nothing to rewind is a quiet no-op. */
  const undoLast = () => {
    const last = history[history.length - 1];
    if (!last) return;
    undoToHere(last.itemId);
  };

  // Auto mode: agent edits apply on arrival through the same accept
  // pipeline as a manual accept, so history entries and inverses stay
  // identical. Each proposal applies once; Ask-first mode never enters.
  useEffect(() => {
    if (applyMode !== "auto") return;
    if (!changeset || !timeline) return;
    if (autoApplied.current.ids.has(changeset.id)) return;
    autoApplied.current.ids.add(changeset.id);
    if (!changeset.items.some((item) => item.status === "pending")) return;
    const { next, entries, refusal: blocked } = acceptPendingIn(
      changeset,
      timeline,
      new Date().toISOString(),
      AGENT_ACCEPTED_BY,
      "agent",
    );
    if (entries.length > 0) {
      setChangeset(next);
      recordEntries(entries);
    }
    setRefusal(blocked);
  });

  const recordLanding = useCallback((specId: string, landing: PieceLanding) => {
    setLandings((current) => ({ ...current, [specId]: landing }));
  }, []);

  return {
    phase,
    timeline,
    changeset,
    history,
    landings,
    recordLanding,
    pendingCount: changeset
      ? changeset.items.filter((item) => item.status === "pending").length
      : 0,
    applyMode,
    error,
    refusal,
    acceptItem,
    rejectItem,
    acceptAll,
    applyItem,
    undoToHere,
    undoLast,
    retry: () => setNonce((current) => current + 1),
  };
}
