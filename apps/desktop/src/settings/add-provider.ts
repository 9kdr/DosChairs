/**
 * Add-a-provider wizard logic, after T3 Code's
 * AddProviderInstanceDialog: the same three-beat flow — pick the
 * provider, prove the key, see the models — with an API key in
 * place of T3's sign-in. Pure so the maintained tests cover it;
 * the dialog in `sections/AddProviderDialog.tsx` is a thin view.
 */
import {
  detectProvider,
  PROVIDERS,
  type ProviderId,
  type RoleId,
} from "./providers";
import type { RoleChoice } from "./settings-store";

export const ADD_PROVIDER_STEPS = ["Provider", "Key", "Models"] as const;

export type ProviderKeys = Record<ProviderId, string | null>;

export type WizardNavigation =
  | { kind: "navigate"; step: number }
  | { kind: "blocked"; step: number; error: string };

/**
 * Step change for the wizard, after T3's resolveWizardNavigation:
 * stepping back always works; stepping forward past the key
 * needs a pasted key. Wild targets clamp to the first/last step.
 */
export function resolveWizardStep(
  current: number,
  requested: number,
  input: { keyValid: boolean },
): WizardNavigation {
  const last = ADD_PROVIDER_STEPS.length - 1;
  const target = Math.min(Math.max(requested, 0), last);
  const KEY_STEP = 1;
  if (current <= KEY_STEP && target > KEY_STEP && !input.keyValid) {
    return { kind: "blocked", step: KEY_STEP, error: "Paste a key first." };
  }
  return { kind: "navigate", step: target };
}

/** A key draft counts once it holds a non-blank string. */
export function isKeyDraftValid(draft: string): boolean {
  return draft.trim().length > 0;
}

export type KeyDraft = {
  provider: ProviderId;
  detected: ProviderId | null;
  /** True when detection moved the provider off the picked one. */
  switched: boolean;
};

/**
 * Paste-a-key auto-detect: a recognised format moves the provider
 * to the match; an unknown format stays filed under the pick.
 * Detection reads the string locally — it never sends the key.
 */
export function applyKeyDraft(draft: string, picked: ProviderId): KeyDraft {
  const trimmed = draft.trim();
  if (trimmed === "") {
    return { provider: picked, detected: null, switched: false };
  }
  const detected = detectProvider(trimmed);
  if (detected != null && detected !== picked) {
    return { provider: detected, detected, switched: true };
  }
  return { provider: picked, detected, switched: false };
}

/** The wizard opens on the first provider without a key. */
export function defaultProvider(keys: ProviderKeys): ProviderId {
  for (const provider of PROVIDERS) {
    if (keys[provider.id] == null) return provider.id;
  }
  return "meta";
}

export type RoleModelPick = { mode: "follow" } | { mode: "model"; model: string };

/**
 * Starting pick per role on the Models step: the saved model when
 * it already routes through this provider, otherwise follow —
 * which leaves the role's saved pick untouched on add.
 */
export function presetRolePick(
  saved: RoleChoice | null,
  provider: ProviderId,
): RoleModelPick {
  if (saved != null && saved.provider === provider) {
    return { mode: "model", model: saved.model };
  }
  return { mode: "follow" };
}

export type AddProviderResult = {
  provider: ProviderId;
  key: string;
  /** Only roles with an explicit model; follow roles stay as saved. */
  overrides: { role: RoleId; model: string }[];
};

/** The save payload for the settings store. Null when no key. */
export function buildAddProviderResult(input: {
  provider: ProviderId;
  key: string;
  picks: Record<RoleId, RoleModelPick>;
}): AddProviderResult | null {
  const key = input.key.trim();
  if (key === "") return null;
  const overrides: AddProviderResult["overrides"] = [];
  for (const [role, pick] of Object.entries(input.picks) as [
    RoleId,
    RoleModelPick,
  ][]) {
    if (pick.mode === "model" && pick.model.trim() !== "") {
      overrides.push({ role, model: pick.model.trim() });
    }
  }
  return { provider: input.provider, key, overrides };
}
