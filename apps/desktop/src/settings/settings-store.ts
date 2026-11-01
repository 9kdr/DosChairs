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
  models: Record<RoleId, RoleChoice | null>;
  /** The orchestrator pick from the composer input bar. Null keeps Chair. */
  orchestrator: string | null;
  editors: Record<EditorId, EditorConnection | null>;
};

export const EMPTY_SETTINGS: AppSettings = {
  keys: { meta: null, openai: null, anthropic: null },
  models: { planner: null, executor: null, verifier: null },
  orchestrator: null,
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
  const editors = { ...EMPTY_SETTINGS.editors };
  let orchestrator: string | null = null;
  if (!isRecord(doc)) return { keys, models, orchestrator, editors };
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
  if (typeof doc.orchestrator === "string" && doc.orchestrator.length > 0) {
    orchestrator = doc.orchestrator;
  }
  if (isRecord(doc.editors)) {
    for (const [id, value] of Object.entries(doc.editors)) {
      if (isEditorId(id) && (value === null || isEditorConnection(value))) {
        editors[id] = value;
      }
    }
  }
  return { keys, models, orchestrator, editors };
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
  return {
    async load(): Promise<AppSettings> {
      try {
        return parseSettings(await backend.read());
      } catch {
        return { ...EMPTY_SETTINGS, keys: { ...EMPTY_SETTINGS.keys } };
      }
    },
    async saveKey(provider: ProviderId, key: string | null): Promise<AppSettings> {
      const current = await this.load();
      const next: AppSettings = {
        ...current,
        keys: { ...current.keys, [provider]: key && key.length > 0 ? key : null },
      };
      await backend.write(next);
      return next;
    },
    async saveModel(role: RoleId, choice: RoleChoice | null): Promise<AppSettings> {
      const current = await this.load();
      const next: AppSettings = {
        ...current,
        models: { ...current.models, [role]: choice },
      };
      await backend.write(next);
      return next;
    },
    async saveOrchestrator(name: string | null): Promise<AppSettings> {
      const current = await this.load();
      const next: AppSettings = {
        ...current,
        orchestrator: name && name.length > 0 ? name : null,
      };
      await backend.write(next);
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
