/**
 * The Effect Maker's link to the piece library: GET /pieces/macros?q= on the
 * agent returns the built-in pieces and the editor's own Resolve macros
 * (issue #242), each with the controls it publishes. The agent reads those
 * folders, never writes them.
 */
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { agentBaseUrl } from "@/lib/services/config";

export type PieceControl = {
  key: string;
  name: string;
  type: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  choices?: string[];
};

export type PieceInfo = {
  id: string;
  name: string;
  /** title, transition, generator, effect, macro, ograf, or a catalogue effect name. */
  kind: string;
  origin: "catalog" | "macro";
  source: "user" | "system" | "catalog";
  summary: string;
  controls: PieceControl[];
};

/** What rides with a generate request: enough for the agent to look the piece up. */
export type PieceReference = { id: string; label: string };

type Options = { signal?: AbortSignal; agentUrl?: string; fetchFn?: FetchFn; limit?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function controlOf(value: unknown): PieceControl | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.type !== "string") return null;
  const key = typeof value.key === "string" ? value.key : value.name;
  const scalar = (v: unknown) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined);
  return {
    key,
    name: value.name,
    type: value.type,
    ...(scalar(value.default) !== undefined ? { default: scalar(value.default)! } : {}),
    ...(typeof value.min === "number" ? { min: value.min } : {}),
    ...(typeof value.max === "number" ? { max: value.max } : {}),
    ...(Array.isArray(value.choices) ? { choices: value.choices.map(String) } : {}),
  };
}

function pieceOf(value: unknown): PieceInfo | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  const controls = Array.isArray(value.controls) ? value.controls.flatMap((c) => controlOf(c) ?? []) : [];
  return {
    id: value.id,
    name: value.name,
    kind: typeof value.kind === "string" ? value.kind : "piece",
    origin: value.origin === "macro" ? "macro" : "catalog",
    source: value.source === "user" || value.source === "system" ? value.source : "catalog",
    summary: typeof value.summary === "string" ? value.summary : "",
    controls,
  };
}

export async function fetchPieces(query: string, options: Options = {}): Promise<PieceInfo[]> {
  const params = new URLSearchParams({ q: query, limit: String(options.limit ?? 12) });
  const url = `${agentBaseUrl(options.agentUrl)}/pieces/macros?${params}`;
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
  if (!response.ok) throw new ServiceError("agent", `agent failed (${response.status})`, { status: response.status });
  if (!isRecord(payload) || !Array.isArray(payload.pieces)) {
    throw new ServiceError("agent", "piece list was malformed (needs a pieces array)");
  }
  return payload.pieces.flatMap((piece) => pieceOf(piece) ?? []);
}
