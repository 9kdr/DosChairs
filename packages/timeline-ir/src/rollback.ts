/**
 * Rollback history: every accepted timeline mutation keeps its inverse, so a
 * task can rewind to any point. Proposals stay gated: undo-to-here builds a
 * plain pending changeset that needs the same explicit accept as any other.
 *
 * Inverse table (closed: every inverse is itself invertible, so undoing an
 * undo re-applies):
 *
 * - add_clip <-> remove_clip (whole clip). Partial cuts — remove_clip with
 *   patch {startFrames, frames} as cut_op emits — invert to a trim carrying
 *   the before ranges instead, since the clip survives.
 * - add_marker <-> remove_marker, add_effect <-> remove_effect,
 *   add_transition <-> remove_transition, add_track <-> remove_track.
 * - trim <-> trim, move <-> move: the inverse carries the before-state
 *   snapshot (ranges / track + start) read off the timeline at accept time.
 * - ripple <-> ripple with the negated shift; set_speed / set_gain <-> same
 *   op with the before value (defaults 1x / 0 dB when the patch carries no
 *   previous value); mute_clip <-> mute_clip with the flag flipped.
 *
 * Anything the table cannot invert refuses with a reason instead of
 * guessing: unknown ops, and items whose before-state is missing from the
 * timeline (a clip, marker, effect, or track that is not there cannot be
 * snapshotted). The accept path fails closed on that refusal.
 *
 * Patch shapes read here are the ones producers emit: the agent's edit_ops
 * builders ({trimStartFrames}, {shiftFrames}, {toTrackId, startFrames},
 * {rate}, marker objects under patch.marker) plus the {edge, frames} trim
 * and {clipId} add_clip shapes the desktop stand-ins use. Inverse patches
 * add three snapshot conventions the applier understands: restoreSourceRange
 * / restoreTimelineRange (exact ranges back), startValue / startRate (exact
 * move source), and full snapshots under patch.clip / .marker / .effect /
 * .track.
 *
 * Ops with no home in the timeline IR (set_speed, set_gain, mute_clip, the
 * transition pair) invert at the patch level only: the applier leaves the
 * timeline alone and adapters interpret them. Source media is never touched;
 * history only ever rewrites the timeline IR.
 */
import type {
  Changeset,
  ChangesetFallback,
  ChangesetItem,
  Clip,
  EditOp,
  Effect,
  Marker,
  RationalTime,
  Timeline,
  Track,
} from "./index";

export interface InverseOp {
  op: EditOp;
  targetId?: string;
  patch: Record<string, unknown>;
}

export type InvertResult =
  | { ok: true; inverse: InverseOp }
  | { ok: false; reason: string };

/**
 * One accepted edit's undo point. forward is the accepted patch verbatim;
 * inverse is the op that undoes it. beatId links back to the plan step when
 * the item carries one. actor marks who caused the apply: the agent
 * applying on arrival, or the person applying by hand. fallback carries the
 * item's adapter fallback, when it had one, so history shows the same line
 * the review showed.
 */
export interface HistoryEntry {
  taskId: string;
  changesetId: string;
  itemId: string;
  op: EditOp;
  targetId?: string;
  beatId?: string;
  baseRevision: string;
  forward: Record<string, unknown>;
  inverse: InverseOp;
  acceptedAt: string;
  acceptedBy: string;
  actor: "agent" | "user";
  fallback?: ChangesetFallback;
}

export type UndoResult =
  | { ok: true; changeset: Changeset }
  | { ok: false; reason: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Locate a clip by id across all tracks, with its slot on the track. */
export function locateClip(
  timeline: Timeline,
  clipId: string,
): { track: Track; clip: Clip; index: number } | null {
  for (const track of timeline.tracks) {
    const index = track.clips.findIndex((entry) => entry.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

export function locateTrack(timeline: Timeline, trackId: string): Track | null {
  return timeline.tracks.find((track) => track.id === trackId) ?? null;
}

export function locateMarker(timeline: Timeline, markerId: string): Marker | null {
  return timeline.markers.find((marker) => marker.id === markerId) ?? null;
}

function locateEffect(clip: Clip, effectId: string): Effect | null {
  return clip.effects?.find((effect) => effect.id === effectId) ?? null;
}

/**
 * Build the inverse of one item against the timeline as it stands. The
 * timeline supplies the before-state snapshots destructive inverses need;
 * when it cannot — or the op has no defined inverse — this refuses with a
 * reason and the accept path must fail closed.
 */
export function invertItem(
  item: Pick<ChangesetItem, "id" | "op" | "targetId" | "patch">,
  timeline: Timeline,
): InvertResult {
  const patch = item.patch ?? {};
  switch (item.op) {
    case "add_clip": {
      const clipId = str(obj(patch.clip)?.id) ?? str(patch.clipId);
      if (!clipId) {
        return { ok: false, reason: "add_clip needs the added clip id (patch.clipId)" };
      }
      return { ok: true, inverse: { op: "remove_clip", targetId: clipId, patch: { clipId } } };
    }
    case "remove_clip": {
      if (!item.targetId) {
        return { ok: false, reason: "remove_clip needs its target clip" };
      }
      const found = locateClip(timeline, item.targetId);
      if (!found) {
        return {
          ok: false,
          reason: `remove_clip needs ${item.targetId} on the timeline to snapshot it`,
        };
      }
      const frames = num(patch.frames);
      if (frames != null && frames > 0) {
        // Partial cut: the clip survives, so the way back is its exact ranges.
        return {
          ok: true,
          inverse: {
            op: "trim",
            targetId: found.clip.id,
            patch: {
              restoreSourceRange: clone(found.clip.sourceRange),
              restoreTimelineRange: clone(found.clip.timelineRange),
            },
          },
        };
      }
      return {
        ok: true,
        inverse: {
          op: "add_clip",
          targetId: found.track.id,
          patch: {
            clip: clone(found.clip),
            clipId: found.clip.id,
            toTrackId: found.track.id,
            insertAt: found.index,
          },
        },
      };
    }
    case "trim": {
      if (!item.targetId) {
        return { ok: false, reason: "trim needs its target clip" };
      }
      const found = locateClip(timeline, item.targetId);
      if (!found) {
        return {
          ok: false,
          reason: `trim needs ${item.targetId} on the timeline to snapshot it`,
        };
      }
      return {
        ok: true,
        inverse: {
          op: "trim",
          targetId: found.clip.id,
          patch: {
            restoreSourceRange: clone(found.clip.sourceRange),
            restoreTimelineRange: clone(found.clip.timelineRange),
          },
        },
      };
    }
    case "ripple": {
      const shift = num(patch.shiftFrames);
      if (shift == null || shift === 0) {
        return { ok: false, reason: "ripple needs a non-zero patch.shiftFrames" };
      }
      if (!item.targetId) {
        return { ok: false, reason: "ripple needs its anchor clip" };
      }
      if (!locateClip(timeline, item.targetId)) {
        return { ok: false, reason: `ripple needs ${item.targetId} on the timeline` };
      }
      return {
        ok: true,
        inverse: { op: "ripple", targetId: item.targetId, patch: { shiftFrames: -shift } },
      };
    }
    case "move": {
      if (!item.targetId) {
        return { ok: false, reason: "move needs its target clip" };
      }
      const found = locateClip(timeline, item.targetId);
      if (!found) {
        return {
          ok: false,
          reason: `move needs ${item.targetId} on the timeline to snapshot it`,
        };
      }
      return {
        ok: true,
        inverse: {
          op: "move",
          targetId: found.clip.id,
          patch: {
            toTrackId: found.track.id,
            startValue: found.clip.timelineRange.start.value,
            startRate: found.clip.timelineRange.start.rate,
            insertAt: found.index,
          },
        },
      };
    }
    case "set_speed": {
      const after = num(patch.rate) ?? num(patch.speed);
      if (after == null) {
        return { ok: false, reason: "set_speed needs patch.rate" };
      }
      const before = num(patch.previousRate) ?? num(patch.previousSpeed) ?? 1;
      return {
        ok: true,
        inverse: {
          op: "set_speed",
          ...(item.targetId ? { targetId: item.targetId } : {}),
          patch: { rate: before, previousRate: after },
        },
      };
    }
    case "set_gain": {
      const after = num(patch.gainDb) ?? num(patch.db);
      if (after == null) {
        return { ok: false, reason: "set_gain needs patch.gainDb" };
      }
      const before = num(patch.previousGainDb) ?? num(patch.previousDb) ?? 0;
      return {
        ok: true,
        inverse: {
          op: "set_gain",
          ...(item.targetId ? { targetId: item.targetId } : {}),
          patch: { gainDb: before, previousGainDb: after },
        },
      };
    }
    case "mute_clip": {
      const muted = typeof patch.muted === "boolean" ? patch.muted : true;
      return {
        ok: true,
        inverse: {
          op: "mute_clip",
          ...(item.targetId ? { targetId: item.targetId } : {}),
          patch: { muted: !muted },
        },
      };
    }
    case "add_marker": {
      const marker = obj(patch.marker);
      const markerId = str(marker?.id);
      if (!marker || !markerId) {
        return { ok: false, reason: "add_marker needs patch.marker with an id" };
      }
      return {
        ok: true,
        inverse: {
          op: "remove_marker",
          targetId: markerId,
          patch: { markerId, marker: clone(marker) },
        },
      };
    }
    case "remove_marker": {
      const markerId =
        item.targetId ?? str(patch.markerId) ?? str(obj(patch.marker)?.id);
      if (!markerId) {
        return { ok: false, reason: "remove_marker needs the marker id" };
      }
      const marker = locateMarker(timeline, markerId);
      if (!marker) {
        return {
          ok: false,
          reason: `remove_marker needs ${markerId} on the timeline to snapshot it`,
        };
      }
      return {
        ok: true,
        inverse: { op: "add_marker", patch: { marker: clone(marker) } },
      };
    }
    case "add_effect": {
      if (!item.targetId) {
        return { ok: false, reason: "add_effect needs its target clip" };
      }
      const effectId = str(patch.effectId) ?? str(obj(patch.effect)?.id) ?? item.id;
      return {
        ok: true,
        inverse: { op: "remove_effect", targetId: item.targetId, patch: { effectId } },
      };
    }
    case "remove_effect": {
      if (!item.targetId) {
        return { ok: false, reason: "remove_effect needs its target clip" };
      }
      const effectId = str(patch.effectId) ?? str(obj(patch.effect)?.id);
      if (!effectId) {
        return { ok: false, reason: "remove_effect needs patch.effectId" };
      }
      const found = locateClip(timeline, item.targetId);
      const effect = found ? locateEffect(found.clip, effectId) : null;
      if (!found || !effect) {
        return {
          ok: false,
          reason: `remove_effect needs effect ${effectId} on ${item.targetId} to snapshot it`,
        };
      }
      return {
        ok: true,
        inverse: {
          op: "add_effect",
          targetId: found.clip.id,
          patch: {
            effect: clone(effect),
            effectId: effect.id,
            presetName: effect.presetName,
            params: clone(effect.params),
          },
        },
      };
    }
    case "add_transition": {
      if (!item.targetId) {
        return { ok: false, reason: "add_transition needs its target clip" };
      }
      const transitionId = str(patch.transitionId) ?? item.id;
      const kept: Record<string, unknown> = {};
      if (str(patch.transition)) kept.transition = patch.transition;
      if (num(patch.durationFrames)) kept.durationFrames = patch.durationFrames;
      return {
        ok: true,
        inverse: {
          op: "remove_transition",
          targetId: item.targetId,
          patch: { transitionId, transition: kept },
        },
      };
    }
    case "remove_transition": {
      if (!item.targetId) {
        return { ok: false, reason: "remove_transition needs its target clip" };
      }
      const transitionId = str(patch.transitionId) ?? item.id;
      const kept = obj(patch.transition) ?? {};
      return {
        ok: true,
        inverse: {
          op: "add_transition",
          targetId: item.targetId,
          patch: { ...clone(kept), transitionId },
        },
      };
    }
    case "add_track": {
      const trackId = str(obj(patch.track)?.id) ?? str(patch.trackId);
      if (!trackId) {
        return { ok: false, reason: "add_track needs the new track id (patch.trackId)" };
      }
      return {
        ok: true,
        inverse: { op: "remove_track", targetId: trackId, patch: { trackId } },
      };
    }
    case "remove_track": {
      const trackId =
        item.targetId ?? str(patch.trackId) ?? str(obj(patch.track)?.id);
      if (!trackId) {
        return { ok: false, reason: "remove_track needs the track id" };
      }
      const track = locateTrack(timeline, trackId);
      if (!track) {
        return {
          ok: false,
          reason: `remove_track needs ${trackId} on the timeline to snapshot it`,
        };
      }
      return {
        ok: true,
        inverse: {
          op: "add_track",
          targetId: track.id,
          patch: { track: clone(track), trackId: track.id },
        },
      };
    }
    default: {
      const op = (item as { op: string }).op;
      return { ok: false, reason: `no inverse defined for op "${op}" — refusing to accept without a way back` };
    }
  }
}

/**
 * Undo-to-here: rewind entry N plus everything after it in its task, newest
 * first, as one pending changeset. Entries from another task after the undo
 * point mean the timeline moved underneath, so this refuses with a reason
 * instead of guessing — unwind the later task first.
 */
export function buildUndoChangeset(
  history: readonly HistoryEntry[],
  entryId: string,
): UndoResult {
  const index = history.findIndex((entry) => entry.itemId === entryId);
  if (index < 0) {
    return { ok: false, reason: "That edit isn't in the accepted history — nothing to undo." };
  }
  const entry = history[index]!;
  const foreign = history
    .slice(index + 1)
    .find((later) => later.taskId !== entry.taskId);
  if (foreign) {
    return {
      ok: false,
      reason:
        `Task ${foreign.taskId} accepted ${foreign.op} (${foreign.itemId}) after this ` +
        `point — undo that first.`,
    };
  }
  const tail = history.slice(index).reverse();
  const items: ChangesetItem[] = tail.map((tailEntry) => ({
    id: `undo-${tailEntry.itemId}`,
    op: tailEntry.inverse.op,
    ...(tailEntry.inverse.targetId ? { targetId: tailEntry.inverse.targetId } : {}),
    rationale:
      `Undo ${tailEntry.op}` +
      (tailEntry.targetId ? ` on ${tailEntry.targetId}` : "") +
      ` (accepted ${tailEntry.acceptedAt}).`,
    patch: clone(tailEntry.inverse.patch),
    status: "pending",
  }));
  return {
    ok: true,
    changeset: {
      schemaVersion: "0.1.0",
      id: `cs-undo-${entry.itemId}`,
      baseRevision: entry.baseRevision,
      summary:
        tail.length === 1
          ? `Undo 1 accepted edit back to #${index + 1}.`
          : `Undo ${tail.length} accepted edits back to #${index + 1}.`,
      items,
    },
  };
}

/** Frames at 24 fps, the unit forward patches speak. */
function frames24(time: RationalTime): number {
  return time.rate === 0 ? 0 : (time.value / time.rate) * 24;
}

/** Shift a timestamp by whole 24 fps frames, keeping its own rate. */
function shiftFrames(time: RationalTime, frames: number): RationalTime {
  return { value: time.value + frames * (time.rate / 24), rate: time.rate };
}

function asTimeRange(value: unknown): { start: RationalTime; duration: RationalTime } | null {
  const range = obj(value);
  const start = obj(range?.start);
  const duration = obj(range?.duration);
  if (
    num(start?.value) == null ||
    num(start?.rate) == null ||
    num(duration?.value) == null ||
    num(duration?.rate) == null
  ) {
    return null;
  }
  return {
    start: { value: start!.value as number, rate: start!.rate as number },
    duration: { value: duration!.value as number, rate: duration!.rate as number },
  };
}

function trimClip(clip: Clip, headFrames: number, tailFrames: number): void {
  if (headFrames > 0) {
    clip.timelineRange.start = shiftFrames(clip.timelineRange.start, headFrames);
    clip.sourceRange.start = shiftFrames(clip.sourceRange.start, headFrames);
    clip.timelineRange.duration = shiftFrames(clip.timelineRange.duration, -headFrames);
    clip.sourceRange.duration = shiftFrames(clip.sourceRange.duration, -headFrames);
  }
  if (tailFrames > 0) {
    clip.timelineRange.duration = shiftFrames(clip.timelineRange.duration, -tailFrames);
    clip.sourceRange.duration = shiftFrames(clip.sourceRange.duration, -tailFrames);
  }
  for (const range of [clip.timelineRange.duration, clip.sourceRange.duration]) {
    if (range.value < 0) range.value = 0;
  }
}

function isTrackKind(value: unknown): value is Track["kind"] {
  return value === "video" || value === "audio" || value === "subtitle" || value === "effect";
}

function clipFromPatch(patch: Record<string, unknown>, fallbackId?: string): Clip | null {
  const snapshot = obj(patch.clip);
  if (snapshot && str(snapshot.id)) {
    const sourceRange = asTimeRange(snapshot.sourceRange);
    const timelineRange = asTimeRange(snapshot.timelineRange);
    if (!sourceRange || !timelineRange) return null;
    return {
      id: snapshot.id as string,
      name: str(snapshot.name) ?? (snapshot.id as string),
      ...(str(snapshot.mediaRef) ? { mediaRef: snapshot.mediaRef as string } : {}),
      sourceRange,
      timelineRange,
      ...(Array.isArray(snapshot.effects) ? { effects: clone(snapshot.effects) as Effect[] } : {}),
    };
  }
  const clipId = str(patch.clipId) ?? fallbackId;
  if (!clipId) return null;
  const start = asTimeRange(patch.timelineStart)
    ? (asTimeRange(patch.timelineStart)!.start as RationalTime)
    : obj(patch.timelineStart) &&
        num(obj(patch.timelineStart)!.value) != null &&
        num(obj(patch.timelineStart)!.rate) != null
      ? {
          value: obj(patch.timelineStart)!.value as number,
          rate: obj(patch.timelineStart)!.rate as number,
        }
      : { value: 0, rate: 24 };
  const durationValue = obj(patch.duration);
  const duration =
    durationValue && num(durationValue.value) != null && num(durationValue.rate) != null
      ? { value: durationValue.value as number, rate: durationValue.rate as number }
      : { value: 0, rate: 24 };
  return {
    id: clipId,
    name: str(patch.name) ?? clipId,
    sourceRange: { start: { value: 0, rate: 24 }, duration: clone(duration) },
    timelineRange: { start, duration },
  };
}

/**
 * Apply one item to the timeline in place. Callers clone first. Items this
 * cannot place — unknown target, unknown shape — are skipped, never half
 * applied: the accept path already failed closed on anything without a way
 * back, so the applier only ever sees hand-built edge cases. Ops with no
 * home in the IR (speed, gain, mute, transitions) are intentional no-ops.
 */
export function applyChangesetItem(timeline: Timeline, item: ChangesetItem): void {
  const patch = item.patch ?? {};
  switch (item.op) {
    case "add_marker": {
      const marker = obj(patch.marker);
      if (!marker || !str(marker.id)) return;
      if (locateMarker(timeline, marker.id as string)) return;
      const time = obj(marker.time);
      if (num(time?.value) == null || num(time?.rate) == null) return;
      timeline.markers.push({
        id: marker.id as string,
        name: str(marker.name) ?? (marker.id as string),
        time: { value: time!.value as number, rate: time!.rate as number },
        kind: marker.kind as Marker["kind"],
        ...(str(marker.beatId) ? { beatId: marker.beatId as string } : {}),
        ...(str(marker.comment) ? { comment: marker.comment as string } : {}),
      });
      return;
    }
    case "remove_marker": {
      const markerId = item.targetId ?? str(patch.markerId) ?? str(obj(patch.marker)?.id);
      if (!markerId) return;
      timeline.markers = timeline.markers.filter((marker) => marker.id !== markerId);
      return;
    }
    case "add_clip": {
      const track = item.targetId ? locateTrack(timeline, item.targetId) : null;
      if (!track) return;
      const clip = clipFromPatch(patch);
      if (!clip) return;
      if (track.clips.some((entry) => entry.id === clip.id)) return;
      const insertAt = num(patch.insertAt);
      if (insertAt != null) track.clips.splice(Math.max(0, Math.min(insertAt, track.clips.length)), 0, clip);
      else track.clips.push(clip);
      return;
    }
    case "remove_clip": {
      if (!item.targetId) return;
      const found = locateClip(timeline, item.targetId);
      if (!found) return;
      const frames = num(patch.frames);
      if (frames != null && frames > 0) {
        // Partial cut: shrink from the head when the cut starts at zero,
        // else from the tail. The inverse restores the exact ranges.
        if ((num(patch.startFrames) ?? 0) > 0) trimClip(found.clip, 0, frames);
        else trimClip(found.clip, frames, 0);
        return;
      }
      found.track.clips = found.track.clips.filter((clip) => clip.id !== found.clip.id);
      return;
    }
    case "trim": {
      if (!item.targetId) return;
      const found = locateClip(timeline, item.targetId);
      if (!found) return;
      const restoreSource = asTimeRange(patch.restoreSourceRange);
      const restoreTimeline = asTimeRange(patch.restoreTimelineRange);
      if (restoreSource && restoreTimeline) {
        found.clip.sourceRange = restoreSource;
        found.clip.timelineRange = restoreTimeline;
        return;
      }
      const head = num(patch.trimStartFrames) ?? 0;
      const tail = num(patch.trimEndFrames) ?? 0;
      if (head > 0 || tail > 0) {
        trimClip(found.clip, head, tail);
        return;
      }
      const edgeFrames = num(patch.frames) ?? 0;
      if (edgeFrames > 0) {
        if (str(patch.edge) === "tail") trimClip(found.clip, 0, edgeFrames);
        else trimClip(found.clip, edgeFrames, 0);
      }
      return;
    }
    case "move": {
      if (!item.targetId) return;
      const found = locateClip(timeline, item.targetId);
      if (!found) return;
      const toTrackId = str(patch.toTrackId);
      const toTrack = toTrackId ? locateTrack(timeline, toTrackId) : found.track;
      if (!toTrack) return;
      const startValue = num(patch.startValue);
      const startRate = num(patch.startRate);
      const startFrames = num(patch.startFrames);
      if (startValue != null && startRate != null) {
        found.clip.timelineRange.start = { value: startValue, rate: startRate };
      } else if (startFrames != null) {
        found.clip.timelineRange.start = { value: startFrames, rate: 24 };
      }
      if (toTrack.id !== found.track.id) {
        found.track.clips = found.track.clips.filter((clip) => clip.id !== found.clip.id);
        const insertAt = num(patch.insertAt);
        if (insertAt != null) {
          toTrack.clips.splice(Math.max(0, Math.min(insertAt, toTrack.clips.length)), 0, found.clip);
        } else {
          toTrack.clips.push(found.clip);
        }
      }
      return;
    }
    case "ripple": {
      const shift = num(patch.shiftFrames);
      if (shift == null || shift === 0 || !item.targetId) return;
      const found = locateClip(timeline, item.targetId);
      if (!found) return;
      const anchor = frames24(found.clip.timelineRange.start);
      for (const clip of found.track.clips) {
        if (frames24(clip.timelineRange.start) >= anchor) {
          clip.timelineRange.start = shiftFrames(clip.timelineRange.start, shift);
        }
      }
      return;
    }
    case "add_track": {
      const snapshot = obj(patch.track);
      const trackId = str(snapshot?.id) ?? str(patch.trackId);
      if (!trackId || locateTrack(timeline, trackId)) return;
      const kind = snapshot?.kind ?? patch.kind;
      timeline.tracks.push({
        id: trackId,
        kind: isTrackKind(kind) ? kind : "video",
        name: str(snapshot?.name) ?? str(patch.name) ?? trackId,
        clips: Array.isArray(snapshot?.clips) ? (clone(snapshot.clips) as Clip[]) : [],
      });
      return;
    }
    case "remove_track": {
      const trackId = item.targetId ?? str(patch.trackId) ?? str(obj(patch.track)?.id);
      if (!trackId) return;
      timeline.tracks = timeline.tracks.filter((track) => track.id !== trackId);
      return;
    }
    case "add_effect": {
      if (!item.targetId) return;
      const found = locateClip(timeline, item.targetId);
      if (!found) return;
      const snapshot = obj(patch.effect);
      const effectId = str(patch.effectId) ?? str(snapshot?.id) ?? item.id;
      found.clip.effects ??= [];
      if (found.clip.effects.some((effect) => effect.id === effectId)) return;
      found.clip.effects.push({
        id: effectId,
        presetName:
          str(patch.presetName) ?? str(snapshot?.presetName) ?? "Effect",
        params: clone(obj(patch.params) ?? obj(snapshot?.params) ?? {}),
        ...(typeof (patch.enabled ?? snapshot?.enabled) === "boolean"
          ? { enabled: (patch.enabled ?? snapshot?.enabled) as boolean }
          : {}),
      });
      return;
    }
    case "remove_effect": {
      if (!item.targetId) return;
      const found = locateClip(timeline, item.targetId);
      if (!found || !found.clip.effects) return;
      const effectId = str(patch.effectId) ?? str(obj(patch.effect)?.id);
      if (!effectId) return;
      const kept = found.clip.effects.filter((effect) => effect.id !== effectId);
      if (kept.length === 0) delete found.clip.effects;
      else found.clip.effects = kept;
      return;
    }
    case "add_transition":
    case "remove_transition":
    case "set_speed":
    case "set_gain":
    case "mute_clip":
      // No home in the timeline IR: adapters interpret these. The timeline
      // is untouched and the inverse still rewinds at the patch level.
      return;
  }
}
