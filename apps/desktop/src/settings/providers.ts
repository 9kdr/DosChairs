/** Model providers and agent roles for the settings screen. Pure data. */

export type ProviderId = "meta" | "openai" | "anthropic";
export type RoleId = "planner" | "executor" | "verifier";

export type Provider = {
  id: ProviderId;
  label: string;
  /** The `.env` variable the agent reads — shown so `.env` stays findable. */
  envVar: string;
  /** One line on what the agent does with this provider today. */
  blurb: string;
};

export const PROVIDERS: Provider[] = [
  {
    id: "meta",
    label: "Meta",
    envVar: "META_API_KEY",
    blurb: "Primary — the agent calls Meta today.",
  },
  {
    id: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    blurb: "Fallback — saved here; the agent does not call it today.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    blurb: "Fallback — saved here; the agent does not call it today.",
  },
];

export function isProviderId(value: unknown): value is ProviderId {
  return value === "meta" || value === "openai" || value === "anthropic";
}

export type Role = {
  id: RoleId;
  label: string;
  envVar: string;
  /** The default from `.env.example`; shown when nothing is saved. */
  defaultModel: string;
};

export const ROLES: Role[] = [
  {
    id: "planner",
    label: "Planner",
    envVar: "CHAIR_PLANNER_MODEL",
    defaultModel: "muse-wonder-1.0",
  },
  {
    id: "executor",
    label: "Executor",
    envVar: "CHAIR_EXECUTOR_MODEL",
    defaultModel: "muse-spark-1",
  },
  {
    id: "verifier",
    label: "Verifier",
    envVar: "CHAIR_VERIFIER_MODEL",
    defaultModel: "muse-spark-1",
  },
];

export function isRoleId(value: unknown): value is RoleId {
  return value === "planner" || value === "executor" || value === "verifier";
}

/**
 * Model names seen in this repo (`.env.example`). Anything else is typed
 * as custom — the list never invents names for providers it has not seen.
 */
export const KNOWN_MODELS: Record<ProviderId, string[]> = {
  meta: ["muse-wonder-1.0", "muse-spark-1"],
  openai: [],
  anthropic: [],
};

const MASK_TAIL = 4;

/**
 * The only way a saved key ever renders: bullets plus the last four
 * characters. Short keys show bullets alone — never the key itself.
 */
export function maskKey(key: string): string {
  const tail = key.length > MASK_TAIL ? key.slice(-MASK_TAIL) : "";
  return `••••${tail}`;
}

export type ConnectionState = "live" | "saved" | "no-key" | "checking";

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  live: "Live",
  saved: "Key saved · agent down",
  "no-key": "No key",
  checking: "Checking",
};

/**
 * Connection state per provider: a key is present (saved in the app or
 * seen by the agent in its environment) and the agent is reachable.
 * Same shape of thinking as the service-status dots, with one extra
 * state for "key on file, agent unreachable".
 */
export function providerConnection(input: {
  appKey: boolean;
  envKey: boolean;
  agentUp: boolean | null;
}): ConnectionState {
  if (input.agentUp == null) return "checking";
  if (!input.appKey && !input.envKey) return "no-key";
  return input.agentUp ? "live" : "saved";
}

/** Where the present key lives, in words. Empty string when no key. */
export function keySourceLabel(input: {
  appKey: boolean;
  envKey: boolean;
}): string {
  if (input.appKey && input.envKey) return "in the app + the environment";
  if (input.appKey) return "in the app";
  if (input.envKey) return "in the environment";
  return "";
}
