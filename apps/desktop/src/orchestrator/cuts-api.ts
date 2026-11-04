/**
 * The cut path to Resolve: POST /cuts/apply writes a finished task's
 * cut items onto a NEW timeline copy, POST /cuts/undo makes the
 * original current again. Same shape as the sound path in
 * ../effects/sounds-api; until the agent has these routes a 404 reads
 * as "not on this agent yet", never as a failure of the task.
 */
import type { ChangesetItem } from "@chair/timeline-ir";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { agentBaseUrl } from "@/lib/services/config";

export type CutApplyInput = {
  jobId?: string;
  items?: ChangesetItem[];
  project?: string;
  timeline?: string;
};

export type CutSkipped = { intent: string; reason: string };

export type CutApplied = {
  timelineName: string;
  /** The timeline the copy was made from; cut Undo makes it current again. */
  originalTimeline: string | null;
  tracksAdded: number;
  tracksRemoved: number;
  clipsAdded: number;
  clipsRemoved: number;
  clipsChanged: number;
  markersAdded: number;
  markersRemoved: number;
  skipped: CutSkipped[];
  /** Plain-words substitute, e.g. "retime the clip in Studio by hand". */
  fallback: string | null;
};

export type CutRevertInput = {
  project?: string;
  /** The copy to leave; the original becomes current. */
  timeline?: string;
  originalTimeline: string;
};

export type CutReverted = { timeline: string; deleted: boolean };

type Options = { signal?: AbortSignal; agentUrl?: string; fetchFn?: FetchFn };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The contract says { error: "<sentence>" }; accept the agent's object shape too. */
function errorMessage(payload: unknown, status: number): string {
  if (isRecord(payload) && typeof payload.error === "string" && payload.error) {
    return payload.error;
  }
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return `agent failed (${status})`;
}

async function post(path: string, body: unknown, options: Options): Promise<unknown> {
  const url = `${agentBaseUrl(options.agentUrl)}${path}`;
  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await (options.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ServiceError("agent", `agent is unreachable at ${url}`);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new ServiceError("agent", errorMessage(payload, response.status), {
      status: response.status,
    });
  }
  return payload;
}

function malformed(detail: string): ServiceError {
  return new ServiceError("agent", `cut payload was malformed (${detail})`);
}

function skippedOf(value: unknown): CutSkipped[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.intent === "string" && typeof entry.reason === "string"
      ? [{ intent: entry.intent, reason: entry.reason }]
      : [],
  );
}

/** The contract says a string; accept a { reason } object like the effect route. */
function fallbackOf(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (isRecord(value) && typeof value.reason === "string" && value.reason) return value.reason;
  return null;
}

function countOf(payload: Record<string, unknown>, key: string): number {
  return typeof payload[key] === "number" ? (payload[key] as number) : 0;
}

export async function applyCut(
  input: CutApplyInput,
  options: Options = {},
): Promise<CutApplied> {
  const payload = await post(
    "/cuts/apply",
    {
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.items ? { items: input.items } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.timeline ? { timeline: input.timeline } : {}),
    },
    options,
  );
  if (!isRecord(payload) || typeof payload.timeline_name !== "string") {
    throw malformed("apply needs a timeline_name");
  }
  return {
    timelineName: payload.timeline_name,
    originalTimeline:
      typeof payload.original_timeline === "string" && payload.original_timeline
        ? payload.original_timeline
        : null,
    tracksAdded: countOf(payload, "tracks_added"),
    tracksRemoved: countOf(payload, "tracks_removed"),
    clipsAdded: countOf(payload, "clips_added"),
    clipsRemoved: countOf(payload, "clips_removed"),
    clipsChanged: countOf(payload, "clips_changed"),
    markersAdded: countOf(payload, "markers_added"),
    markersRemoved: countOf(payload, "markers_removed"),
    skipped: skippedOf(payload.skipped),
    fallback: fallbackOf(payload.fallback),
  };
}

export async function revertCut(
  input: CutRevertInput,
  options: Options = {},
): Promise<CutReverted> {
  const payload = await post(
    "/cuts/undo",
    {
      ...(input.project ? { project: input.project } : {}),
      ...(input.timeline ? { timeline_name: input.timeline } : {}),
      original_timeline: input.originalTimeline,
    },
    options,
  );
  if (!isRecord(payload)) throw malformed("undo needs an object");
  return {
    timeline:
      typeof payload.current_timeline === "string"
        ? payload.current_timeline
        : input.originalTimeline,
    deleted: payload.deleted === true,
  };
}

/** True when the agent has no such route yet: the UI says so instead of failing. */
export function isMissingRoute(error: unknown): boolean {
  return error instanceof ServiceError && error.status === 404;
}

/** What the card shows for an apply failure: plain words, 404-aware. */
export function cutApplyErrorMessage(error: unknown): string {
  if (isMissingRoute(error)) return "Cut apply isn't available on this agent yet.";
  return error instanceof Error ? error.message : "The cut write failed.";
}

/** What the card shows for an undo failure: plain words, 404-aware. */
export function cutUndoErrorMessage(error: unknown): string {
  if (isMissingRoute(error)) return "Undo isn't available on this agent yet.";
  return error instanceof Error ? error.message : "The undo failed.";
}
