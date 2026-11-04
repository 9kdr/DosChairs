import { describe, expect, it } from "vitest";
import {
  addCustomModel,
  detectProvider,
  enabledModels,
  followChoice,
  followProvider,
  keyDetectionHint,
  keySourceLabel,
  maskKey,
  PROVIDERS,
  providerConnection,
  providerLabel,
  removeCustomModel,
  ROLES,
  trimKeyDraft,
  type ProviderId,
} from "./providers";

describe("providerLabel", () => {
  it("names each provider", () => {
    expect(providerLabel("meta")).toBe("Meta");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("anthropic")).toBe("Anthropic");
  });
});

describe("PROVIDERS", () => {
  it("carries no descriptive copy — the detail header shows status, not a blurb", () => {
    for (const provider of PROVIDERS) {
      expect(Object.keys(provider).sort()).toEqual([
        "envVar",
        "id",
        "label",
      ]);
    }
  });
});

describe("maskKey", () => {
  it("shows bullets plus the last four characters", () => {
    expect(maskKey("sk-secret-key-1234")).toBe("••••1234");
  });

  it("never leaks a short key", () => {
    expect(maskKey("abcd")).toBe("••••");
    expect(maskKey("")).toBe("••••");
  });
});

describe("providerConnection", () => {
  it("is live when a key is present and the agent is up", () => {
    expect(
      providerConnection({ appKey: true, envKey: false, agentUp: true }),
    ).toBe("live");
    expect(
      providerConnection({ appKey: false, envKey: true, agentUp: true }),
    ).toBe("live");
  });

  it("is saved when a key is present but the agent is down", () => {
    expect(
      providerConnection({ appKey: true, envKey: false, agentUp: false }),
    ).toBe("saved");
  });

  it("has no key when neither side holds one", () => {
    expect(
      providerConnection({ appKey: false, envKey: false, agentUp: true }),
    ).toBe("no-key");
  });

  it("is checking while reachability is unknown", () => {
    expect(
      providerConnection({ appKey: true, envKey: false, agentUp: null }),
    ).toBe("checking");
  });
});

describe("keySourceLabel", () => {
  it("names where the present key lives", () => {
    expect(keySourceLabel({ appKey: true, envKey: false })).toBe("app");
    expect(keySourceLabel({ appKey: false, envKey: true })).toBe("environment");
    expect(keySourceLabel({ appKey: true, envKey: true })).toBe(
      "app + environment",
    );
    expect(keySourceLabel({ appKey: false, envKey: false })).toBe("");
  });
});

describe("detectProvider", () => {
  it("names Anthropic and OpenAI keys by prefix", () => {
    expect(detectProvider("sk-ant-abc123")).toBe("anthropic");
    expect(detectProvider("sk-proj-xyz")).toBe("openai");
  });

  it("leaves anything else unknown for the person to pick", () => {
    expect(detectProvider("test-key")).toBeNull();
    expect(detectProvider("")).toBeNull();
    expect(detectProvider("  sk-ant-padded  ")).toBe("anthropic");
  });
});

describe("trimKeyDraft", () => {
  it("trims the key for saving", () => {
    expect(trimKeyDraft("  sk-ant-abc123  ")).toBe("sk-ant-abc123");
  });

  it("is null for a blank draft, so the store stays alone", () => {
    expect(trimKeyDraft("")).toBeNull();
    expect(trimKeyDraft("   ")).toBeNull();
  });
});

describe("keyDetectionHint", () => {
  it("names the detected provider when it differs from the open one", () => {
    expect(keyDetectionHint("sk-ant-abc123", "meta")).toBe(
      "Looks like an Anthropic key — saving under Meta.",
    );
    expect(keyDetectionHint("sk-test-openai-1", "anthropic")).toBe(
      "Looks like an OpenAI key — saving under Anthropic.",
    );
  });

  it("stays silent when detection agrees, is unknown, or the draft is blank", () => {
    expect(keyDetectionHint("sk-ant-abc123", "anthropic")).toBeNull();
    expect(keyDetectionHint("test-key", "meta")).toBeNull();
    expect(keyDetectionHint("   ", "meta")).toBeNull();
  });
});

describe("enabledModels", () => {
  it("lists known ids plus custom ones", () => {
    expect(enabledModels({ provider: "meta" })).toEqual([
      "muse-wonder-1.0",
      "muse-spark-1",
    ]);
    expect(
      enabledModels({ provider: "openai", custom: ["gpt-x"] }),
    ).toEqual(["gpt-x"]);
  });

  it("drops disabled ids", () => {
    expect(
      enabledModels({
        provider: "meta",
        custom: ["mine-1"],
        disabled: ["muse-spark-1", "mine-1"],
      }),
    ).toEqual(["muse-wonder-1.0"]);
  });
});

describe("followProvider", () => {
  const keys = (
    meta: string | null,
    openai: string | null = null,
    anthropic: string | null = null,
  ): Record<ProviderId, string | null> => ({ meta, openai, anthropic });

  it("follows the first provider in order with a saved key", () => {
    expect(followProvider(keys("m1"))).toBe("meta");
    expect(followProvider(keys(null, "o1"))).toBe("openai");
    expect(followProvider(keys(null, "o1", "a1"))).toBe("openai");
  });

  it("skips a provider that is switched off", () => {
    expect(
      followProvider(keys("m1", "o1"), {
        meta: false,
        openai: true,
        anthropic: true,
      }),
    ).toBe("openai");
    expect(
      followProvider(keys("m1"), {
        meta: false,
        openai: true,
        anthropic: true,
      }),
    ).toBeNull();
  });

  it("is null with no keys", () => {
    expect(followProvider(keys(null))).toBeNull();
  });
});

describe("followChoice", () => {
  const planner = ROLES[0]!;
  const allOn = { meta: true, openai: true, anthropic: true };
  const noCustom = { meta: [], openai: [], anthropic: [] };
  const noneOff = { meta: [], openai: [], anthropic: [] };

  it("routes to the follow provider's first known model", () => {
    expect(
      followChoice(
        { meta: "m1", openai: null, anthropic: null },
        planner,
      ),
    ).toEqual({ provider: "meta", model: "muse-wonder-1.0", defaulted: false });
  });

  it("keeps the role default when the provider has no known models", () => {
    expect(
      followChoice(
        { meta: null, openai: "o1", anthropic: null },
        planner,
      ),
    ).toEqual({
      provider: "openai",
      model: planner.defaultModel,
      defaulted: true,
    });
  });

  it("skips disabled models and falls to the next one on file", () => {
    expect(
      followChoice(
        { meta: "m1", openai: null, anthropic: null },
        planner,
        {
          enabled: allOn,
          customModels: noCustom,
          disabledModels: {
            ...noneOff,
            meta: ["muse-wonder-1.0"],
          },
        },
      ),
    ).toEqual({ provider: "meta", model: "muse-spark-1", defaulted: false });
  });

  it("skips a provider with every model switched off", () => {
    expect(
      followChoice(
        { meta: "m1", openai: "o1", anthropic: null },
        planner,
        {
          enabled: allOn,
          customModels: { ...noCustom, openai: ["gpt-x"] },
          disabledModels: {
            ...noneOff,
            meta: ["muse-wonder-1.0", "muse-spark-1"],
          },
        },
      ),
    ).toEqual({ provider: "openai", model: "gpt-x", defaulted: false });
  });

  it("is null with no keys", () => {
    expect(
      followChoice({ meta: null, openai: null, anthropic: null }, planner),
    ).toBeNull();
  });
});

describe("addCustomModel", () => {
  it("appends a trimmed id", () => {
    expect(
      addCustomModel({
        custom: ["mine-1"],
        known: ["muse-spark-1"],
        draft: "  mine-2  ",
      }),
    ).toEqual(["mine-1", "mine-2"]);
  });

  it("is null for a blank draft", () => {
    expect(
      addCustomModel({ custom: [], known: [], draft: "   " }),
    ).toBeNull();
  });

  it("is null when the id is already known or custom", () => {
    expect(
      addCustomModel({
        custom: [],
        known: ["muse-spark-1"],
        draft: "muse-spark-1",
      }),
    ).toBeNull();
    expect(
      addCustomModel({
        custom: ["mine-1"],
        known: [],
        draft: "mine-1",
      }),
    ).toBeNull();
  });
});

describe("removeCustomModel", () => {
  it("drops the named entry", () => {
    expect(removeCustomModel(["mine-1", "mine-2"], "mine-1")).toEqual([
      "mine-2",
    ]);
  });

  it("is null when the entry is not custom", () => {
    expect(removeCustomModel(["mine-1"], "muse-spark-1")).toBeNull();
  });
});
