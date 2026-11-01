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

  it("saves the orchestrator pick", async () => {
    const store = createSettingsStore(memoryBackend());
    const next = await store.saveOrchestrator("Chair fast");
    expect(next.orchestrator).toBe("Chair fast");
    await expect(store.load()).resolves.toEqual(next);
    await expect(store.saveOrchestrator("")).resolves.toMatchObject({
      orchestrator: null,
    });
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
