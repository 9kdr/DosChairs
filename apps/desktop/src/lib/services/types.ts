/** Shapes served by the agent (plan + check) and the sidecar (media jobs). */

export type AgentJobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "moderated"
  | "canceled";

export type AgentTool = {
  name: string;
  summary: string;
  destructive: boolean;
};

export type AgentHealth = {
  service: "agent";
  ok: boolean;
  tools: AgentTool[];
  models: Record<string, string | null>;
};

export type AgentArtifact = {
  url: string;
  content_type?: string | null;
};

/** A proposed edit. Applying it stays gated on a human accept in the UI. */
export type AgentChangeset = {
  status: "proposed";
  ops: Record<string, unknown>[];
};

export type AgentJob = {
  request_id: string;
  task: string;
  input: Record<string, unknown>;
  status: AgentJobStatus;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  expires_at?: string | null;
  error?: string | null;
  artifacts: AgentArtifact[];
  changeset?: AgentChangeset | null;
  billable?: boolean | null;
  status_url: string;
  cancel_url: string;
};

export type AgentJobHandle = {
  request_id: string;
  status: AgentJobStatus;
  status_url: string;
  cancel_url: string;
  expires_at?: string | null;
};

export const AGENT_TERMINAL: ReadonlySet<AgentJobStatus> = new Set([
  "completed",
  "failed",
  "moderated",
  "canceled",
]);

export function isAgentTerminal(status: AgentJobStatus): boolean {
  return AGENT_TERMINAL.has(status);
}

export type SidecarJobStatus = "queued" | "running" | "done" | "failed";

export type SidecarHealth = {
  service: "sidecar";
  ok: boolean;
  device: string;
  jobs: string[];
  sam3_runner: boolean;
  sam_audio_runner: boolean;
};

export type SidecarJob = {
  id: string;
  tool: string;
  kind: string;
  status: SidecarJobStatus;
  progress: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
};

export const SIDECAR_TERMINAL: ReadonlySet<SidecarJobStatus> = new Set([
  "done",
  "failed",
]);

export function isSidecarTerminal(status: SidecarJobStatus): boolean {
  return SIDECAR_TERMINAL.has(status);
}

/** Live reachability of one service, as last fetched. No stand-in states. */
export type ServiceState =
  | { phase: "checking" }
  | { phase: "up"; checkedAt: number }
  | { phase: "down"; checkedAt: number; message: string };
