import type { Changeset, Timeline } from "@chair/timeline-ir";
import { loadJson, removeJson, saveJson } from "@/lib/storage";

/**
 * Local project persistence (#132): the open project plus one review
 * snapshot per project — the last timeline mirror with the decided
 * proposal — so both survive an app restart. Live agent data always
 * wins when it loads; the snapshot only re-applies the person's own
 * decisions onto a matching proposal, and fills in when the agent is
 * unreachable. UI prefs keep their own keys; there is no cloud sync.
 */

const OPEN_KEY = "chair.project.open";
const REVIEW_KEY_PREFIX = "chair.project.review.";

export type ReviewSnapshot = {
  timeline: Timeline;
  changeset: Changeset | null;
  savedAt: string;
};

function reviewKey(projectId: string): string {
  return `${REVIEW_KEY_PREFIX}${projectId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Shape-check a stored snapshot; anything else reads as missing. */
function snapshotFromJson(value: unknown): ReviewSnapshot | null {
  if (!isRecord(value)) return null;
  const { timeline, changeset, savedAt } = value;
  if (
    !isRecord(timeline) ||
    !Array.isArray(timeline.tracks) ||
    !Array.isArray(timeline.markers) ||
    typeof savedAt !== "string"
  ) {
    return null;
  }
  if (changeset !== null) {
    if (
      !isRecord(changeset) ||
      typeof changeset.id !== "string" ||
      !Array.isArray(changeset.items)
    ) {
      return null;
    }
    for (const item of changeset.items) {
      if (!isRecord(item) || typeof item.id !== "string") return null;
      if (item.status !== "pending" && item.status !== "accepted" && item.status !== "rejected") {
        return null;
      }
    }
  }
  return value as unknown as ReviewSnapshot;
}

/** The project that was open at shutdown, if any. */
export function readOpenProject(): string | null {
  const value = loadJson(OPEN_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function writeOpenProject(projectId: string | null): void {
  if (projectId === null) removeJson(OPEN_KEY);
  else saveJson(OPEN_KEY, projectId);
}

export function readReviewSnapshot(projectId: string): ReviewSnapshot | null {
  return snapshotFromJson(loadJson(reviewKey(projectId)));
}

export function writeReviewSnapshot(projectId: string, snapshot: ReviewSnapshot): void {
  saveJson(reviewKey(projectId), snapshot);
}

/**
 * Re-apply the person's stored decisions onto a freshly loaded
 * proposal. Only when both proposals are the same changeset: a new
 * proposal starts undecided. Unknown stored ids are ignored, and the
 * timeline mirror is never touched.
 */
export function withStoredDecisions(fresh: Changeset, stored: Changeset | null): Changeset {
  if (stored === null || stored.id !== fresh.id) return fresh;
  const decisions = new Map(
    stored.items
      .filter((item) => item.status !== "pending")
      .map((item) => [item.id, item.status] as const),
  );
  if (decisions.size === 0) return fresh;
  let changed = false;
  const items = fresh.items.map((item) => {
    const status = decisions.get(item.id);
    if (status === undefined || status === item.status) return item;
    changed = true;
    return { ...item, status };
  });
  return changed ? { ...fresh, items } : fresh;
}
