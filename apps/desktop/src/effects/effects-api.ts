/**
 * The Effect Maker's link to the agent: POST /effects/generate writes a
 * spec from a brief, POST /effects/{id}/verify has the vision model
 * compare a preview frame against the brief. Failures carry the agent's
 * plain message so the activity list can say what happened.
 */
import type { EffectSpec } from "@chair/effects";
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

/** The sample effect shipped with the repo: the screen works with no agent or key. */
const FIXTURES = import.meta.glob("../../../../fixtures/effects/bounce-title.effect.json", {
  eager: true,
  import: "default",
}) as Record<string, EffectSpec>;

export function sampleEffect(): EffectSpec {
  return structuredClone(Object.values(FIXTURES)[0]!);
}
