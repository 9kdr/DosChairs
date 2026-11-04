import { describe, expect, it } from "vitest";
import {
  createSettingsStore,
  createWebBackend,
  EMPTY_SETTINGS,
  parseSettings,
  type SettingsBackend,
} from "./settings-store";

function memoryBackend(seed?: unknown): SettingsBackend & { written: unknown[] } {
  let doc = seed;
  const written: unknown[] = [];
  return {
    written,
    async read() {
      return doc;
    },
    async write(next) {
      doc = structuredClone(next);
      written.push(structuredClone(next));
    },
  };
}

describe("parseSettings", () => {
  it("returns empty settings for garbage", () => {
    expect(parseSettings(null)).toEqual(EMPTY_SETTINGS);
    expect(parseSettings("nope")).toEqual(EMPTY_SETTINGS);
    expect(parseSettings(42)).toEqual(EMPTY_SETTINGS);
  });

  it("keeps valid fields and drops malformed ones", () => {
    const parsed = parseSettings({
      keys: { meta: "sk-1", openai: 42, unknown: "x", anthropic: "" },
      models: {
        planner: { provider: "meta", model: "muse-wonder-1.0" },
        executor: { provider: "meta", model: "" },
        verifier: "muse-spark-1",
      },
    });
    expect(parsed.keys).toEqual({ meta: "sk-1", openai: null, anthropic: null });
    expect(parsed.models.planner).toEqual({
      provider: "meta",
      model: "muse-wonder-1.0",
    });
    expect(parsed.models.executor).toBeNull();
    expect(parsed.models.verifier).toBeNull();
  });

  it("keeps a valid orchestrator pick and drops garbage", () => {
    expect(parseSettings({ orchestrator: "Chair fast" }).orchestrator).toBe(
      "Chair fast",
    );
    expect(parseSettings({ orchestrator: "" }).orchestrator).toBeNull();
    expect(parseSettings({ orchestrator: 42 }).orchestrator).toBeNull();
  });

  it("defaults apply mode to auto and still parses a saved ask", async () => {
    expect(EMPTY_SETTINGS.applyMode).toBe("auto");
    expect(parseSettings({}).applyMode).toBe("auto");
    expect(parseSettings({ applyMode: "ask" }).applyMode).toBe("ask");
    expect(parseSettings({ applyMode: "auto" }).applyMode).toBe("auto");
    expect(parseSettings({ applyMode: "manual" }).applyMode).toBe("auto");
    const store = createSettingsStore(memoryBackend({}));
    expect((await store.load()).applyMode).toBe("auto");
  });

  it("defaults every provider to enabled and keeps saved flags", () => {
    expect(parseSettings({}).enabled).toEqual({
      meta: true,
      openai: true,
      anthropic: true,
    });
    expect(
      parseSettings({ enabled: { meta: false, openai: "yes" } }).enabled,
    ).toEqual({ meta: false, openai: true, anthropic: true });
  });

  it("keeps valid custom models and drops malformed ones", () => {
    expect(parseSettings({}).customModels).toEqual({
      meta: [],
      openai: [],
      anthropic: [],
    });
    expect(
      parseSettings({
        customModels: {
          meta: ["mine-1", "", 42],
          openai: "gpt-x",
          unknown: ["x"],
        },
      }).customModels,
    ).toEqual({ meta: ["mine-1"], openai: [], anthropic: [] });
  });

  it("keeps valid disabled models and drops malformed ones", () => {
    expect(parseSettings({}).disabledModels).toEqual({
      meta: [],
      openai: [],
      anthropic: [],
    });
    expect(
      parseSettings({
        disabledModels: {
          meta: ["muse-spark-1", "", 42],
          openai: "gpt-x",
          unknown: ["x"],
        },
      }).disabledModels,
    ).toEqual({ meta: ["muse-spark-1"], openai: [], anthropic: [] });
  });

  it("still parses docs saved before the new fields", () => {
    const parsed = parseSettings({
      keys: { meta: "sk-1" },
      models: { planner: { provider: "meta", model: "muse-wonder-1.0" } },
    });
    expect(parsed.keys.meta).toBe("sk-1");
    expect(parsed.models.planner).toEqual({
      provider: "meta",
      model: "muse-wonder-1.0",
    });
    expect(parsed.enabled.meta).toBe(true);
    expect(parsed.customModels.meta).toEqual([]);
    expect(parsed.disabledModels.meta).toEqual([]);
  });
});

describe("settings store", () => {
  it("loads empty settings when nothing is stored", async () => {
    const store = createSettingsStore(memoryBackend());
    await expect(store.load()).resolves.toEqual(EMPTY_SETTINGS);
  });

  it("saves a key and keeps the other fields", async () => {
    const store = createSettingsStore(memoryBackend());
    const next = await store.saveKey("meta", "sk-1");
    expect(next.keys.meta).toBe("sk-1");
    expect(next.keys.openai).toBeNull();
    await expect(store.load()).resolves.toEqual(next);
  });

  it("clears a key with null or an empty string", async () => {
    const store = createSettingsStore(
      memoryBackend({ keys: { meta: "sk-1" }, models: {} }),
    );
    await expect(store.saveKey("meta", null)).resolves.toMatchObject({
      keys: { meta: null },
    });
    await store.saveKey("meta", "sk-2");
    await expect(store.saveKey("meta", "")).resolves.toMatchObject({
      keys: { meta: null },
    });
  });

  it("saves a model choice per role", async () => {
    const store = createSettingsStore(memoryBackend());
    const next = await store.saveModel("planner", {
      provider: "meta",
      model: "muse-wonder-1.0",
    });
    expect(next.models.planner).toEqual({
      provider: "meta",
      model: "muse-wonder-1.0",
    });
    await expect(store.load()).resolves.toEqual(next);
  });

  it("toggles a provider on and off", async () => {
    const store = createSettingsStore(memoryBackend());
    const off = await store.saveProviderEnabled("openai", false);
    expect(off.enabled).toEqual({ meta: true, openai: false, anthropic: true });
    await expect(store.load()).resolves.toEqual(off);
    const on = await store.saveProviderEnabled("openai", true);
    expect(on.enabled.openai).toBe(true);
  });

  it("saves custom models trimmed and deduped", async () => {
    const store = createSettingsStore(memoryBackend());
    const next = await store.saveCustomModels("meta", [
      "  mine-1  ",
      "",
      "mine-1",
      "mine-2",
    ]);
    expect(next.customModels.meta).toEqual(["mine-1", "mine-2"]);
    await expect(store.load()).resolves.toEqual(next);
  });

  it("disables and re-enables one model per provider", async () => {
    const store = createSettingsStore(memoryBackend());
    const off = await store.saveModelEnabled("meta", "muse-spark-1", false);
    expect(off.disabledModels).toEqual({
      meta: ["muse-spark-1"],
      openai: [],
      anthropic: [],
    });
    await expect(store.load()).resolves.toEqual(off);
    const offAgain = await store.saveModelEnabled("meta", "muse-spark-1", false);
    expect(offAgain.disabledModels.meta).toEqual(["muse-spark-1"]);
    const on = await store.saveModelEnabled("meta", "muse-spark-1", true);
    expect(on.disabledModels.meta).toEqual([]);
    await expect(store.load()).resolves.toEqual(on);
  });

  it("saves the orchestrator pick", async () => {
    const store = createSettingsStore(memoryBackend());
    const next = await store.saveOrchestrator("Chair fast");
    expect(next.orchestrator).toBe("Chair fast");
    await expect(store.load()).resolves.toEqual(next);
    await expect(store.saveOrchestrator("")).resolves.toMatchObject({
      orchestrator: null,
    });
  });

  it("links and unlinks editors", async () => {
    const store = createSettingsStore(memoryBackend());
    const linked = await store.saveEditorConnection("kdenlive", {
      endpoint: " /tmp/cut.kdenlive ",
    });
    expect(linked.editors.kdenlive).toEqual({
      endpoint: "/tmp/cut.kdenlive",
    });
    const resolve = await store.saveEditorConnection("resolve", {
      endpoint: null,
    });
    expect(resolve.editors.resolve).toEqual({ endpoint: null });
    await expect(
      store.saveEditorConnection("kdenlive", null),
    ).resolves.toMatchObject({ editors: { kdenlive: null } });
  });

  it("drops malformed editor links when parsing", () => {
    const parsed = parseSettings({
      editors: {
        resolve: { endpoint: null },
        kdenlive: { endpoint: 42 },
        unknown: { endpoint: "x" },
      },
    });
    expect(parsed.editors.resolve).toEqual({ endpoint: null });
    expect(parsed.editors.kdenlive).toBeNull();
    expect(parsed.editors.otio).toBeNull();
  });

  it("returns empty settings when the backend throws", async () => {
    const broken: SettingsBackend = {
      async read() {
        throw new Error("disk gone");
      },
      async write() {
        throw new Error("disk gone");
      },
    };
    await expect(createSettingsStore(broken).load()).resolves.toEqual(
      EMPTY_SETTINGS,
    );
  });
});

describe("web backend", () => {
  it("round-trips through a Storage", async () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
    };
    const store = createSettingsStore(createWebBackend(storage));
    await store.saveKey("openai", "sk-oai");
    await expect(store.load()).resolves.toMatchObject({
      keys: { openai: "sk-oai" },
    });
  });
});
