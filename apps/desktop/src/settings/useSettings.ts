import { useCallback, useEffect, useMemo, useState } from "react";
import { createServicesClient } from "@/lib/services/client";
import type { EditorId } from "../home/data";
import type { ProviderId, RoleId } from "./providers";
import {
  getDefaultSettingsStore,
  EMPTY_SETTINGS,
  type AppSettings,
  type EditorConnection,
  type RoleChoice,
  type SettingsStore,
} from "./settings-store";

export type UseSettings = {
  settings: AppSettings;
  loaded: boolean;
  saveKey: (provider: ProviderId, key: string | null) => Promise<void>;
  saveModel: (role: RoleId, choice: RoleChoice | null) => Promise<void>;
  saveProviderEnabled: (provider: ProviderId, enabled: boolean) => Promise<void>;
  saveCustomModels: (provider: ProviderId, models: string[]) => Promise<void>;
  saveModelEnabled: (
    provider: ProviderId,
    model: string,
    enabled: boolean,
  ) => Promise<void>;
  saveOrchestrator: (name: string | null) => Promise<void>;
  saveApplyMode: (mode: "auto" | "ask") => Promise<void>;
  saveEditorConnection: (
    id: EditorId,
    connection: EditorConnection | null,
  ) => Promise<void>;
};

/**
 * App settings from outside the project tree (Tauri store in the
 * window, localStorage in a plain browser). Loads on mount and listens
 * for updates across open composers.
 */
export function useSettings(store?: SettingsStore): UseSettings {
  const resolved = useMemo(
    () => store ?? getDefaultSettingsStore(),
    [store],
  );
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void resolved.load().then((next) => {
      if (!live) return;
      setSettings(next);
      setLoaded(true);
    });
    const unsubscribe = resolved.subscribe?.((next) => {
      if (!live) return;
      setSettings(next);
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [resolved]);

  const saveKey = useCallback(
    async (provider: ProviderId, key: string | null) => {
      const next = await resolved.saveKey(provider, key);
      setSettings(next);
      void createServicesClient().setAgentKeys({ [provider]: key }).catch(() => {});
    },
    [resolved],
  );
  const saveModel = useCallback(
    async (role: RoleId, choice: RoleChoice | null) => {
      setSettings(await resolved.saveModel(role, choice));
    },
    [resolved],
  );
  const saveProviderEnabled = useCallback(
    async (provider: ProviderId, enabled: boolean) => {
      setSettings(await resolved.saveProviderEnabled(provider, enabled));
    },
    [resolved],
  );
  const saveCustomModels = useCallback(
    async (provider: ProviderId, models: string[]) => {
      setSettings(await resolved.saveCustomModels(provider, models));
    },
    [resolved],
  );
  const saveModelEnabled = useCallback(
    async (provider: ProviderId, model: string, enabled: boolean) => {
      setSettings(await resolved.saveModelEnabled(provider, model, enabled));
    },
    [resolved],
  );

  const saveOrchestrator = useCallback(
    async (name: string | null) => {
      setSettings(await resolved.saveOrchestrator(name));
    },
    [resolved],
  );

  const saveApplyMode = useCallback(
    async (mode: "auto" | "ask") => {
      setSettings(await resolved.saveApplyMode(mode));
    },
    [resolved],
  );

  const saveEditorConnection = useCallback(
    async (id: EditorId, connection: EditorConnection | null) => {
      setSettings(await resolved.saveEditorConnection(id, connection));
    },
    [resolved],
  );

  return useMemo(
    () => ({
      settings,
      loaded,
      saveKey,
      saveModel,
      saveProviderEnabled,
      saveCustomModels,
      saveModelEnabled,
      saveOrchestrator,
      saveApplyMode,
      saveEditorConnection,
    }),
    [
      settings,
      loaded,
      saveKey,
      saveModel,
      saveProviderEnabled,
      saveCustomModels,
      saveModelEnabled,
      saveOrchestrator,
      saveApplyMode,
      saveEditorConnection,
    ],
  );
}
