/**
 * Editing apps as connectable instances. Pure data.
 *
 * The capability lists below are transcribed from the adapter
 * manifests (`adapters/resolve`, `adapters/kdenlive`,
 * `adapters/otio` `manifest.py`) — the desktop cannot import
 * Python, so this file repeats them. When a manifest changes,
 * update both and keep the versions in step.
 */
import type { EditorId } from "../home/data";

export function isEditorId(value: unknown): value is EditorId {
  return value === "resolve" || value === "kdenlive" || value === "otio";
}

export type EditorCapability = {
  label: string;
  native: boolean;
  /** Where the fallback applies, in the manifest's own words. */
  fallback?: string;
};

export type EditorMeta = {
  id: EditorId;
  name: string;
  /** One line on how Chair reaches this editor. */
  blurb: string;
  version: string;
  /** Null when linking needs no path (Resolve finds Studio itself). */
  endpointLabel: string | null;
  endpointPlaceholder: string | null;
  capabilities: EditorCapability[];
};

export const EDITORS: EditorMeta[] = [
  {
    id: "resolve",
    name: "DaVinci Resolve",
    blurb: "Through Studio scripting while Studio is open.",
    version: "0.1.0",
    endpointLabel: null,
    endpointPlaceholder: null,
    capabilities: [
      { label: "Keyframes", native: true },
      { label: "Fusion comps", native: true },
      {
        label: "Adjustment layers",
        native: true,
        fallback: "on write: add an adjustment clip in Studio by hand",
      },
      { label: "Markers", native: true },
      {
        label: "Subtitles",
        native: true,
        fallback: "on write: import captions in Studio by hand",
      },
      { label: "Nested sequences", native: true },
      { label: "Speed changes", native: true },
    ],
  },
  {
    id: "kdenlive",
    name: "Kdenlive",
    blurb: "Reads and writes the project file directly.",
    version: "0.1.0",
    endpointLabel: "Project file",
    endpointPlaceholder: "/path/to/project.kdenlive",
    capabilities: [
      { label: "Keyframes", native: true },
      {
        label: "Fusion comps",
        native: false,
        fallback: "pre-rendered overlay track",
      },
      { label: "Adjustment layers", native: false },
      { label: "Markers", native: true },
      { label: "Subtitles", native: true },
      { label: "Nested sequences", native: true },
      { label: "Speed changes", native: true },
    ],
  },
  {
    id: "otio",
    name: "OTIO interchange",
    blurb: "File-based interchange other apps can open.",
    version: "0.1.0",
    endpointLabel: "Folder",
    endpointPlaceholder: "/path/to/interchange/",
    capabilities: [
      { label: "Keyframes", native: false, fallback: "baked clip" },
      {
        label: "Fusion comps",
        native: false,
        fallback: "pre-rendered overlay track",
      },
      { label: "Adjustment layers", native: false },
      { label: "Markers", native: true },
      { label: "Subtitles", native: true },
      { label: "Nested sequences", native: true },
      { label: "Speed changes", native: true },
    ],
  },
];

export type EditorConnectionState =
  | "connected"
  | "unreachable"
  | "never-configured"
  | "checking";

export const EDITOR_CONNECTION_LABEL: Record<EditorConnectionState, string> = {
  connected: "Connected",
  unreachable: "Unreachable",
  "never-configured": "Never configured",
  checking: "Checking",
};

/**
 * Connection state per editor: linked in the app plus the agent
 * answering. Same shape as the provider dots — "connected" means
 * Chair has what it needs and the agent just answered.
 */
export function editorConnection(input: {
  linked: boolean;
  agentUp: boolean | null;
}): EditorConnectionState {
  if (!input.linked) return "never-configured";
  if (input.agentUp == null) return "checking";
  return input.agentUp ? "connected" : "unreachable";
}
