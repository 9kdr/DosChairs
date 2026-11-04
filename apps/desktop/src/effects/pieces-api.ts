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

/**
 * What a piece is: a saved macro, a look/effect, a motion template, or a
 * sound bed. Anything the agent sends that is not one of these reads as a
 * macro, so the shelf always has one shelf to show.
 */
export type PieceKind = "macro" | "effect" | "motion" | "sound";

const PIECE_KINDS: ReadonlySet<string> = new Set(["macro", "effect", "motion", "sound"]);

/** Read any raw kind value the agent sends; unknown kinds fall back to macro. */
export function pieceKindOf(value: unknown): PieceKind {
  return typeof value === "string" && PIECE_KINDS.has(value) ? (value as PieceKind) : "macro";
}

export const PIECE_KIND_LABEL: Record<PieceKind, string> = {
  macro: "Macro",
  effect: "Effect",
  motion: "Motion",
  sound: "Sound",
};

export type PieceInfo = {
  id: string;
  name: string;
  kind: PieceKind;
  origin: "catalog" | "macro";
  source: "user" | "system" | "catalog";
  summary: string;
  controls: PieceControl[];
};

/** What rides with a generate request: enough for the agent to look the piece up. */
export type PieceReference = { id: string; label: string };

type Options = { signal?: AbortSignal; agentUrl?: string; fetchFn?: FetchFn; limit?: number };

/** How a pieces fetch failed: never reached the agent, or it answered no. */
export type PiecesFailureKind = "offline" | "refused";

/** A pieces fetch that failed, carrying which of the two it was. */
export class PiecesError extends ServiceError {
  readonly kind: PiecesFailureKind;

  constructor(message: string, options: { status?: number; kind: PiecesFailureKind }) {
    super("agent", message, { status: options.status });
    this.name = "PiecesError";
    this.kind = options.kind;
  }
}

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
    kind: pieceKindOf(value.kind),
    origin: value.origin === "macro" ? "macro" : "catalog",
    source: value.source === "user" || value.source === "system" ? value.source : "catalog",
    summary: typeof value.summary === "string" ? value.summary : "",
    controls,
  };
}

/** The agent's own refusal reason when its error payload carries one. */
function refusedReason(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    const error = payload.error;
    if (typeof error === "string" && error.trim()) return error.trim();
    if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
      return error.message.trim();
    }
  }
  return `agent failed (${status})`;
}

export async function fetchPieces(query: string, options: Options = {}): Promise<PieceInfo[]> {
  const params = new URLSearchParams({ q: query, limit: String(options.limit ?? 12) });
  const url = `${agentBaseUrl(options.agentUrl)}/pieces/macros?${params}`;
  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await (options.fetchFn ?? fetch)(url, { signal: options.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new PiecesError(`agent is unreachable at ${url}`, { kind: "offline" });
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new PiecesError(
      `agent refused the pieces list (${response.status}): ${refusedReason(payload, response.status)}`,
      { status: response.status, kind: "refused" },
    );
  }
  if (!isRecord(payload) || !Array.isArray(payload.pieces)) {
    throw new PiecesError("piece list was malformed (needs a pieces array)", {
      kind: "refused",
    });
  }
  return payload.pieces.flatMap((piece) => pieceOf(piece) ?? []);
}
