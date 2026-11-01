import { describe, expect, it } from "vitest";
import {
  ADD_PROVIDER_STEPS,
  applyKeyDraft,
  buildAddProviderResult,
  defaultProvider,
  isKeyDraftValid,
  resolveWizardStep,
  type ProviderKeys,
} from "./add-provider";

const keys = (
  meta: string | null,
  openai: string | null = null,
  anthropic: string | null = null,
): ProviderKeys => ({ meta, openai, anthropic });

describe("ADD_PROVIDER_STEPS", () => {
  it("walks Provider, Key like T3's add-provider dialog", () => {
    expect([...ADD_PROVIDER_STEPS]).toEqual(["Provider", "Key"]);
  });
});

describe("resolveWizardStep", () => {
  it("moves freely between the two steps", () => {
    expect(resolveWizardStep(1)).toBe(1);
    expect(resolveWizardStep(0)).toBe(0);
  });

  it("clamps wild targets", () => {
    expect(resolveWizardStep(9)).toBe(1);
    expect(resolveWizardStep(-4)).toBe(0);
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

describe("buildAddProviderResult", () => {
  it("is null without a key", () => {
    expect(
      buildAddProviderResult({ provider: "meta", key: "   " }),
    ).toBeNull();
  });

  it("trims the key", () => {
    expect(
      buildAddProviderResult({
        provider: "anthropic",
        key: "  sk-ant-abc123  ",
      }),
    ).toEqual({ provider: "anthropic", key: "sk-ant-abc123" });
  });
});
