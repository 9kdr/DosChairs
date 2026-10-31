export const schemaIds = [
  "capability-manifest.schema.json",
  "changeset.schema.json",
  "plan-grade.schema.json",
  "plan-motion.schema.json",
  "plan-muse-image.schema.json",
  "plan-sam-mask.schema.json",
  "story-plan.schema.json",
  "style-profile.schema.json",
  "timeline.schema.json",
] as const;

export type SchemaId = (typeof schemaIds)[number];

export const SERVICE_PORTS = {
  agent: 8787,
  sidecar: 8788,
} as const;

export type WorkLogPhase =
  | "analyzing"
  | "planning"
  | "masking"
  | "rendering"
  | "verifying"
  | "ready";

export interface WorkLogEvent {
  phase: WorkLogPhase;
  message: string;
  at: string;
}
