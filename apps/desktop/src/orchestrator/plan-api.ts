/**
 * The plan board's link to the agent: GET/PUT the front, POST generate-back
 * and digest (issue #261). Reads stay local; the one write replaces the
 * front, and the back goes stale until the next generate call.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { agentBaseUrl } from "@/lib/services/config";

export type BoardKind = "style" | "campaign" | "reference" | "link";

export type PlanBeat = {
  id: string;
  role: string;
  text: string;
  startSec?: number;
  endSec?: number;
};

export type BoardItem = {
  id: string;
  kind: BoardKind;
  title: string;
  images: string[];
  url?: string;
  notes: string;
  tags: string[];
};

export type PlanFront = {
  script_md: string;
  beats: PlanBeat[];
  board: BoardItem[];
};

export type BackTask = { id: string; title: string; detail?: string };

export type ProjectPlan = {
  id: string;
  status: "draft" | "ready";
  front: PlanFront;
  frontHash: string;
  back: {
    tasks: BackTask[];
    constraints: { do: string[]; dont: string[] };
    digests: Record<string, { palette: string[]; mood: string; motionWords: string[]; keywords: string[] }>;
    frontHash?: string;
    stale?: boolean;
  };
};

type Options = { signal?: AbortSignal; agentUrl?: string; fetchFn?: FetchFn };

const BOARD_KINDS: ReadonlySet<string> = new Set(["style", "campaign", "reference", "link"]);

function kindOf(value: unknown): BoardKind {
  return typeof value === "string" && BOARD_KINDS.has(value) ? (value as BoardKind) : "reference";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function beatOf(value: unknown, fallbackId: string): PlanBeat | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    id: value.id,
    role: typeof value.role === "string" ? value.role : "",
    text: typeof value.text === "string" ? value.text : "",
    ...(num(value.startSec) !== undefined ? { startSec: num(value.startSec)! } : {}),
    ...(num(value.endSec) !== undefined ? { endSec: num(value.endSec)! } : {}),
  };
}

function boardOf(value: unknown, fallbackId: string): BoardItem | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    kind: kindOf(value.kind),
    title: typeof value.title === "string" ? value.title : fallbackId,
    images: strings(value.images),
    ...(typeof value.url === "string" && value.url ? { url: value.url } : {}),
    notes: typeof value.notes === "string" ? value.notes : "",
    tags: strings(value.tags),
  };
}

export function planOf(value: unknown, projectId: string): ProjectPlan | null {
  if (!isRecord(value) || !isRecord(value.front) || !isRecord(value.back)) return null;
  const front = value.front;
  const beats = Array.isArray(front.beats)
    ? front.beats.flatMap((entry, index) => beatOf(entry, `beat-${index + 1}`) ?? [])
    : [];
  const board = Array.isArray(front.board)
    ? front.board.flatMap((entry, index) => boardOf(entry, `item-${index + 1}`) ?? [])
    : [];
  const back = value.back;
  const tasks = Array.isArray(back.tasks)
    ? back.tasks.flatMap((entry) =>
        isRecord(entry) && typeof entry.id === "string" && typeof entry.title === "string"
          ? [{ id: entry.id, title: entry.title, ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}) }]
          : [],
      )
    : [];
  const constraints = isRecord(back.constraints) ? back.constraints : {};
  return {
    id: typeof value.id === "string" ? value.id : projectId,
    status: value.status === "ready" ? "ready" : "draft",
    front: {
      script_md: typeof front.script_md === "string" ? front.script_md : "",
      beats,
      board,
    },
    frontHash: typeof value.frontHash === "string" ? value.frontHash : "",
    back: {
      tasks,
      constraints: { do: strings(constraints.do), dont: strings(constraints.dont) },
      digests: isRecord(back.digests) ? (back.digests as ProjectPlan["back"]["digests"]) : {},
      ...(typeof back.frontHash === "string" ? { frontHash: back.frontHash } : {}),
      ...(typeof back.stale === "boolean" ? { stale: back.stale } : {}),
    },
  };
}

async function request(projectId: string, path: string, init: RequestInit, options: Options): Promise<ProjectPlan> {
  const url = `${agentBaseUrl(options.agentUrl)}/projects/${encodeURIComponent(projectId)}/plan${path}`;
  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await (options.fetchFn ?? fetch)(url, { signal: options.signal, ...init });
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
  const plan = planOf(payload, projectId);
  if (!plan) throw new ServiceError("agent", "plan payload was malformed");
  return plan;
}

export function fetchPlan(projectId: string, options: Options = {}): Promise<ProjectPlan> {
  return request(projectId, "", {}, options);
}

export function savePlan(projectId: string, front: PlanFront, options: Options = {}): Promise<ProjectPlan> {
  return request(projectId, "", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ front }),
  }, options);
}

export function generateBack(projectId: string, options: Options = {}): Promise<ProjectPlan> {
  return request(projectId, "/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }, options);
}

export function digestBoardItem(projectId: string, itemId: string, options: Options = {}): Promise<ProjectPlan> {
  return request(projectId, "/digest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemId }),
  }, options);
}

const BEAT_ROLES = ["hook", "setup", "turn", "payoff", "outro"];

function slug(text: string, fallback: string): string {
  const clean = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

/**
 * Paste import: `# Script` carries the script, `## Beat n` starts a beat,
 * images and links anywhere become board items.
 */
export function parsePlanMarkdown(text: string): PlanFront {
  const script: string[] = [];
  const beats: PlanBeat[] = [];
  const board: BoardItem[] = [];
  let current: { id: string; role: string; lines: string[] } | null = null;
  let inScript = false;
  let imageCount = 0;
  let linkCount = 0;
  const flushBeat = () => {
    if (!current) return;
    beats.push({ id: current.id, role: current.role, text: current.lines.join("\n").trim() });
    current = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(.*)$/.exec(line.trim());
    const h2 = /^##\s+(.*)$/.exec(line.trim());
    if (h1 && !h2) {
      flushBeat();
      inScript = /^script\s*$/i.test(h1[1] ?? "");
      continue;
    }
    if (h2) {
      flushBeat();
      inScript = false;
      const title = (h2[1] ?? "").trim();
      const beat = /^beat\s*(\d*)\s*[-–—:]?\s*(.*)$/i.exec(title);
      if (beat) {
        const role = (beat[2] ?? "").toLowerCase().split(/[^a-z]+/).find((word) => BEAT_ROLES.includes(word)) ?? "";
        current = { id: beat[1] ? `beat-${beat[1]}` : `beat-${slug(title, `b${beats.length + 1}`)}`, role, lines: [] };
        continue;
      }
    }
    const image = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(line);
    if (image) {
      imageCount += 1;
      board.push({
        id: `board-${slug(image[1] ?? "", `image-${imageCount}`)}`,
        kind: "reference",
        title: (image[1] ?? "").trim() || `Image ${imageCount}`,
        images: [image[2] ?? ""],
        notes: "",
        tags: [],
      });
      continue;
    }
    const link = /\[([^\]]+)\]\((https?:[^)\s]+)[^)]*\)/.exec(line);
    if (link) {
      linkCount += 1;
      board.push({
        id: `board-${slug(link[1] ?? "", `link-${linkCount}`)}`,
        kind: "link",
        title: (link[1] ?? "").trim() || `Link ${linkCount}`,
        images: [],
        url: link[2],
        notes: "",
        tags: [],
      });
      continue;
    }
    if (current) current.lines.push(line);
    else if (inScript || beats.length === 0) script.push(line);
  }
  flushBeat();
  return { script_md: script.join("\n").trim(), beats, board };
}

export type SaveState = "saved" | "saving" | "error";

/** Load the plan for a project, persist front edits, generate the back. */
export function usePlan(projectId: string | null, options: { agentUrl?: string } = {}) {
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const timer = useRef<number | null>(null);
  const agentUrl = options.agentUrl;

  useEffect(() => {
    if (!projectId) {
      setPlan(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    fetchPlan(projectId, { agentUrl })
      .then((next) => {
        if (live) setPlan(next);
      })
      .catch((fetchError: unknown) => {
        if (live) setError(fetchError instanceof Error ? fetchError.message : "The plan did not load.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId, agentUrl]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const pending = useRef<PlanFront | null>(null);

  const queueSave = useCallback(() => {
    setSaveState("saving");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!projectId || !pending.current) return;
      savePlan(projectId, pending.current, { agentUrl })
        .then((saved) => {
          setPlan(saved);
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 800);
  }, [projectId, agentUrl]);

  const updateFront = useCallback((next: PlanFront) => {
    pending.current = next;
    setPlan((current) => (current ? { ...current, front: next } : current));
    queueSave();
  }, [queueSave]);

  /** Append board items onto the latest front, so parallel drops never clobber. */
  const appendBoard = useCallback((items: BoardItem[]) => {
    if (items.length === 0) return;
    setPlan((current) => {
      if (!current) return current;
      const next = { ...current.front, board: [...current.front.board, ...items] };
      pending.current = next;
      return { ...current, front: next };
    });
    queueSave();
  }, [queueSave]);

  const generate = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      setPlan(await generateBack(projectId, { agentUrl }));
    } catch (generateError: unknown) {
      setError(generateError instanceof Error ? generateError.message : "The back plan did not generate.");
    } finally {
      setLoading(false);
    }
  }, [projectId, agentUrl]);

  const digest = useCallback(async (itemId: string) => {
    if (!projectId) return;
    try {
      setPlan(await digestBoardItem(projectId, itemId, { agentUrl }));
    } catch (digestError: unknown) {
      setError(digestError instanceof Error ? digestError.message : "The digest did not run.");
    }
  }, [projectId, agentUrl]);

  return { plan, loading, error, saveState, updateFront, appendBoard, generate, digest };
}
