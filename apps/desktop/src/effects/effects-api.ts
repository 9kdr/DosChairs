/**
 * The Effect Maker's link to the agent: POST /effects/generate writes a
 * spec from a brief, POST /effects/{id}/verify has the vision model
 * compare a preview frame against the brief. Failures carry the agent's
 * plain message so the activity list can say what happened.
 */
import type { EffectSpec, Keyframe } from "@chair/effects";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { agentBaseUrl } from "@/lib/services/config";
import type { PieceReference } from "./pieces-api";

export type GenerateInput = {
  prompt: string;
  canvas: { width: number; height: number };
  fps: number;
  durationSec: number;
  /** Data URL of the dropped reference image. */
  referenceImage?: string;
  /** Pieces the brief points at (@-mentions and dropped chips). */
  references?: PieceReference[];
};

export type Generated = { id: string; spec: EffectSpec; notes: string };
export type Verdict = { pass: boolean; notes: string; revisedSpec?: EffectSpec };

type Options = { signal?: AbortSignal; agentUrl?: string; fetchFn?: FetchFn };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message =
      error && typeof error.message === "string" ? error.message : `agent failed (${response.status})`;
    throw new ServiceError("agent", message, {
      status: response.status,
      code: error && typeof error.code === "string" ? error.code : undefined,
    });
  }
  return payload;
}

function malformed(detail: string): ServiceError {
  return new ServiceError("agent", `effect payload was malformed (${detail})`);
}

async function get(path: string, options: Options): Promise<unknown> {
  const url = `${agentBaseUrl(options.agentUrl)}${path}`;
  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await (options.fetchFn ?? fetch)(url, { signal: options.signal });
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
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message =
      error && typeof error.message === "string" ? error.message : `agent failed (${response.status})`;
    throw new ServiceError("agent", message, {
      status: response.status,
      code: error && typeof error.code === "string" ? error.code : undefined,
    });
  }
  return payload;
}

/** A stored draft, for the maker's edit mode: the spec, the agent's notes, the brief it keeps. */
export type StoredEffect = { id: string; spec: EffectSpec; notes: string };

const BRIEF_KEY_PREFIX = "chair.piece-brief.";

/**
 * The brief a piece was drafted from, kept beside the window: the agent
 * stores the spec and its notes, not the person's own words, so the
 * maker remembers them per effect id and edit mode loads them back.
 */
export function readPieceBrief(id: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const brief = localStorage.getItem(`${BRIEF_KEY_PREFIX}${id}`);
    return brief && brief.trim() ? brief : null;
  } catch {
    return null;
  }
}

/** Remember what a draft was asked for, for a later edit session. */
export function writePieceBrief(id: string, brief: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${BRIEF_KEY_PREFIX}${id}`, brief);
  } catch {
    // Private window or quota: the brief just won't reload.
  }
}

/** Read one stored effect back: GET /effects/:id serves the record the agent kept. */
export async function fetchEffect(id: string, options: Options = {}): Promise<StoredEffect> {
  const payload = await get(`/effects/${encodeURIComponent(id)}`, options);
  if (!isRecord(payload) || typeof payload.id !== "string" || !isRecord(payload.spec)) {
    throw malformed("effect needs an id and a spec");
  }
  return {
    id: payload.id,
    spec: payload.spec as unknown as EffectSpec,
    notes: typeof payload.notes === "string" ? payload.notes : "",
  };
}

export async function generateEffect(input: GenerateInput, options: Options = {}): Promise<Generated> {
  const payload = await post(
    "/effects/generate",
    {
      prompt: input.prompt,
      canvas: input.canvas,
      fps: input.fps,
      durationSec: input.durationSec,
      ...(input.referenceImage ? { referenceImage: input.referenceImage } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
    },
    options,
  );
  if (!isRecord(payload) || typeof payload.id !== "string" || !isRecord(payload.spec)) {
    throw malformed("generate needs an id and a spec");
  }
  return {
    id: payload.id,
    spec: payload.spec as unknown as EffectSpec,
    notes: typeof payload.notes === "string" ? payload.notes : "",
  };
}

export async function verifyEffect(
  id: string,
  frames: { previewPng: string; referencePng?: string },
  options: Options = {},
): Promise<Verdict> {
  const payload = await post(`/effects/${encodeURIComponent(id)}/verify`, frames, options);
  if (!isRecord(payload) || typeof payload.pass !== "boolean") {
    throw malformed("verify needs a boolean pass");
  }
  return {
    pass: payload.pass,
    notes: typeof payload.notes === "string" ? payload.notes : "",
    ...(isRecord(payload.revisedSpec)
      ? { revisedSpec: payload.revisedSpec as unknown as EffectSpec }
      : {}),
  };
}

/**
 * The generic "apply piece" call. The route name is historical: every
 * piece — web effect, cursor rig, title — lands through
 * POST /effects/rig/apply as a NEW comp version, never touching the
 * previous one. prev_comp_name in the answer is the undo back.
 */
export type PieceApplyInput = {
  spec?: EffectSpec;
  effectId?: string;
  /** Layer id to prop key lists: the real baked curves from the app's bake. */
  baked?: Record<string, Record<string, Keyframe[]>>;
  sequences?: Record<string, { files: string[] }>;
  trackIndex: number;
  clipIndex: number;
  trackType?: "video" | "audio";
  project?: string;
  timeline?: string;
};

export type PieceApplied = {
  effectId: string;
  project: string;
  timeline: string;
  compName: string | null;
  prevCompName: string | null;
  keyframes: number;
  paths: Record<string, string>;
};

export type PieceFallback = {
  effectId: string;
  project: string;
  timeline: string;
  fallback: { capability: string; reason: string };
};

export type PieceApplyResult = PieceApplied | PieceFallback;

export function isPieceFallback(result: PieceApplyResult): result is PieceFallback {
  return "fallback" in result;
}

function optString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export async function applyPiece(input: PieceApplyInput, options: Options = {}): Promise<PieceApplyResult> {
  const payload = await post(
    "/effects/rig/apply",
    {
      ...(input.spec ? { spec: input.spec } : {}),
      ...(input.effectId ? { effectId: input.effectId } : {}),
      ...(input.baked ? { baked: input.baked } : {}),
      ...(input.sequences ? { sequences: input.sequences } : {}),
      trackIndex: input.trackIndex,
      clipIndex: input.clipIndex,
      ...(input.trackType ? { trackType: input.trackType } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.timeline ? { timeline: input.timeline } : {}),
    },
    options,
  );
  if (!isRecord(payload) || typeof payload.effect_id !== "string") {
    throw malformed("apply needs an effect_id");
  }
  const shared = {
    effectId: payload.effect_id,
    project: typeof payload.project === "string" ? payload.project : "",
    timeline: typeof payload.timeline === "string" ? payload.timeline : "",
  };
  if (isRecord(payload.fallback)) {
    const reason = optString(payload.fallback.reason) ?? "Resolve could not take this piece as a macro.";
    return {
      ...shared,
      fallback: {
        capability:
          typeof payload.fallback.capability === "string" ? payload.fallback.capability : "fusionMacro",
        reason,
      },
    };
  }
  const paths: Record<string, string> = {};
  if (isRecord(payload.paths)) {
    for (const [layer, node] of Object.entries(payload.paths)) {
      if (typeof node === "string") paths[layer] = node;
    }
  }
  return {
    ...shared,
    compName: optString(payload.comp_name),
    prevCompName: optString(payload.prev_comp_name ?? (isRecord(payload.undo) ? payload.undo.prev_comp_name : null)),
    keyframes: typeof payload.keyframes === "number" ? payload.keyframes : 0,
    paths,
  };
}

export type PieceRevertInput = {
  project?: string;
  timeline?: string;
  trackIndex?: number;
  clipIndex?: number;
  trackType?: "video" | "audio";
  /** The comp to switch back to: the apply answer's prev_comp_name. */
  toComp: string;
};

export type PieceReverted = { compName: string | null; project: string; timeline: string };

export async function revertPiece(input: PieceRevertInput, options: Options = {}): Promise<PieceReverted> {
  const payload = await post(
    "/effects/rig/revert",
    {
      ...(input.project ? { project: input.project } : {}),
      ...(input.timeline ? { timeline: input.timeline } : {}),
      ...(input.trackIndex !== undefined ? { trackIndex: input.trackIndex } : {}),
      ...(input.clipIndex !== undefined ? { clipIndex: input.clipIndex } : {}),
      ...(input.trackType ? { trackType: input.trackType } : {}),
      toComp: input.toComp,
    },
    options,
  );
  if (!isRecord(payload)) throw malformed("revert needs an object");
  return {
    compName: optString(payload.comp_name),
    project: typeof payload.project === "string" ? payload.project : (input.project ?? ""),
    timeline: typeof payload.timeline === "string" ? payload.timeline : (input.timeline ?? ""),
  };
}

/** True when the agent has no such route yet: the UI says so instead of failing. */
export function isMissingRoute(error: unknown): boolean {
  return error instanceof ServiceError && error.status === 404;
}

/** What the piece screen shows for an undo failure: plain words, 404-aware. */
export function pieceUndoErrorMessage(error: unknown): string {
  if (isMissingRoute(error)) return "Undo isn't available on this agent yet.";
  return error instanceof Error ? error.message : "The undo failed.";
}

/**
 * True when the apply failed because the clip is gone: the cut changed
 * under the piece. The screen offers the current clip instead.
 */
export function isClipGoneError(error: unknown): boolean {
  return (
    error instanceof ServiceError &&
    error.service === "agent" &&
    typeof error.message === "string" &&
    /is not on (video|audio) track \d+/.test(error.message)
  );
}

/** The sample effect shipped with the repo: the screen works with no agent or key. */
const FIXTURES = import.meta.glob("../../../../fixtures/effects/bounce-title.effect.json", {
  eager: true,
  import: "default",
}) as Record<string, EffectSpec>;

export function sampleEffect(): EffectSpec {
  return structuredClone(Object.values(FIXTURES)[0]!);
}
