import { describe, expect, it } from "vitest";
import { orchestratorOptions, resolveOrchestrator } from "./chat-prompt";
import type { ProviderId } from "../settings/providers";

const NO_KEYS: Record<ProviderId, string | null> = {
  meta: null,
  openai: null,
  anthropic: null,
};
const ALL_ON: Record<ProviderId, boolean> = {
  meta: true,
  openai: true,
  anthropic: true,
};
const NO_CUSTOM: Record<ProviderId, string[]> = {
  meta: [],
  openai: [],
  anthropic: [],
};
const NONE_OFF: Record<ProviderId, string[]> = {
  meta: [],
  openai: [],
  anthropic: [],
};

describe("orchestrator picker", () => {
  it("returns empty list when no key is saved", () => {
    expect(orchestratorOptions(NO_KEYS)).toEqual([]);
  });

  it("lists models from saved keys of enabled providers", () => {
    const options = orchestratorOptions({ ...NO_KEYS, meta: "key" });
    expect(options).toEqual([
      "muse-wonder-1.0 (Meta)",
      "muse-spark-1 (Meta)",
    ]);
  });

  it("adds nothing for a provider with no known models", () => {
    expect(orchestratorOptions({ ...NO_KEYS, openai: "sk-x" })).toEqual([]);
  });

  it("lists custom models after the known ones", () => {
    const options = orchestratorOptions(
      { ...NO_KEYS, openai: "sk-x" },
      {
        enabled: ALL_ON,
        customModels: { ...NO_CUSTOM, openai: ["gpt-x"] },
        disabledModels: NONE_OFF,
      },
    );
    expect(options).toEqual(["gpt-x (OpenAI)"]);
  });

  it("hides disabled models", () => {
    const options = orchestratorOptions(
      { ...NO_KEYS, meta: "key" },
      {
        enabled: ALL_ON,
        customModels: NO_CUSTOM,
        disabledModels: { ...NONE_OFF, meta: ["muse-spark-1"] },
      },
    );
    expect(options).toEqual(["muse-wonder-1.0 (Meta)"]);
  });

  it("hides a provider that is switched off", () => {
    const options = orchestratorOptions(
      { ...NO_KEYS, meta: "key" },
      {
        enabled: { ...ALL_ON, meta: false },
        customModels: NO_CUSTOM,
        disabledModels: NONE_OFF,
      },
    );
    expect(options).toEqual([]);
  });

  it("keeps a stored pick that is still offered, else first supported or null", () => {
    const options = orchestratorOptions({ ...NO_KEYS, meta: "key" });
    expect(resolveOrchestrator("muse-spark-1 (Meta)", options)).toBe("muse-spark-1 (Meta)");
    expect(resolveOrchestrator("muse-spark-1 (Meta)", orchestratorOptions(NO_KEYS))).toBe(null);
    expect(resolveOrchestrator(null, options)).toBe("muse-wonder-1.0 (Meta)");
    expect(resolveOrchestrator(null, [])).toBe(null);
  });
});
