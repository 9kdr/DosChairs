/**
 * Live project assets through the service link: GET /projects/:id/assets
 * on the agent (issue #180) returns the folders, media files, and piece
 * refs actually in the project, with per-asset proxy availability. No
 * sample data anywhere here: an unknown project is an empty listing, a
 * closed agent is an error, and a malformed payload fails loudly instead
 * of rendering fakes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { agentBaseUrl } from "@/lib/services/config";

/** How often the shelf re-reads the listing while the window is visible. */
export const ASSETS_POLL_MS = 5000;

export type PollerOptions = {
  intervalMs?: number;
  /** False while the page is hidden: ticks are skipped, never queued. */
  visible?: () => boolean;
  /** Seams for tests; the shelf uses real timers. */
  schedule?: (tick: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
};

export type Poller = { stop: () => void };

/**
 * Call onTick every intervalMs while visible stays true. Hidden ticks
 * are skipped, never bunched, so a background tab makes no requests.
 */
export function startPolling(onTick: () => void, options: PollerOptions = {}): Poller {
  const intervalMs = options.intervalMs ?? ASSETS_POLL_MS;
  const visible = options.visible ?? (() => true);
  const schedule = options.schedule ?? ((tick, ms) => setInterval(tick, ms));
  const cancel = options.cancel ?? ((timer) => clearInterval(timer as number));
  const timer = schedule(() => {
    if (visible()) onTick();
  }, intervalMs);
  return { stop: () => cancel(timer) };
}

export type ShelfAssetKind = "video" | "image" | "audio";

export type ShelfAsset = {
  id: string;
  name: string;
  kind: ShelfAssetKind;
  /** Whether the sidecar already rendered a preview for this file. */
  proxy: "ready" | "missing";
};

export type ShelfFolder = {
  id: string;
  name: string;
  assetIds: string[];
};

export type ShelfPiece = {
  id: string;
  name: string;
};

export type ProjectAssets = {
  folders: ShelfFolder[];
  assets: ShelfAsset[];
  pieces: ShelfPiece[];
};

export type FetchAssetsOptions = {
  agentUrl?: string;
  /** Injected for tests; defaults to window fetch. */
  fetchFn?: FetchFn;
  signal?: AbortSignal;
};

const KINDS: ReadonlySet<string> = new Set(["video", "image", "audio"]);

function malformed(detail: string): ServiceError {
  return new ServiceError("agent", `assets payload was malformed (${detail})`);
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

function folderFromJson(value: unknown): ShelfFolder {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Array.isArray(value.asset_ids) ||
    !value.asset_ids.every((id) => typeof id === "string")
  ) {
    throw malformed("folder needs id, name, and asset_ids");
  }
  return { id: value.id, name: value.name, assetIds: value.asset_ids };
}

function assetFromJson(value: unknown): ShelfAsset {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.kind !== "string" ||
    (value.proxy !== "ready" && value.proxy !== "missing")
  ) {
    throw malformed("asset needs id, name, kind, and proxy");
  }
  if (!KINDS.has(value.kind)) {
    throw malformed(`unknown kind ${value.kind}`);
  }
  return { id: value.id, name: value.name, kind: value.kind as ShelfAssetKind, proxy: value.proxy };
}

function pieceFromJson(value: unknown): ShelfPiece {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    throw malformed("piece needs id and name");
  }
  return { id: value.id, name: value.name };
}

/** Parse a 200 asset listing. Anything off-shape throws instead of rendering fakes. */
export function assetsFromJson(payload: unknown): ProjectAssets {
  if (!isRecord(payload)) {
    throw malformed("assets must be an object");
  }
  if (!Array.isArray(payload.folders) || !Array.isArray(payload.assets) || !Array.isArray(payload.pieces)) {
    throw malformed("assets needs folders, assets, and pieces");
  }
  return {
    folders: payload.folders.map(folderFromJson),
    assets: payload.assets.map(assetFromJson),
    pieces: payload.pieces.map(pieceFromJson),
  };
}

/**
 * Encode bytes as base64 for the import endpoint. Chunked so big media
 * files never blow the argument list.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(text);
}

/** Read a picked file as base64 for POST /projects/:id/assets. */
export async function fileToBase64(file: {
  arrayBuffer(): Promise<ArrayBufferLike>;
}): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/**
 * Import one file into the linked editor's library (issue #203). The
 * agent stores it and returns the shelf entry; without a link it answers
 * 409 editor_unlinked and the shelf keeps its session-local staging.
 * Anything not-ok throws a ServiceError carrying status, code, message.
 */
export async function importProjectAsset(
  projectId: string,
  name: string,
  data: string,
  options: FetchAssetsOptions = {},
): Promise<ShelfAsset> {
  const { agentUrl, fetchFn = fetch, signal } = options;
  const url = `${agentBaseUrl(agentUrl)}/projects/${encodeURIComponent(projectId)}/assets`;
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, data }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ServiceError("agent", `agent is unreachable at ${url}`);
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const { code, message } = errorFromJson(payload, response.status);
    throw new ServiceError("agent", message, { status: response.status, code });
  }
  if (!isRecord(payload) || !("asset" in payload)) {
    throw malformed("import needs an asset");
  }
  return assetFromJson(payload.asset);
}

/**
 * Load one project's asset listing. Anything not-ok throws a ServiceError
 * carrying the agent's status, code, and message.
 */
export async function fetchProjectAssets(
  projectId: string,
  options: FetchAssetsOptions = {},
): Promise<ProjectAssets> {
  const { agentUrl, fetchFn = fetch, signal } = options;
  const url = `${agentBaseUrl(agentUrl)}/projects/${encodeURIComponent(projectId)}/assets`;
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchFn(url, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ServiceError("agent", `agent is unreachable at ${url}`);
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const { code, message } = errorFromJson(payload, response.status);
    throw new ServiceError("agent", message, { status: response.status, code });
  }
  return assetsFromJson(payload);
}

/** Where one shelf listing stands: loading, ready with data, or failed. */
export type AssetsPhase = "loading" | "ready" | "error";

export type AssetsStore = {
  phase: AssetsPhase;
  folders: ShelfFolder[];
  assets: ShelfAsset[];
  pieces: ShelfPiece[];
  error: string | null;
  /** Full reload through the loading state; the manual refresh. */
  retry: () => void;
  /** Quiet re-read that keeps the last good listing on screen. */
  refresh: () => void;
};

export type UseProjectAssetsOptions = {
  /** Re-read cadence in ms; 0 or less disables the poll. */
  pollMs?: number;
};

const EMPTY: ProjectAssets = { folders: [], assets: [], pieces: [] };

/**
 * Open a project's asset listing for the shelf. An empty project is
 * ready with no items; only transport and malformed payloads fail.
 * The listing re-reads on a poll while the window is visible (quiet,
 * so the shelf never flashes loading) and once when the window
 * returns; a failed background re-read keeps the last good listing.
 */
export function useProjectAssets(
  projectId: string,
  options: UseProjectAssetsOptions = {},
): AssetsStore {
  const { pollMs = ASSETS_POLL_MS } = options;
  const [listing, setListing] = useState<ProjectAssets>(EMPTY);
  const [phase, setPhase] = useState<AssetsPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState({ nonce: 0, quiet: false });

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const quiet = request.quiet;
    if (!quiet) {
      setPhase("loading");
      setError(null);
      setListing(EMPTY);
    }
    void (async () => {
      try {
        const assets = await fetchProjectAssets(projectId, { signal: controller.signal });
        if (!live) return;
        setListing(assets);
        setError(null);
        setPhase("ready");
      } catch (fetchError) {
        if (!live) return;
        if (fetchError instanceof Error && fetchError.name === "AbortError") return;
        if (quiet) return;
        setError(fetchError instanceof Error ? fetchError.message : "Could not load assets.");
        setPhase("error");
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [projectId, request]);

  const retry = useCallback(
    () => setRequest((current) => ({ nonce: current.nonce + 1, quiet: false })),
    [],
  );
  const refresh = useCallback(
    () => setRequest((current) => ({ nonce: current.nonce + 1, quiet: true })),
    [],
  );

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (pollMs <= 0) return;
    const poller = startPolling(() => refreshRef.current(), {
      intervalMs: pollMs,
      visible: () => !document.hidden,
    });
    const onVisible = () => {
      if (!document.hidden) refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      poller.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollMs]);

  return {
    phase,
    folders: listing.folders,
    assets: listing.assets,
    pieces: listing.pieces,
    error,
    retry,
    refresh,
  };
}
