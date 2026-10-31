/** Editor-neutral timeline. Mirrors schemas/timeline.schema.json. */
export * from "./plans";

export interface RationalTime {
  value: number;
  rate: number;
}

export interface TimeRange {
  start: RationalTime;
  duration: RationalTime;
}

export type TrackKind = "video" | "audio" | "subtitle" | "effect";

export interface Effect {
  id: string;
  presetName: string;
  params: Record<string, unknown>;
  enabled?: boolean;
}

export interface Clip {
  id: string;
  name: string;
  mediaRef?: string;
  sourceRange: TimeRange;
  timelineRange: TimeRange;
  effects?: Effect[];
  metadata?: Record<string, unknown>;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
}

export type MarkerKind = "beat" | "hook" | "fix" | "broll" | "user" | "range";

export interface Marker {
  id: string;
  name: string;
  time: RationalTime;
  duration?: RationalTime;
  kind: MarkerKind;
  beatId?: string;
  comment?: string;
}

export interface Timeline {
  schemaVersion: "0.1.0";
  id: string;
  name: string;
  rate: { num: number; den: number };
  globalStart?: RationalTime;
  tracks: Track[];
  markers: Marker[];
  storyPlanId?: string;
  styleProfileId?: string;
}

export type EditOp =
  | "add_clip"
  | "remove_clip"
  | "trim"
  | "ripple"
  | "move"
  | "set_speed"
  | "add_transition"
  | "add_marker"
  | "add_effect"
  | "add_track"
  | "set_gain"
  | "mute_clip";

export interface ChangesetItem {
  id: string;
  op: EditOp;
  targetId?: string;
  beatId?: string;
  rationale: string;
  patch?: Record<string, unknown>;
  status: "pending" | "accepted" | "rejected";
}

export interface Changeset {
  schemaVersion: "0.1.0";
  id: string;
  baseRevision: string;
  summary?: string;
  items: ChangesetItem[];
}

export function emptyTimeline(id: string, name: string): Timeline {
  return {
    schemaVersion: "0.1.0",
    id,
    name,
    rate: { num: 24, den: 1 },
    tracks: [
      { id: "v1", kind: "video", name: "V1", clips: [] },
      { id: "a1", kind: "audio", name: "A1", clips: [] },
      { id: "s1", kind: "subtitle", name: "Captions", clips: [] },
    ],
    markers: [],
  };
}

/** Apply only accepted items. Pending and rejected items leave the timeline untouched. */
export function applyAccepted(timeline: Timeline, changeset: Changeset): Timeline {
  const next: Timeline = structuredClone(timeline);
  for (const item of changeset.items) {
    if (item.status !== "accepted") continue;
    if (item.op === "add_marker" && item.patch && "marker" in item.patch) {
      next.markers.push(item.patch.marker as Marker);
    }
  }
  return next;
}
