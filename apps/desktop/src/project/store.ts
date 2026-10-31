import { useState } from "react";
import type { Changeset, ChangesetItem, Timeline } from "@chair/timeline-ir";

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

export type ProjectStore = {
  timeline: Timeline;
  changeset: Changeset;
  pendingCount: number;
  acceptItem: (id: string) => void;
  rejectItem: (id: string) => void;
};

/** Open a project: its timeline mirror plus its pending proposals. */
export function useProject(projectId: string, projectName: string): ProjectStore {
  const [timeline] = useState<Timeline>(() => sampleTimeline(projectId, projectName));
  const [changeset, setChangeset] = useState<Changeset>(sampleChangeset);

  return {
    timeline,
    changeset,
    pendingCount: changeset.items.filter((item) => item.status === "pending").length,
    acceptItem: (id) => setChangeset((current) => reviewItem(current, id, "accepted")),
    rejectItem: (id) => setChangeset((current) => reviewItem(current, id, "rejected")),
  };
}
