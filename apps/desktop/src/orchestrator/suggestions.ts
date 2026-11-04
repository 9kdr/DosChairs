import type { Timeline } from "@chair/timeline-ir";
import type { RunningTask } from "./RunningTasks";

export type Suggestion =
  | { kind: "retry"; taskId: string; label: string }
  | { kind: "prompt"; label: string; text: string };

/** A task that failed: a failed job, or a "Failed: …" status line. */
function isFailed(task: RunningTask): boolean {
  if (task.jobStatus === "failed") return true;
  return task.status.trim().toLowerCase().startsWith("failed:");
}

const SOUND_TASK = /sound|audio|music|duck|mix|voice|riser/i;

/** True when the task already covers sound (a sound task ran or runs). */
function isSoundTask(task: RunningTask): boolean {
  return SOUND_TASK.test(task.name) || SOUND_TASK.test(task.plan?.brief ?? "");
}

function clipCount(timeline: Timeline | null): number {
  if (!timeline) return 0;
  return timeline.tracks.reduce((total, track) => total + track.clips.length, 0);
}

/**
 * Real suggestions only, at most two: a failed task offers its retry,
 * and clips on the cut with no sound task yet offer the duck prompt.
 * Anything else renders nothing — never fake recommendations.
 */
export function suggestionsFor(args: {
  timeline: Timeline | null;
  tasks: readonly RunningTask[];
}): Suggestion[] {
  const found: Suggestion[] = [];
  const failed = args.tasks.find(isFailed);
  if (failed) {
    found.push({ kind: "retry", taskId: failed.id, label: `Retry ${failed.name}` });
  }
  if (
    clipCount(args.timeline) > 0 &&
    !args.tasks.some((task) => !isFailed(task) && isSoundTask(task))
  ) {
    found.push({
      kind: "prompt",
      label: "Duck the music under the dialogue",
      text: "Duck the music under the dialogue",
    });
  }
  return found.slice(0, 2);
}
