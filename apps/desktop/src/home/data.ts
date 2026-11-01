export type EditorId = "resolve" | "kdenlive" | "otio";

export type EditorStatus = "inProject" | "idle" | "stopped";

export type EditorInfo = {
  id: EditorId;
  status: EditorStatus;
};

export type Project = {
  id: string;
  name: string;
  editorId: EditorId;
  editedAt: string;
  /** Quiet label for the preview frame. */
  preview: string;
};

export const EDITOR_IDS: readonly EditorId[] = ["resolve", "kdenlive", "otio"];

/** Display names only — statuses always come from detection. */
export const EDITOR_META: Record<EditorId, { name: string; short: string }> = {
  resolve: { name: "DaVinci Resolve", short: "Resolve" },
  kdenlive: { name: "Kdenlive", short: "Kdenlive" },
  otio: { name: "OTIO interchange", short: "OTIO" },
};

export function editorById(id: EditorId, status: EditorStatus = "stopped"): EditorInfo {
  if (!EDITOR_IDS.includes(id)) return { id: EDITOR_IDS[0]!, status };
  return { id, status };
}

export function editorName(id: EditorId): string {
  return EDITOR_META[id].name;
}

export function editorShort(id: EditorId): string {
  return EDITOR_META[id].short;
}


export function formatEditedAt(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Unknown";
  const delta = Math.max(0, now - then);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return minutes <= 1 ? "Just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
