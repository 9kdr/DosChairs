/**
 * App settings (API keys, model picks) outside the project tree.
 *
 * In the Tauri window the backend is the Tauri store plugin, persisted
 * to a file under the app data dir. In a plain browser (dev server) it
 * falls back to localStorage. Either way nothing touches project files.
 */
import { isProviderId, isRoleId, type ProviderId, type RoleId } from "./providers";
import { isEditorId } from "./editors";
import type { EditorId } from "../home/data";

export type RoleChoice = { provider: ProviderId; model: string };

/** Null endpoint = linked with no path (Resolve finds Studio itself). */
export type EditorConnection = { endpoint: string | null };

export type AppSettings = {
  keys: Record<ProviderId, string | null>;
  /**
   * Legacy per-role routing. The settings UI no longer writes it,
   * but old docs still parse so nothing saved is lost.
   */
  models: Record<RoleId, RoleChoice | null>;
  /** Per-provider on/off from the Providers list. */
  enabled: Record<ProviderId, boolean>;
  /** Model ids the person typed per provider, beyond the known ones. */
  customModels: Record<ProviderId, string[]>;
  /** Model ids switched off per provider — hidden from picker and routing. */
  disabledModels: Record<ProviderId, string[]>;
  /** The orchestrator pick from the composer input bar. Null keeps Chair. */
  orchestrator: string | null;
  /** How agent edits land: applied on arrival (auto) or held for review (ask). */
  applyMode: "auto" | "ask";
  editors: Record<EditorId, EditorConnection | null>;
};

export const EMPTY_SETTINGS: AppSettings = {
  keys: { meta: null, openai: null, anthropic: null },
  models: { planner: null, executor: null, verifier: null },
  enabled: { meta: true, openai: true, anthropic: true },
  customModels: { meta: [], openai: [], anthropic: [] },
  disabledModels: { meta: [], openai: [], anthropic: [] },
  orchestrator: null,
  applyMode: "auto",
  editors: { resolve: null, kdenlive: null, otio: null },
};

export type SettingsBackend = {
  read(): Promise<unknown>;
  write(doc: AppSettings): Promise<void>;
};

const DOC_KEY = "chair.settings.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse a stored doc; anything malformed falls back to empty, per field. */
export function parseSettings(doc: unknown): AppSettings {
  const keys = { ...EMPTY_SETTINGS.keys };
  const models = { ...EMPTY_SETTINGS.models };
  const enabled = { ...EMPTY_SETTINGS.enabled };
  const customModels: Record<ProviderId, string[]> = {
    meta: [],
    openai: [],
    anthropic: [],
  };
  const disabledModels: Record<ProviderId, string[]> = {
    meta: [],
    openai: [],
    anthropic: [],
  };
  const editors = { ...EMPTY_SETTINGS.editors };
  let orchestrator: string | null = null;
  let applyMode: "auto" | "ask" = "auto";
  if (!isRecord(doc))
    return {
      keys,
      models,
      enabled,
      customModels,
      disabledModels,
      orchestrator,
      applyMode,
      editors,
    };
  if (isRecord(doc.keys)) {
    for (const [id, value] of Object.entries(doc.keys)) {
      if (isProviderId(id) && (typeof value === "string" || value === null)) {
        keys[id] = value && value.length > 0 ? value : null;
      }
    }
  }
  if (isRecord(doc.models)) {
    for (const [id, value] of Object.entries(doc.models)) {
      if (
        isRoleId(id) &&
        (value === null || isRoleChoice(value))
      ) {
        models[id] = value;
      }
    }
  }
  if (isRecord(doc.enabled)) {
    for (const [id, value] of Object.entries(doc.enabled)) {
      if (isProviderId(id) && typeof value === "boolean") {
        enabled[id] = value;
      }
    }
  }
  if (isRecord(doc.customModels)) {
    for (const [id, value] of Object.entries(doc.customModels)) {
      if (isProviderId(id) && Array.isArray(value)) {
        customModels[id] = value.filter(
          (name): name is string =>
            typeof name === "string" && name.trim().length > 0,
        );
      }
    }
  }
  if (isRecord(doc.disabledModels)) {
    for (const [id, value] of Object.entries(doc.disabledModels)) {
      if (isProviderId(id) && Array.isArray(value)) {
        disabledModels[id] = value.filter(
          (name): name is string =>
            typeof name === "string" && name.trim().length > 0,
        );
      }
    }
  }
  if (typeof doc.orchestrator === "string" && doc.orchestrator.length > 0) {
    orchestrator = doc.orchestrator;
  }
  if (doc.applyMode === "auto" || doc.applyMode === "ask") {
    applyMode = doc.applyMode;
  }
  if (isRecord(doc.editors)) {
    for (const [id, value] of Object.entries(doc.editors)) {
      if (isEditorId(id) && (value === null || isEditorConnection(value))) {
        editors[id] = value;
      }
    }
  }
  return {
    keys,
    models,
    enabled,
    customModels,
    disabledModels,
    orchestrator,
    applyMode,
    editors,
  };
}

function isRoleChoice(value: unknown): value is RoleChoice {
  return (
    isRecord(value) &&
    isProviderId(value.provider) &&
    typeof value.model === "string" &&
    value.model.length > 0
  );
}

function isEditorConnection(value: unknown): value is EditorConnection {
  return (
    isRecord(value) &&
    (typeof value.endpoint === "string" || value.endpoint === null)
  );
}

export function createSettingsStore(backend: SettingsBackend) {
  const listeners = new Set<(settings: AppSettings) => void>();
  function notify(settings: AppSettings) {
    for (const listener of listeners) {
      try {
        listener(settings);
      } catch {
        // ignore listener errors
      }
    }
  }

  return {
    subscribe(listener: (settings: AppSettings) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(): Promise<AppSettings> {
      try {
        return parseSettings(await backend.read());
      } catch {
        return {
          ...EMPTY_SETTINGS,
          keys: { ...EMPTY_SETTINGS.keys },
          models: { ...EMPTY_SETTINGS.models },
          enabled: { ...EMPTY_SETTINGS.enabled },
          applyMode: "auto",
          customModels: {
            meta: [],
            openai: [],
            anthropic: [],
          },
          disabledModels: {
            meta: [],
            openai: [],
            anthropic: [],
          },
          editors: { ...EMPTY_SETTINGS.editors },
        };
      }
    },
    async saveKey(provider: ProviderId, key: string | null): Promise<AppSettings> {
      const current = await this.load();
      const next: AppSettings = {
        ...current,
        keys: { ...current.keys, [provider]: key && key.length > 0 ? key : null },
      };
      await backend.write(next);
      notify(next);
      return next;
    },
    async saveModel(role: RoleId, choice: RoleChoice | null): Promise<AppSettings> {
      const current = await this.load();
      const next: AppSettings = {
        ...current,
        models: { ...current.models, [role]: choice },
      };
      await backend.write(next);
      notify(next);
      return next;
    },
    async saveProviderEnabled(
      provider: ProviderId,
      enabled: boolean,
    ): Promise<AppSettings> {
      const current = await this.load();
      const next: AppSettings = {
        ...current,
        enabled: { ...current.enabled, [provider]: enabled },
      };
      await backend.write(next);
      notify(next);
      return next;
    },
    async saveCustomModels(
      provider: ProviderId,
      models: string[],
    ): Promise<AppSettings> {
      const current = await this.load();
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const name of models) {
        const trimmed = name.trim();
        if (trimmed === "" || seen.has(trimmed)) continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
      }
      const next: AppSettings = {
        ...current,
        customModels: { ...current.customModels, [provider]: cleaned },
      };
      await backend.write(next);
      notify(next);
      return next;
    },
    async saveModelEnabled(
      provider: ProviderId,
      model: string,
      enabled: boolean,
    ): Promise<AppSettings> {
      const current = await this.load();
      const name = model.trim();
      const prev = current.disabledModels[provider];
      const nextList = enabled
        ? prev.filter((entry) => entry !== name && entry !== model)
        : prev.includes(model) || (name !== "" && prev.includes(name))
          ? prev
          : name === ""
            ? prev
            : [...prev, name];
      const next: AppSettings = {
        ...current,
        disabledModels: { ...current.disabledModels, [provider]: nextList },
      };
      await backend.write(next);
      notify(next);
      return next;
    },
    async saveOrchestrator(name: string | null): Promise<AppSettings> {
      const current = await this.load();
      const next: AppSettings = {
        ...current,
        orchestrator: name && name.length > 0 ? name : null,
      };
      await backend.write(next);
      notify(next);
      return next;
    },
    async saveApplyMode(mode: "auto" | "ask"): Promise<AppSettings> {
      const current = await this.load();
      const next: AppSettings = { ...current, applyMode: mode };
      await backend.write(next);
      notify(next);
      return next;
    },
    async saveEditorConnection(
      id: EditorId,
      connection: EditorConnection | null,
    ): Promise<AppSettings> {
      const current = await this.load();
      let nextConnection = connection;
      if (nextConnection != null) {
        const endpoint = nextConnection.endpoint?.trim() ?? null;
        nextConnection = {
          endpoint: endpoint != null && endpoint.length > 0 ? endpoint : null,
        };
      }
      const next: AppSettings = {
        ...current,
        editors: { ...current.editors, [id]: nextConnection },
      };
      await backend.write(next);
      notify(next);
      return next;
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

/** localStorage backend: the plain-browser fallback. Never the default. */
export function createWebBackend(storage: Pick<Storage, "getItem" | "setItem">): SettingsBackend {
  return {
    async read(): Promise<unknown> {
      const raw = storage.getItem(DOC_KEY);
      if (raw == null) return null;
      return JSON.parse(raw) as unknown;
    },
    async write(doc: AppSettings): Promise<void> {
      storage.setItem(DOC_KEY, JSON.stringify(doc));
    },
  };
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type StoreLike = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

/** Tauri store backend, loaded lazily so a plain browser never imports it. */
export function createTauriBackend(): SettingsBackend {
  let cached: Promise<StoreLike> | null = null;
  const loadStore = (): Promise<StoreLike> => {
    cached ??= import("@tauri-apps/plugin-store").then(async (plugin) => {
      const store = await plugin.Store.load("settings.json");
      return store as unknown as StoreLike;
    });
    return cached;
  };
  return {
    async read(): Promise<unknown> {
      return (await loadStore()).get(DOC_KEY);
    },
    async write(doc: AppSettings): Promise<void> {
      const store = await loadStore();
      await store.set(DOC_KEY, doc);
      await store.save();
    },
  };
}

/** Tauri store in the window, localStorage in a plain browser. */
export function defaultBackend(): SettingsBackend {
  if (isTauri()) return createTauriBackend();
  return createWebBackend(localStorage);
}

let defaultStoreInstance: SettingsStore | null = null;

/** Shared settings store across open composers and settings screens. */
export function getDefaultSettingsStore(): SettingsStore {
  if (!defaultStoreInstance) {
    defaultStoreInstance = createSettingsStore(defaultBackend());
  }
  return defaultStoreInstance;
}

