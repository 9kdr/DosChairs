/**
 * Live project review through the service link: GET /projects/:id/review
 * on the agent (issue #154) returns the timeline mirror plus the latest
 * pending proposal, or no proposal yet. No sample data anywhere here: a
 * missing proposal is an empty state, a closed Studio is an error, and a
 * malformed payload fails loudly instead of rendering fakes.
 */
import type { Changeset, ChangesetItem, EditOp, Timeline } from "@chair/timeline-ir";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { agentBaseUrl } from "@/lib/services/config";

/** The proposal job behind a review bundle, as the agent reports it. */
export type ReviewJob = {
  request_id: string;
  task: string;
  finished_at: string;
};

export type ProjectReview =
  /** Live mirror with the pending proposal to review. */
  | { kind: "proposal"; timeline: Timeline; changeset: Changeset; job: ReviewJob }
  /** No proposal yet; the mirror rides along when the agent serves one. */
  | { kind: "none"; timeline: Timeline | null };

export type FetchReviewOptions = {
  agentUrl?: string;
  /** Injected for tests; defaults to window fetch. */
  fetchFn?: FetchFn;
  signal?: AbortSignal;
};

/**
 * The review endpoint serves proposals against the live Studio mirror,
 * which carries no revision. Reviewed proposals share this marker as
 * their base revision instead of a fabricated "r0".
 */
export const LIVE_BASE_REVISION = "live";

const OPS: ReadonlySet<string> = new Set([
  "add_clip",
  "remove_clip",
  "trim",
  "ripple",
  "move",
  "set_speed",
  "add_transition",
  "add_marker",
  "add_effect",
  "add_track",
  "set_gain",
  "mute_clip",
]);

function malformed(detail: string): ServiceError {
  return new ServiceError("agent", `review payload was malformed (${detail})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJson(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Mirror of the service client's agent error shape: { error: { code?, message } }. */
function errorFromJson(payload: unknown, status: number): { code?: string; message: string } {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message =
      typeof payload.error.message === "string"
        ? payload.error.message
        : `agent failed (${status})`;
    if (typeof payload.error.code === "string") {
      return { code: payload.error.code, message };
    }
    return { message };
  }
  return { message: `agent failed (${status})` };
}

function timelineFromJson(value: unknown): Timeline {
  if (!isRecord(value) || !Array.isArray(value.tracks) || !Array.isArray(value.markers)) {
    throw malformed("timeline needs tracks and markers");
  }
  return value as unknown as Timeline;
}

function itemFromJson(value: unknown): ChangesetItem {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.op !== "string" ||
    typeof value.rationale !== "string"
  ) {
    throw malformed("proposal item needs id, op, and rationale");
  }
  if (!OPS.has(value.op)) {
    throw malformed(`unknown op ${value.op}`);
  }
  const status = value.status;
  const item: ChangesetItem = {
    id: value.id,
    op: value.op as EditOp,
    rationale: value.rationale,
    status: status === "accepted" || status === "rejected" ? status : "pending",
  };
  if (typeof value.targetId === "string") item.targetId = value.targetId;
  if (typeof value.beatId === "string") item.beatId = value.beatId;
  if (isRecord(value.patch)) item.patch = value.patch;
  return item;
}

/** Parse a 200 review bundle. A null changeset is "no proposal yet". */
export function reviewFromJson(payload: unknown): ProjectReview {
  if (!isRecord(payload)) {
    throw malformed("review must be an object");
  }
  const timeline = timelineFromJson(payload.timeline);
  const changeset = payload.changeset;
  if (changeset === null || changeset === undefined) {
    return { kind: "none", timeline };
  }
  if (!isRecord(changeset) || !Array.isArray(changeset.ops)) {
    throw malformed("changeset needs ops");
  }
  const job = payload.job;
  if (
    !isRecord(job) ||
    typeof job.request_id !== "string" ||
    typeof job.task !== "string" ||
    typeof job.finished_at !== "string"
  ) {
    throw malformed("proposal needs its job");
  }
  const items = changeset.ops.map(itemFromJson);
  if (items.length === 0) {
    throw malformed("proposal has no items");
  }
  return {
    kind: "proposal",
    timeline,
    changeset: {
      schemaVersion: "0.1.0",
      id: `cs-${job.request_id}`,
      baseRevision: LIVE_BASE_REVISION,
      items,
    },
    job: { request_id: job.request_id, task: job.task, finished_at: job.finished_at },
  };
}

/**
 * Load one project's review bundle. 404 means the agent knows no
 * proposal for the project; anything else not-ok throws a ServiceError
 * carrying the agent's status, code, and message.
 */
export async function fetchProjectReview(
  projectId: string,
  options: FetchReviewOptions = {},
): Promise<ProjectReview> {
  const { agentUrl, fetchFn = fetch, signal } = options;
  const url = `${agentBaseUrl(agentUrl)}/projects/${encodeURIComponent(projectId)}/review`;
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchFn(url, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ServiceError("agent", `agent is unreachable at ${url}`);
  }
  const payload = await readJson(response);
  if (response.status === 404) {
    return { kind: "none", timeline: null };
  }
  if (!response.ok) {
    const { code, message } = errorFromJson(payload, response.status);
    throw new ServiceError("agent", message, { status: response.status, code });
  }
  return reviewFromJson(payload);
}
