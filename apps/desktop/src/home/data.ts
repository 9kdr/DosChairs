export type EditorId = "resolve" | "kdenlive" | "otio";

export type EditorStatus = "inProject" | "idle" | "stopped";

export type EditorInfo = {
  id: EditorId;
  name: string;
  short: string;
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

export const EDITORS: readonly EditorInfo[] = [
  { id: "resolve", name: "DaVinci Resolve", short: "Resolve", status: "inProject" },
  { id: "kdenlive", name: "Kdenlive", short: "Kdenlive", status: "idle" },
  { id: "otio", name: "OTIO interchange", short: "OTIO", status: "stopped" },
];

export const PROJECTS: readonly Project[] = [
  {
    id: "proj_talking_head",
    name: "Talking head rough-cut",
    editorId: "resolve",
    editedAt: "2026-10-26T18:40:00.000Z",
    preview: "Hook · setup · pay-off",
  },
  {
    id: "proj_captions",
    name: "Caption pass — trailer",
    editorId: "kdenlive",
    editedAt: "2026-10-25T09:12:00.000Z",
    preview: "Subs on V2",
  },
  {
    id: "proj_b_roll",
    name: "B-roll shelf",
    editorId: "resolve",
    editedAt: "2026-10-22T14:05:00.000Z",
    preview: "12 clips · no audio",
  },
  {
    id: "proj_otio_roundtrip",
    name: "OTIO round-trip sample",
    editorId: "otio",
    editedAt: "2026-10-18T11:30:00.000Z",
    preview: "Interchange only",
  },
];

export function editorById(id: EditorId): EditorInfo {
  return EDITORS.find((editor) => editor.id === id) ?? EDITORS[0]!;
}

/** Rendered files the agent can reuse as-is — never templates or macros. */
export type LibraryAssetKind = "music" | "image" | "video" | "sfx";

export type LibraryAsset = {
  id: string;
  name: string;
  kind: LibraryAssetKind;
  /** Quiet label for the row: duration, dimensions, or loop note. */
  detail: string;
};

/** Stand-ins until the library reads real files. No downloads, no agent. */
export const LIBRARY_ASSETS: readonly LibraryAsset[] = [
  { id: "lib_lofi_bed", name: "Lo-fi bed — 90 BPM", kind: "music", detail: "2:04 · loops" },
  { id: "lib_riser", name: "Riser sting", kind: "sfx", detail: "0:06" },
  { id: "lib_pop", name: "Bubble pop", kind: "sfx", detail: "0:01" },
  { id: "lib_meme_cat", name: "Meme still — surprised cat", kind: "image", detail: "1280 × 720" },
  { id: "lib_meme_fine", name: "Meme still — this is fine", kind: "image", detail: "1024 × 1024" },
  { id: "lib_broll_night", name: "City b-roll — night", kind: "video", detail: "0:18 · silent" },
];

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
