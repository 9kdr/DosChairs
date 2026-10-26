import type { Changeset, Timeline } from "@chair/timeline-ir";

/** Roles. Wonder plans. Spark executes and verifies. */
export type AgentRole = "planner" | "executor" | "verifier";

export interface ToolSpec {
  name: string;
  summary: string;
  destructive: false;
}

/**
 * Every tool returns an asset or a changeset item.
 * Source media is never overwritten.
 */
export const TOOLS = [
  { name: "sam3_mask", summary: "Text/point/box prompt to tracked mattes", destructive: false },
  { name: "sam3d_asset", summary: "Masked object to a 3D asset plus placement", destructive: false },
  { name: "sam_audio", summary: "Isolate or remove sound onto new stems", destructive: false },
  { name: "muse_image", summary: "Generate an image asset with prompt provenance", destructive: false },
  { name: "transcribe", summary: "Word-timed transcript and a subtitle track", destructive: false },
  { name: "svg_gen", summary: "Editable SVG vector layer", destructive: false },
  { name: "motion_graphics", summary: "Parameterized Fusion/MLT template", destructive: false },
  { name: "grade", summary: "LUT or node grade from a reference", destructive: false },
  { name: "editor_op", summary: "Cut, trim, ripple, move, speed, markers", destructive: false },
  { name: "render_preview", summary: "Low-res frames and audio for the verifier", destructive: false },
  { name: "get_frame", summary: "Single frame at time t", destructive: false },
  { name: "measure_audio", summary: "Loudness and speech/music/noise spans", destructive: false },
] as const satisfies readonly ToolSpec[];

export type ToolName = (typeof TOOLS)[number]["name"];

export interface AgentContext {
  timelineSummary: string;
  transcriptExcerpt: string;
  storyPlanId?: string;
  styleProfileId?: string;
}

export interface ProposeRequest {
  role: AgentRole;
  timeline: Timeline;
  context: AgentContext;
  instruction: string;
}

export interface ProposeResponse {
  changeset: Changeset;
  workLog: string[];
}
