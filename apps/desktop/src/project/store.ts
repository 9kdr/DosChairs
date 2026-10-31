import { useState } from "react";
import type { Changeset, ChangesetItem, EditOp, Timeline } from "@chair/timeline-ir";

/**
 * The project store: one open timeline plus one proposed changeset.
 * Opening a project loads the timeline mirror; review only flips item
 * status. Nothing here applies an item to the timeline.
 */

export type Decision = "accepted" | "rejected";

/** Timeline mirror shaped like the Resolve read output (adapters/resolve). */
export function sampleTimeline(projectId: string, name: string): Timeline {
  return {
    schemaVersion: "0.1.0",
    id: projectId,
    name,
    rate: { num: 24, den: 1 },
    globalStart: { value: 86400, rate: 24 },
    tracks: [
      {
        id: "v1",
        kind: "video",
        name: "V1",
        clips: [
          {
            id: "clip-interview",
            name: "Interview",
            mediaRef: "/media/interview.mov",
            sourceRange: {
              start: { value: 100, rate: 24 },
              duration: { value: 96, rate: 24 },
            },
            timelineRange: {
              start: { value: 86400, rate: 24 },
              duration: { value: 48, rate: 24 },
            },
          },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        name: "A1",
        clips: [
          {
            id: "clip-interview-audio",
            name: "Interview audio",
            mediaRef: "/media/interview.mov",
            sourceRange: {
              start: { value: 100, rate: 24 },
              duration: { value: 48, rate: 24 },
            },
            timelineRange: {
              start: { value: 86400, rate: 24 },
              duration: { value: 48, rate: 24 },
            },
          },
        ],
      },
      {
        id: "s1",
        kind: "subtitle",
        name: "Captions",
        clips: [
          {
            id: "sub-hello",
            name: "Hello",
            sourceRange: {
              start: { value: 0, rate: 24 },
              duration: { value: 24, rate: 24 },
            },
            timelineRange: {
              start: { value: 86412, rate: 24 },
              duration: { value: 24, rate: 24 },
            },
          },
        ],
      },
    ],
    markers: [
      {
        id: "mark-hook",
        name: "Hook",
        time: { value: 86410, rate: 24 },
        duration: { value: 1, rate: 24 },
        kind: "hook",
      },
      {
        id: "mark-open",
        name: "Open",
        time: { value: 86420, rate: 24 },
        duration: { value: 8, rate: 24 },
        kind: "beat",
        beatId: "beat-opener",
        comment: "opener",
      },
      {
        id: "mark-room-tone",
        name: "Room tone",
        time: { value: 86448, rate: 24 },
        duration: { value: 1, rate: 24 },
        kind: "user",
        comment: "room tone",
      },
    ],
  };
}

/** Proposed edits waiting on a person. All start pending. */
export function sampleChangeset(): Changeset {
  return {
    schemaVersion: "0.1.0",
    id: "cs-rough-cut-1",
    baseRevision: "r0",
    summary: "First pass on the rough cut",
    items: [
      {
        id: "item-hook-marker",
        op: "add_marker",
        rationale: "Mark the hook so the opener lands on the beat.",
        patch: {
          marker: {
            id: "mark-hook-beat",
            name: "Hook beat",
            time: { value: 86410, rate: 24 },
            kind: "beat",
            beatId: "beat-opener",
          },
        },
        status: "pending",
      },
      {
        id: "item-trim-interview",
        op: "trim",
        targetId: "clip-interview",
        rationale: "Trim the pause at the head of the interview.",
        patch: { edge: "head", frames: 12 },
        status: "pending",
      },
      {
        id: "item-broll-cutaway",
        op: "add_clip",
        targetId: "v1",
        rationale: "Cut away to the desk shot while the answer lands.",
        patch: {
          clipId: "clip-desk-wide",
          timelineStart: { value: 86424, rate: 24 },
          duration: { value: 24, rate: 24 },
        },
        status: "pending",
      },
    ],
  };
}

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

export type ProjectStore = {
  timeline: Timeline;
  changeset: Changeset;
  history: HistoryEntry[];
  pendingCount: number;
  acceptItem: (id: string) => void;
  rejectItem: (id: string) => void;
  acceptAll: () => void;
};

/** Open a project: its timeline mirror plus its pending proposals. */
export function useProject(projectId: string, projectName: string): ProjectStore {
  const [timeline] = useState<Timeline>(() => sampleTimeline(projectId, projectName));
  const [changeset, setChangeset] = useState<Changeset>(sampleChangeset);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const appendHistory = (decided: ChangesetItem[], stamp: string) => {
    if (decided.length === 0) return;
    setHistory((current) => {
      const known = new Set(current.map((entry) => entry.itemId));
      const fresh = decided.filter((item) => !known.has(item.id));
      if (fresh.length === 0) return current;
      return [
        ...current,
        ...fresh.map((item) => historyEntryForItem(changeset, item, STAND_IN_ACCEPTED_BY, stamp)),
      ];
    });
  };

  const acceptItem = (id: string) => {
    const item = changeset.items.find((entry) => entry.id === id);
    if (!item || item.status !== "pending") return;
    setChangeset(reviewItem(changeset, id, "accepted"));
    appendHistory([item], new Date().toISOString());
  };

  const acceptAll = () => {
    const { changeset: next, accepted } = acceptAllPending(changeset);
    if (accepted.length === 0) return;
    setChangeset(next);
    appendHistory(accepted, new Date().toISOString());
  };

  return {
    timeline,
    changeset,
    history,
    pendingCount: changeset.items.filter((item) => item.status === "pending").length,
    acceptItem,
    rejectItem: (id) => setChangeset((current) => reviewItem(current, id, "rejected")),
    acceptAll,
  };
}
