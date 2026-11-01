import { useEffect, useState } from "react";
import type { Changeset, ChangesetItem, EditOp, Timeline } from "@chair/timeline-ir";
import { readReviewSnapshot, withStoredDecisions, writeReviewSnapshot } from "./persist";
import { fetchProjectReview, type ReviewJob } from "./review";

/**
 * The project store: one open timeline plus one proposed changeset.
 * Opening a project loads the timeline mirror and the pending proposal
 * through the review endpoint; review only flips item status. Nothing
 * here applies an item to the timeline.
 */

export type Decision = "accepted" | "rejected";

/**
 * Review one item: flip its status and leave everything else alone.
 * Unknown ids are a no-op. The timeline is never touched.
 */
export function reviewItem(changeset: Changeset, id: string, decision: Decision): Changeset {
  let found = false;
  const items = changeset.items.map((item): ChangesetItem => {
    if (item.id !== id) return item;
    found = true;
    return item.status === decision ? item : { ...item, status: decision };
  });
  return found ? { ...changeset, items } : changeset;
}

/**
 * One accepted edit's undo point, shaped like the history entry in #75:
 * `{ taskId, changesetId, itemId, op, targetId, baseRevision, forward,
 * inverse, acceptedAt, acceptedBy }`. Stand-in data until #75 lands: the
 * task id is fixed, the inverse patch is a marker, and nothing here can
 * roll back — the "Undo to here" buttons stay disabled until then.
 */
export type HistoryEntry = {
  taskId: string;
  changesetId: string;
  itemId: string;
  op: EditOp;
  targetId?: string;
  baseRevision: string;
  forward: Record<string, unknown>;
  inverse: Record<string, unknown>;
  acceptedAt: string;
  acceptedBy: string;
};

/** Stand-in provenance until live agent output (#61) and rollback (#75) land. */
export const STAND_IN_TASK_ID = "task-stand-in";
export const STAND_IN_ACCEPTED_BY = "you";

/** Build the history entry for one accepted item. Rejected items never call this. */
export function historyEntryForItem(
  changeset: Changeset,
  item: Pick<ChangesetItem, "id" | "op" | "targetId" | "patch">,
  acceptedBy: string,
  acceptedAt: string,
  taskId: string = STAND_IN_TASK_ID,
): HistoryEntry {
  return {
    taskId,
    changesetId: changeset.id,
    itemId: item.id,
    op: item.op,
    targetId: item.targetId,
    baseRevision: changeset.baseRevision,
    forward: item.patch ?? {},
    inverse: { op: item.op, standIn: true },
    acceptedAt,
    acceptedBy,
  };
}

type TaskHistorySpec = Pick<ChangesetItem, "id" | "op" | "targetId" | "patch"> & {
  acceptedAt: string;
};

/**
 * Stand-in accepted history per running task (ids from STANDIN_TASKS),
 * oldest first. Real entries arrive with #61/#75; unknown tasks have none.
 */
const TASK_HISTORY: Record<string, TaskHistorySpec[]> = {
  "task-1": [
    {
      id: "item-task-1-a",
      op: "add_clip",
      targetId: "v1",
      patch: { clipId: "clip-a-roll" },
      acceptedAt: "2026-10-31T16:30:00.000Z",
    },
    {
      id: "item-task-1-b",
      op: "trim",
      targetId: "clip-interview",
      patch: { edge: "head", frames: 12 },
      acceptedAt: "2026-10-31T16:38:00.000Z",
    },
  ],
  "task-2": [
    {
      id: "item-task-2-a",
      op: "add_effect",
      targetId: "clip-interview",
      patch: { presetName: "Halation" },
      acceptedAt: "2026-10-31T16:35:00.000Z",
    },
  ],
  "task-3": [
    {
      id: "item-task-3-a",
      op: "add_marker",
      patch: {
        marker: {
          id: "mark-pause-1",
          name: "Pause",
          time: { value: 86448, rate: 24 },
          kind: "user",
        },
      },
      acceptedAt: "2026-10-31T16:36:00.000Z",
    },
  ],
  "task-4": [
    {
      id: "item-task-4-a",
      op: "add_effect",
      targetId: "clip-scene-04",
      patch: { presetName: "Match reference" },
      acceptedAt: "2026-10-31T16:37:00.000Z",
    },
  ],
};

/** Stand-in history for one running task, shaped like the entries in #75. */
export function historyForTask(taskId: string): HistoryEntry[] {
  const specs = TASK_HISTORY[taskId] ?? [];
  const changeset: Changeset = {
    schemaVersion: "0.1.0",
    id: `cs-${taskId}-1`,
    baseRevision: "r0",
    items: [],
  };
  return specs.map((spec) =>
    historyEntryForItem(changeset, spec, STAND_IN_ACCEPTED_BY, spec.acceptedAt, taskId),
  );
}

/**
 * Accept every pending item at once. Already decided items keep their
 * status. Returns the new changeset plus the items this call accepted.
 */
export function acceptAllPending(changeset: Changeset): {
  changeset: Changeset;
  accepted: ChangesetItem[];
} {
  const accepted = changeset.items.filter((item) => item.status === "pending");
  if (accepted.length === 0) return { changeset, accepted };
  return {
    changeset: {
      ...changeset,
      items: changeset.items.map((item) =>
        item.status === "pending" ? { ...item, status: "accepted" as const } : item,
      ),
    },
    accepted,
  };
}

/**
 * Where one project open stands: loading the review, ready with a
 * proposal, empty with no proposal yet, or failed with `error` set.
 */
export type ReviewPhase = "loading" | "ready" | "empty" | "error";

export type ProjectStore = {
  phase: ReviewPhase;
  timeline: Timeline | null;
  changeset: Changeset | null;
  history: HistoryEntry[];
  pendingCount: number;
  error: string | null;
  acceptItem: (id: string) => void;
  rejectItem: (id: string) => void;
  acceptAll: () => void;
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
  const [job, setJob] = useState<ReviewJob | null>(null);
  const [phase, setPhase] = useState<ReviewPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setPhase("loading");
    setError(null);
    setTimeline(null);
    setChangeset(null);
    setJob(null);
    setHistory([]);
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

  const appendHistory = (decided: ChangesetItem[], stamp: string) => {
    if (decided.length === 0 || !changeset) return;
    const taskId = job ? job.request_id : STAND_IN_TASK_ID;
    setHistory((current) => {
      const known = new Set(current.map((entry) => entry.itemId));
      const fresh = decided.filter((item) => !known.has(item.id));
      if (fresh.length === 0) return current;
      return [
        ...current,
        ...fresh.map((item) =>
          historyEntryForItem(changeset, item, STAND_IN_ACCEPTED_BY, stamp, taskId),
        ),
      ];
    });
  };

  const acceptItem = (id: string) => {
    if (!changeset) return;
    const item = changeset.items.find((entry) => entry.id === id);
    if (!item || item.status !== "pending") return;
    setChangeset(reviewItem(changeset, id, "accepted"));
    appendHistory([item], new Date().toISOString());
  };

  const acceptAll = () => {
    if (!changeset) return;
    const { changeset: next, accepted } = acceptAllPending(changeset);
    if (accepted.length === 0) return;
    setChangeset(next);
    appendHistory(accepted, new Date().toISOString());
  };

  return {
    phase,
    timeline,
    changeset,
    history,
    pendingCount: changeset
      ? changeset.items.filter((item) => item.status === "pending").length
      : 0,
    error,
    acceptItem,
    rejectItem: (id) =>
      setChangeset((current) => (current ? reviewItem(current, id, "rejected") : current)),
    acceptAll,
    retry: () => setNonce((current) => current + 1),
  };
}
