/**
 * Real home projects (issue #188): fetch what the agent detects across
 * editors, merge it into the persisted project-to-editor mapping, and
 * never render fakes. Malformed payloads fail loudly like review.ts;
 * rescans update stored entries by id without duplicating them.
 */
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { agentBaseUrl } from "@/lib/services/config";
import {
  EDITOR_IDS,
  type EditorId,
  type EditorInfo,
  type EditorStatus,
  type Project,
} from "./data";

export type DetectedSnapshot = {
  editors: EditorInfo[];
  projects: Project[];
};

export type StoredSnapshot = DetectedSnapshot & {
  scannedAt: string | null;
};

const PROJECTS_STORAGE_KEY = "chair.home.projects";

const STATUSES: ReadonlySet<string> = new Set(["inProject", "idle", "stopped"]);

function malformed(detail: string): ServiceError {
  return new ServiceError("agent", `projects payload was malformed (${detail})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEditorId(value: unknown): value is EditorId {
  return (
    typeof value === "string" &&
    (EDITOR_IDS as readonly string[]).includes(value)
  );
}

function editorFromJson(value: unknown): EditorInfo {
  if (!isRecord(value) || !isEditorId(value.id)) {
    throw malformed("editor needs a known id");
  }
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) {
    throw malformed(`editor ${value.id} needs a known status`);
  }
  return { id: value.id, status: value.status as EditorStatus };
}

function projectFromJson(value: unknown): Project {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    typeof value.name !== "string" ||
    value.name === "" ||
    !isEditorId(value.editor) ||
    typeof value.edited_at !== "string" ||
    Number.isNaN(Date.parse(value.edited_at)) ||
    typeof value.preview !== "string"
  ) {
    throw malformed("project needs id, name, editor, edited_at, and preview");
  }
  return {
    id: value.id,
    name: value.name,
    editorId: value.editor,
    editedAt: value.edited_at,
    preview: value.preview,
  };
}

/** Parse a 200 /projects bundle. Anything off-shape throws, never fakes. */
export function snapshotFromJson(payload: unknown): DetectedSnapshot {
  if (!isRecord(payload)) {
    throw malformed("snapshot must be an object");
  }
  if (!Array.isArray(payload.editors) || !Array.isArray(payload.projects)) {
    throw malformed("snapshot needs editors and projects");
  }
  const editors = payload.editors.map(editorFromJson);
  const projects = payload.projects.map(projectFromJson);
  const seen = new Set<string>();
  for (const project of projects) {
    if (seen.has(project.id)) {
      throw malformed(`duplicate project ${project.id}`);
    }
    seen.add(project.id);
  }
  return { editors, projects };
}

export type FetchProjectsOptions = {
  agentUrl?: string;
  /** Injected for tests; defaults to window fetch. */
  fetchFn?: FetchFn;
  signal?: AbortSignal;
};

/** Load the detected snapshot. Not-ok responses throw a ServiceError. */
export async function fetchDetectedSnapshot(
  options: FetchProjectsOptions = {},
): Promise<DetectedSnapshot> {
  const { agentUrl, fetchFn = fetch, signal } = options;
  const url = `${agentBaseUrl(agentUrl)}/projects`;
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchFn(url, { signal });
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
    throw new ServiceError("agent", `agent failed (${response.status})`, {
      status: response.status,
    });
  }
  return snapshotFromJson(payload);
}

/**
 * Merge a fresh scan into the stored mapping, keyed by project id:
 * re-detected entries update in place, new ones append, and entries the
 * scan no longer sees stay as recents. Never duplicates.
 */
export function mergeProjects(stored: Project[], detected: Project[]): Project[] {
  const byId = new Map(stored.map((project) => [project.id, project]));
  for (const project of detected) {
    byId.set(project.id, project);
  }
  const detectedIds = new Set(detected.map((project) => project.id));
  return [
    ...detected,
    ...stored
      .filter((project) => !detectedIds.has(project.id))
      .map((project) => byId.get(project.id)!),
  ];
}

/** The strip always names every editor; unscanned ones read stopped. */
export function mergeEditors(detected: EditorInfo[]): EditorInfo[] {
  const byId = new Map(detected.map((editor) => [editor.id, editor.status]));
  return EDITOR_IDS.map((id) => ({ id, status: byId.get(id) ?? "stopped" }));
}

function snapshotRecord(value: unknown): StoredSnapshot | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.editors) || !Array.isArray(value.projects)) {
    return null;
  }
  try {
    const editors = value.editors.map(editorFromJson);
    const projects = value.projects.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        !isEditorId(entry.editorId) ||
        typeof entry.editedAt !== "string" ||
        Number.isNaN(Date.parse(entry.editedAt)) ||
        typeof entry.preview !== "string"
      ) {
        throw malformed("stored project is off-shape");
      }
      return {
        id: entry.id,
        name: entry.name,
        editorId: entry.editorId,
        editedAt: entry.editedAt,
        preview: entry.preview,
      };
    });
    const scannedAt =
      typeof value.scannedAt === "string" ? value.scannedAt : null;
    return { editors: mergeEditors(editors), projects, scannedAt };
  } catch {
    return null;
  }
}

/** Last merged mapping, so home survives a restart with no agent. */
export function readStoredSnapshot(): StoredSnapshot {
  const empty: StoredSnapshot = {
    editors: mergeEditors([]),
    projects: [],
    scannedAt: null,
  };
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (raw == null) return empty;
    return snapshotRecord(JSON.parse(raw)) ?? empty;
  } catch {
    // private mode / unavailable storage / corrupt JSON: start empty
  }
  return empty;
}

export function writeStoredSnapshot(snapshot: StoredSnapshot): void {
  try {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // private mode / unavailable storage
  }
}

/** Resolve an opened project against the persisted mapping. */
export function findStoredProject(projectId: string): Project | null {
  return readStoredSnapshot().projects.find((entry) => entry.id === projectId) ?? null;
}

export type OpenProjectResult = {
  opened: boolean;
  alreadyCurrent: boolean;
  project: string | null;
  fallback?: string;
};

function openResultFromJson(payload: unknown): OpenProjectResult {
  if (
    !isRecord(payload) ||
    typeof payload.opened !== "boolean" ||
    typeof payload.alreadyCurrent !== "boolean" ||
    (payload.project !== null && typeof payload.project !== "string")
  ) {
    throw malformed("open result needs opened, alreadyCurrent, and project");
  }
  const result: OpenProjectResult = {
    opened: payload.opened,
    alreadyCurrent: payload.alreadyCurrent,
    project: payload.project,
  };
  if (typeof payload.fallback === "string") {
    result.fallback = payload.fallback;
  }
  return result;
}

function openFailure(payload: unknown): { code?: string; message?: string } {
  if (
    isRecord(payload) &&
    isRecord(payload.error) &&
    typeof payload.error.message === "string"
  ) {
    return {
      code:
        typeof payload.error.code === "string"
          ? payload.error.code
          : undefined,
      message: payload.error.message,
    };
  }
  return {};
}

/**
 * Ask the agent to put the editor on the project (issue #314). Home
 * enters the project only when this confirms the editor is on it.
 * Failures throw a ServiceError carrying the agent's plain message.
 */
export async function openProjectInEditor(
  project: Pick<Project, "id" | "name">,
  options: FetchProjectsOptions = {},
): Promise<OpenProjectResult> {
  const { agentUrl, fetchFn = fetch, signal } = options;
  const url = `${agentBaseUrl(agentUrl)}/projects/open`;
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: project.id, name: project.name }),
      signal,
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
    const failure = openFailure(payload);
    throw new ServiceError(
      "agent",
      failure.message ?? `agent failed (${response.status})`,
      { status: response.status, code: failure.code },
    );
  }
  return openResultFromJson(payload);
}
