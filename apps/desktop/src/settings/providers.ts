/** Model providers and agent roles for the settings screen. Pure data. */

export type ProviderId = "meta" | "openai" | "anthropic";
export type RoleId = "planner" | "executor" | "verifier";

export type Provider = {
  id: ProviderId;
  label: string;
  /** The `.env` variable the agent reads — shown so `.env` stays findable. */
  envVar: string;
};

export const PROVIDERS: Provider[] = [
  {
    id: "meta",
    label: "Meta",
    envVar: "META_API_KEY",
  },
  {
    id: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
  },
];

export function isProviderId(value: unknown): value is ProviderId {
  return value === "meta" || value === "openai" || value === "anthropic";
}

/** Display label for a provider id. Falls back to the id itself. */
export function providerLabel(id: ProviderId): string {
  return PROVIDERS.find((entry) => entry.id === id)?.label ?? id;
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

/**
 * Next custom-model list after typing a draft: trimmed, skipped when
 * blank, already known for this provider, or already custom. Null
 * when the draft adds nothing, so the caller can leave the store alone.
 */
export function addCustomModel(input: {
  custom: string[];
  known: string[];
  draft: string;
}): string[] | null {
  const name = input.draft.trim();
  if (name === "") return null;
  if (input.known.includes(name)) return null;
  if (input.custom.includes(name)) return null;
  return [...input.custom, name];
}

/** Custom-model list without one entry. Null when nothing changes. */
export function removeCustomModel(
  custom: string[],
  model: string,
): string[] | null {
  if (!custom.includes(model)) return null;
  return custom.filter((name) => name !== model);
}

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

/**
 * Name a key's provider from its format alone — no network probe, so
 * detection never spends the key or sends it anywhere. `sk-ant-…`
 * belongs to Anthropic, other `sk-…` keys to OpenAI; anything else
 * is unknown and the person picks the provider. No prefix is
 * claimed for Meta: its format is not documented in this repo.
 */
export function detectProvider(key: string): ProviderId | null {
  const trimmed = key.trim();
  if (trimmed.startsWith("sk-ant-")) return "anthropic";
  if (trimmed.startsWith("sk-")) return "openai";
  return null;
}

/**
 * A key draft counts once trimmed non-blank. Null leaves the
 * store alone. Both key inputs — the detail field and the
 * wizard — commit through here, so the rule cannot drift.
 */
export function trimKeyDraft(draft: string): string | null {
  const key = draft.trim();
  return key === "" ? null : key;
}

/**
 * The note under the detail key field when the draft names a
 * different provider than the open one: detection informs,
 * the key still files under the open provider. Null when the
 * draft is blank, unknown, or agrees with the open provider.
 */
export function keyDetectionHint(
  draft: string,
  current: ProviderId,
): string | null {
  const detected = detectProvider(draft);
  if (detected == null || detected === current) return null;
  const label = providerLabel(detected);
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  return `Looks like ${article} ${label} key — saving under ${providerLabel(current)}.`;
}

/**
 * Models on file for one provider that are switched on: known ids
 * plus custom ones, minus the disabled list. The picker and role
 * routing both read from here, so a toggle hides the model in both.
 */
export function enabledModels(input: {
  provider: ProviderId;
  custom?: string[];
  disabled?: string[];
}): string[] {
  const off = new Set(input.disabled ?? []);
  return [...KNOWN_MODELS[input.provider], ...(input.custom ?? [])].filter(
    (name) => !off.has(name),
  );
}

/**
 * The provider follow-mode roles route through: the first provider
 * in primary-to-fallback order with a saved key. Fixed priority —
 * deterministic with two keys, no timestamps. A provider switched
 * off is skipped when the enabled map is passed.
 */
export function followProvider(
  keys: Record<ProviderId, string | null>,
  enabled?: Record<ProviderId, boolean>,
): ProviderId | null {
  for (const provider of PROVIDERS) {
    if (keys[provider.id] == null) continue;
    if (enabled?.[provider.id] === false) continue;
    return provider.id;
  }
  return null;
}

export type FollowChoice = {
  provider: ProviderId;
  model: string;
  /** True when the provider has no known models and the role default fills in. */
  defaulted: boolean;
};

/**
 * Where a role with no explicit pick routes: the first provider in
 * follow order with a saved key and at least one enabled model, or
 * the follow provider with the role's default model name when no
 * provider has an enabled model on file. Null when no key is saved.
 * Disabled models never route; a provider switched off is skipped.
 */
export function followChoice(
  keys: Record<ProviderId, string | null>,
  role: Role,
  opts?: {
    enabled?: Record<ProviderId, boolean>;
    customModels?: Record<ProviderId, string[]>;
    disabledModels?: Record<ProviderId, string[]>;
  },
): FollowChoice | null {
  for (const provider of PROVIDERS) {
    if (keys[provider.id] == null) continue;
    if (opts?.enabled?.[provider.id] === false) continue;
    const models = enabledModels({
      provider: provider.id,
      custom: opts?.customModels?.[provider.id],
      disabled: opts?.disabledModels?.[provider.id],
    });
    if (models.length > 0) {
      return { provider: provider.id, model: models[0]!, defaulted: false };
    }
  }
  const provider = followProvider(keys, opts?.enabled);
  if (provider == null) return null;
  return { provider, model: role.defaultModel, defaulted: true };
}
