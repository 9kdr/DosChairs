/**
 * The sound path to Resolve: POST /sounds/apply writes a finished task's
 * sound items onto a NEW timeline copy, POST /sounds/revert makes the
 * original current again. The agent owns both routes; until they exist a
 * 404 reads as "not on this agent yet", never as a failure of the task.
 */
import type { ChangesetItem } from "@chair/timeline-ir";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { agentBaseUrl } from "@/lib/services/config";

export type SoundApplyInput = {
  jobId?: string;
  items?: ChangesetItem[];
  project?: string;
  timeline?: string;
};

export type SoundSkipped = { intent: string; reason: string };

export type SoundApplied = {
  timelineName: string;
  /** The timeline the copy was made from; sound Undo makes it current again. */
  originalTimeline: string | null;
  tracksAdded: number;
  clipsAdded: number;
  skipped: SoundSkipped[];
  /** Plain-words substitute, e.g. "set the Fairlight ducking by hand". */
  fallback: string | null;
};

export type SoundRevertInput = {
  project?: string;
  /** The copy to leave; the original becomes current. */
  timeline?: string;
  originalTimeline: string;
};

export type SoundReverted = { timeline: string; project: string };

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
  return new ServiceError("agent", `sound payload was malformed (${detail})`);
}

function skippedOf(value: unknown): SoundSkipped[] {
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

export async function applySound(
  input: SoundApplyInput,
  options: Options = {},
): Promise<SoundApplied> {
  const payload = await post(
    "/sounds/apply",
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
    tracksAdded: typeof payload.tracks_added === "number" ? payload.tracks_added : 0,
    clipsAdded: typeof payload.clips_added === "number" ? payload.clips_added : 0,
    skipped: skippedOf(payload.skipped),
    fallback: fallbackOf(payload.fallback),
  };
}

export async function revertSound(
  input: SoundRevertInput,
  options: Options = {},
): Promise<SoundReverted> {
  const payload = await post(
    "/sounds/revert",
    {
      ...(input.project ? { project: input.project } : {}),
      ...(input.timeline ? { timeline: input.timeline } : {}),
      originalTimeline: input.originalTimeline,
    },
    options,
  );
  if (!isRecord(payload)) throw malformed("revert needs an object");
  return {
    timeline: typeof payload.timeline === "string" ? payload.timeline : input.originalTimeline,
    project: typeof payload.project === "string" ? payload.project : (input.project ?? ""),
  };
}

/** True when the agent has no such route yet: the UI says so instead of failing. */
export function isMissingRoute(error: unknown): boolean {
  return error instanceof ServiceError && error.status === 404;
}

/** What the card shows for an apply failure: plain words, 404-aware. */
export function soundApplyErrorMessage(error: unknown): string {
  if (isMissingRoute(error)) return "Sound apply isn't available on this agent yet.";
  return error instanceof Error ? error.message : "The sound write failed.";
}

/** What the card shows for an undo failure: plain words, 404-aware. */
export function soundUndoErrorMessage(error: unknown): string {
  if (isMissingRoute(error)) return "Undo isn't available on this agent yet.";
  return error instanceof Error ? error.message : "The undo failed.";
}
