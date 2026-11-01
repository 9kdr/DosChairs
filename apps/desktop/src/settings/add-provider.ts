/**
 * Add-a-provider dialog logic, after T3 Code's
 * AddProviderInstanceDialog: pick the provider, paste the key —
 * with an API key in place of T3's sign-in. Pure so the maintained
 * tests cover it; the dialog in `sections/AddProviderDialog.tsx`
 * is a thin view.
 */
import {
  detectProvider,
  PROVIDERS,
  trimKeyDraft,
  type ProviderId,
} from "./providers";

export const ADD_PROVIDER_STEPS = ["Provider", "Key"] as const;

export type ProviderKeys = Record<ProviderId, string | null>;

/** Step change for the two-step wizard; wild targets clamp. */
export function resolveWizardStep(requested: number): number {
  const last = ADD_PROVIDER_STEPS.length - 1;
  return Math.min(Math.max(requested, 0), last);
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

export type AddProviderResult = {
  provider: ProviderId;
  key: string;
};

/** The save payload for the settings store. Null when no key. */
export function buildAddProviderResult(input: {
  provider: ProviderId;
  key: string;
}): AddProviderResult | null {
  const key = trimKeyDraft(input.key);
  if (key == null) return null;
  return { provider: input.provider, key };
}
