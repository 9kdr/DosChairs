import { describe, expect, it } from "vitest";
import {
  ADD_PROVIDER_STEPS,
  applyKeyDraft,
  buildAddProviderResult,
  defaultProvider,
  isKeyDraftValid,
  presetRolePick,
  resolveWizardStep,
  type ProviderKeys,
} from "./add-provider";

const keys = (
  meta: string | null,
  openai: string | null = null,
  anthropic: string | null = null,
): ProviderKeys => ({ meta, openai, anthropic });

describe("ADD_PROVIDER_STEPS", () => {
  it("walks Provider, Key, Models like T3's add-provider wizard", () => {
    expect([...ADD_PROVIDER_STEPS]).toEqual(["Provider", "Key", "Models"]);
  });
});

describe("resolveWizardStep", () => {
  it("moves freely between Provider and Key", () => {
    expect(
      resolveWizardStep(0, 1, { keyValid: false }),
    ).toEqual({ kind: "navigate", step: 1 });
    expect(
      resolveWizardStep(1, 0, { keyValid: false }),
    ).toEqual({ kind: "navigate", step: 0 });
  });

  it("blocks Models until a key is pasted", () => {
    const blocked = resolveWizardStep(1, 2, { keyValid: false });
    expect(blocked.kind).toBe("blocked");
    expect(blocked.step).toBe(1);
    expect(
      resolveWizardStep(1, 2, { keyValid: true }),
    ).toEqual({ kind: "navigate", step: 2 });
  });

  it("lets a valid draft jump straight from Provider to Models", () => {
    expect(
      resolveWizardStep(0, 2, { keyValid: true }),
    ).toEqual({ kind: "navigate", step: 2 });
  });

  it("always allows stepping back, and clamps wild targets", () => {
    expect(
      resolveWizardStep(2, 0, { keyValid: false }),
    ).toEqual({ kind: "navigate", step: 0 });
    expect(
      resolveWizardStep(0, 9, { keyValid: true }),
    ).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardStep(2, -4, { keyValid: true })).toEqual({
      kind: "navigate",
      step: 0,
    });
  });
});

describe("isKeyDraftValid", () => {
  it("needs a non-blank key", () => {
    expect(isKeyDraftValid("sk-ant-abc")).toBe(true);
    expect(isKeyDraftValid("   ")).toBe(false);
    expect(isKeyDraftValid("")).toBe(false);
  });
});

describe("applyKeyDraft", () => {
  it("switches the provider when the key format names another one", () => {
    expect(applyKeyDraft("sk-ant-abc123", "meta")).toEqual({
      provider: "anthropic",
      detected: "anthropic",
      switched: true,
    });
    expect(applyKeyDraft("sk-openai-test-key", "anthropic")).toEqual({
      provider: "openai",
      detected: "openai",
      switched: true,
    });
  });

  it("keeps the picked provider when detection agrees or is blank", () => {
    expect(applyKeyDraft("sk-ant-abc123", "anthropic")).toEqual({
      provider: "anthropic",
      detected: "anthropic",
      switched: false,
    });
    expect(applyKeyDraft("", "meta")).toEqual({
      provider: "meta",
      detected: null,
      switched: false,
    });
  });

  it("keeps the picked provider for an unknown format", () => {
    expect(applyKeyDraft("test-key", "openai")).toEqual({
      provider: "openai",
      detected: null,
      switched: false,
    });
  });
});

describe("defaultProvider", () => {
  it("prefers the first provider without a key", () => {
    expect(defaultProvider(keys(null))).toBe("meta");
    expect(defaultProvider(keys("m1"))).toBe("openai");
    expect(defaultProvider(keys("m1", "o1"))).toBe("anthropic");
  });

  it("falls back to Meta when every provider holds a key", () => {
    expect(defaultProvider(keys("m1", "o1", "a1"))).toBe("meta");
  });
});

describe("presetRolePick", () => {
  it("keeps the saved model when it already routes through the provider", () => {
    expect(
      presetRolePick({ provider: "meta", model: "muse-spark-1" }, "meta"),
    ).toEqual({ mode: "model", model: "muse-spark-1" });
  });

  it("follows the key otherwise", () => {
    expect(
      presetRolePick({ provider: "openai", model: "gpt-x" }, "meta"),
    ).toEqual({ mode: "follow" });
    expect(presetRolePick(null, "meta")).toEqual({ mode: "follow" });
  });
});

describe("buildAddProviderResult", () => {
  it("is null without a key", () => {
    expect(
      buildAddProviderResult({
        provider: "meta",
        key: "   ",
        picks: {
          planner: { mode: "follow" },
          executor: { mode: "follow" },
          verifier: { mode: "follow" },
        },
      }),
    ).toBeNull();
  });

  it("trims the key and keeps only explicit role overrides", () => {
    expect(
      buildAddProviderResult({
        provider: "anthropic",
        key: "  sk-ant-abc123  ",
        picks: {
          planner: { mode: "model", model: "claude-x" },
          executor: { mode: "follow" },
          verifier: { mode: "model", model: "  " },
        },
      }),
    ).toEqual({
      provider: "anthropic",
      key: "sk-ant-abc123",
      overrides: [{ role: "planner", model: "claude-x" }],
    });
  });
});
