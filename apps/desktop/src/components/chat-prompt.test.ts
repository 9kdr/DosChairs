import { describe, expect, it } from "vitest";
import { orchestratorLabel, orchestratorOptions, resolveOrchestrator } from "./chat-prompt";
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

  it("counts a live environment key like a saved key", () => {
    const options = orchestratorOptions(NO_KEYS, {
      enabled: ALL_ON,
      envKeys: { meta: true, openai: false, anthropic: false },
    });
    expect(options).toEqual([
      "muse-wonder-1.0 (Meta)",
      "muse-spark-1 (Meta)",
    ]);
  });

  it("shows no options when no provider has a key anywhere", () => {
    expect(
      orchestratorOptions(NO_KEYS, {
        enabled: ALL_ON,
        envKeys: { meta: false, openai: false, anthropic: false },
      }),
    ).toEqual([]);
    expect(orchestratorOptions(NO_KEYS, { enabled: ALL_ON })).toEqual([]);
  });

  it("hides an environment key for a provider that is switched off", () => {
    const options = orchestratorOptions(NO_KEYS, {
      enabled: { ...ALL_ON, meta: false },
      envKeys: { meta: true },
    });
    expect(options).toEqual([]);
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

  it("shows a short label with no provider suffix, unknown ids pass through", () => {
    expect(orchestratorLabel("muse-spark-1 (Meta)")).toBe("Muse Spark");
    expect(orchestratorLabel("muse-wonder-1.0 (Meta)")).toBe("Muse Wonder");
    expect(orchestratorLabel("gpt-x (OpenAI)")).toBe("gpt-x");
  });

  it("prefers the agent planner when nothing is saved, a saved choice still wins", () => {
    const options = orchestratorOptions({ ...NO_KEYS, meta: "key" });
    expect(resolveOrchestrator(null, options, "muse-spark-1")).toBe("muse-spark-1 (Meta)");
    expect(resolveOrchestrator(null, options, "gpt-x")).toBe("muse-wonder-1.0 (Meta)");
    expect(resolveOrchestrator(null, options, null)).toBe("muse-wonder-1.0 (Meta)");
    expect(resolveOrchestrator("muse-wonder-1.0 (Meta)", options, "muse-spark-1")).toBe(
      "muse-wonder-1.0 (Meta)",
    );
  });
});
