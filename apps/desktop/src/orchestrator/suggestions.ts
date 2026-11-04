import type { Clip, RationalTime, Timeline, Track } from "@chair/timeline-ir";
import type { RunningTask } from "./RunningTasks";

export type Suggestion =
  | { kind: "retry"; taskId: string; label: string }
  | { kind: "prompt"; label: string; text: string; reason?: string };

/** A task that failed: a failed job, or a "Failed: …" status line. */
function isFailed(task: RunningTask): boolean {
  if (task.jobStatus === "failed") return true;
  return task.status.trim().toLowerCase().startsWith("failed:");
}

function taskMatches(task: RunningTask, pattern: RegExp): boolean {
  if (isFailed(task)) return false;
  return pattern.test(task.name) || pattern.test(task.plan?.brief ?? "");
}

function hasTask(tasks: readonly RunningTask[], pattern: RegExp): boolean {
  return tasks.some((task) => taskMatches(task, pattern));
}

function truncate(text: string, maxLength = 40): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function toSeconds(time?: RationalTime, fallbackRate = 30): number {
  if (!time) return 0;
  const rate = time.rate > 0 ? time.rate : fallbackRate;
  return time.value / rate;
}

const MUSIC_CLIP_RE = /music|score|song|bed|track/i;
const MUSIC_TRACK_RE = /music|score|bed/i;

function isMusicClip(clip: Clip, track: Track): boolean {
  if (track.kind !== "audio") return false;
  if (clip.metadata?.kind === "music" || clip.metadata?.type === "music") return true;
  if (MUSIC_TRACK_RE.test(track.name)) return true;
  if (MUSIC_CLIP_RE.test(clip.name)) return true;
  if (clip.mediaRef && MUSIC_CLIP_RE.test(clip.mediaRef)) return true;
  return false;
}

const SPEECH_RE = /interview|dialogue|voice|voiceover|\bvo\b|[_-]vo[_-]|a-?roll|talk/i;

function videoClipHasAudio(clip: Clip, timeline: Timeline): boolean {
  if (clip.metadata?.hasAudio === true || clip.metadata?.audio === true) return true;
  if (
    Array.isArray(clip.metadata?.audioTracks) &&
    (clip.metadata?.audioTracks as unknown[]).length > 0
  ) {
    return true;
  }
  if (
    clip.mediaRef &&
    timeline.tracks.some(
      (track) => track.kind === "audio" && track.clips.some((c) => c.mediaRef === clip.mediaRef),
    )
  ) {
    return true;
  }
  return false;
}

function isSpeechClip(clip: Clip, track: Track, timeline: Timeline): boolean {
  if (clip.metadata?.kind === "dialogue" || clip.metadata?.kind === "speech") return true;
  if (
    track.kind === "audio" &&
    /interview|dialogue|voice|voiceover|\bvo\b|a-?roll|talk/i.test(track.name)
  ) {
    return true;
  }
  if (SPEECH_RE.test(clip.name)) return true;
  if (clip.mediaRef && SPEECH_RE.test(clip.mediaRef)) return true;
  if (track.kind === "video" && videoClipHasAudio(clip, timeline)) return true;
  return false;
}

function hasTitleOrEffect(timeline: Timeline): boolean {
  for (const track of timeline.tracks) {
    if ((track.kind === "subtitle" || track.kind === "effect") && track.clips.length > 0) {
      return true;
    }
    if (/title|caption|effect|lower.?third/i.test(track.name) && track.clips.length > 0) {
      return true;
    }
    for (const clip of track.clips) {
      if (clip.effects && clip.effects.length > 0) {
        return true;
      }
      if (/title|caption|lower.?third|super\b|intro.?title/i.test(clip.name)) {
        return true;
      }
      if (clip.mediaRef && /title|caption|lower.?third/i.test(clip.mediaRef)) {
        return true;
      }
      if (clip.metadata?.kind === "title" || clip.metadata?.type === "title") {
        return true;
      }
    }
  }
  return false;
}

interface TrackGap {
  track: Track;
  count: number;
}

function findTrackGaps(timeline: Timeline): TrackGap[] {
  const fallbackRate =
    timeline.rate && timeline.rate.den > 0 ? timeline.rate.num / timeline.rate.den : 30;
  const result: TrackGap[] = [];

  for (const track of timeline.tracks) {
    if (track.clips.length < 2) continue;
    const sorted = [...track.clips].sort((a, b) => {
      const startA = toSeconds(a.timelineRange.start, fallbackRate);
      const startB = toSeconds(b.timelineRange.start, fallbackRate);
      return startA - startB;
    });

    let count = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const prev = sorted[i];
      const next = sorted[i + 1];
      if (!prev || !next) continue;
      const prevEnd =
        toSeconds(prev.timelineRange.start, fallbackRate) +
        toSeconds(prev.timelineRange.duration, fallbackRate);
      const nextStart = toSeconds(next.timelineRange.start, fallbackRate);
      if (nextStart - prevEnd >= 0.5 - 1e-4) {
        count++;
      }
    }
    if (count > 0) {
      result.push({ track, count });
    }
  }
  return result;
}

function findSingleLongClip(timeline: Timeline): Clip | null {
  const fallbackRate =
    timeline.rate && timeline.rate.den > 0 ? timeline.rate.num / timeline.rate.den : 30;
  const allClips = timeline.tracks.flatMap((t) => t.clips);
  if (allClips.length === 0) return null;

  if (allClips.length === 1) {
    const only = allClips[0];
    if (only) {
      const dur = toSeconds(only.timelineRange.duration, fallbackRate);
      if (dur > 180) {
        return only;
      }
    }
  }

  if (allClips.length === 2) {
    const c1 = allClips[0];
    const c2 = allClips[1];
    if (c1 && c2) {
      const dur1 = toSeconds(c1.timelineRange.duration, fallbackRate);
      const dur2 = toSeconds(c2.timelineRange.duration, fallbackRate);
      if (
        dur1 > 180 &&
        dur2 > 180 &&
        (c1.name === c2.name || (c1.mediaRef && c1.mediaRef === c2.mediaRef))
      ) {
        return c1;
      }
    }
  }

  return null;
}

function clipCount(timeline: Timeline | null): number {
  if (!timeline) return 0;
  return timeline.tracks.reduce((total, track) => total + track.clips.length, 0);
}

/**
 * Suggestions for next steps based strictly on facts visible in the timeline or tasks.
 * Max 3 chips, most useful first. Never falls back to generic chips.
 */
export function suggestionsFor(args: {
  timeline: Timeline | null;
  tasks: readonly RunningTask[];
}): Suggestion[] {
  const found: Suggestion[] = [];

  // 1. A failed task leads to "Retry <task name>"
  const failed = args.tasks.find(isFailed);
  if (failed) {
    found.push({
      kind: "retry",
      taskId: failed.id,
      label: truncate(`Retry ${failed.name}`, 40),
    });
  }

  if (!args.timeline) {
    return found.slice(0, 3);
  }

  const totalClips = clipCount(args.timeline);
  if (totalClips === 0) {
    return found.slice(0, 3);
  }

  // 6. A very long timeline (over 3 min) with one long clip: "Trim the silences in <clip name>"
  const longClip = findSingleLongClip(args.timeline);
  if (longClip && !hasTask(args.tasks, /silence|pause|dead.?air/i)) {
    const baseName = longClip.name.replace(/\.[a-z0-9]+$/i, "");
    found.push({
      kind: "prompt",
      label: truncate(`Trim the silences in ${baseName || longClip.name}`, 40),
      text: `Trim the silences in ${longClip.name}`,
    });
  }

  // 4. Gaps: two clips on the same track with a gap of at least 0.5s and no cut task yet
  const tracksWithGaps = findTrackGaps(args.timeline);
  const primaryGapTrack =
    tracksWithGaps.find((t) => t.track.kind === "video") ?? tracksWithGaps[0];
  if (primaryGapTrack && !hasTask(args.tasks, /gap|ripple/i)) {
    const trackName = primaryGapTrack.track.name.trim();
    found.push({
      kind: "prompt",
      label: trackName ? truncate(`Close the gaps on ${trackName}`, 40) : "Close the gaps",
      text: trackName ? `Close the gaps on ${trackName}` : "Close the gaps",
    });
  }

  let hasMusic = false;
  let hasDialogue = false;
  for (const track of args.timeline.tracks) {
    for (const clip of track.clips) {
      if (!hasMusic && isMusicClip(clip, track)) {
        hasMusic = true;
      }
      if (!hasDialogue && isSpeechClip(clip, track, args.timeline)) {
        hasDialogue = true;
      }
    }
  }

  // 2. Music and dialogue both on the cut: suggest "Duck the music under the dialogue"
  if (hasMusic && hasDialogue && !hasTask(args.tasks, /duck|sidechain/i)) {
    found.push({
      kind: "prompt",
      label: "Duck the music under the dialogue",
      text: "Duck the music under the dialogue",
    });
  }

  // 3. Dialogue present but no music clip, and no music task yet: "Add a music bed under the dialogue"
  if (hasDialogue && !hasMusic && !hasTask(args.tasks, /music|score|song|bed/i)) {
    found.push({
      kind: "prompt",
      label: "Add a music bed under the dialogue",
      text: "Add a music bed under the dialogue",
    });
  }

  // 5. Clips on the cut but no title clip or effect yet, and no title/effect task: "Add a title over the opening"
  if (
    !hasTitleOrEffect(args.timeline) &&
    !hasTask(args.tasks, /title|caption|lower.?third|super\b|credits?/i)
  ) {
    found.push({
      kind: "prompt",
      label: "Add a title over the opening",
      text: "Add a title over the opening",
    });
  }

  return found.slice(0, 3);
}
