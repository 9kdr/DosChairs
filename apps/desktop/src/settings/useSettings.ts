import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderId, RoleId } from "./providers";
import {
  createSettingsStore,
  defaultBackend,
  EMPTY_SETTINGS,
  type AppSettings,
  type RoleChoice,
  type SettingsStore,
} from "./settings-store";

export type UseSettings = {
  settings: AppSettings;
  loaded: boolean;
  saveKey: (provider: ProviderId, key: string | null) => Promise<void>;
  saveModel: (role: RoleId, choice: RoleChoice | null) => Promise<void>;
};

/**
 * App settings from outside the project tree (Tauri store in the
 * window, localStorage in a plain browser). Loads once on mount.
 */
export function useSettings(store?: SettingsStore): UseSettings {
  const resolved = useMemo(
    () => store ?? createSettingsStore(defaultBackend()),
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
    return () => {
      live = false;
    };
  }, [resolved]);

  const saveKey = useCallback(
    async (provider: ProviderId, key: string | null) => {
      setSettings(await resolved.saveKey(provider, key));
    },
    [resolved],
  );
  const saveModel = useCallback(
    async (role: RoleId, choice: RoleChoice | null) => {
      setSettings(await resolved.saveModel(role, choice));
    },
    [resolved],
  );

  return useMemo(
    () => ({ settings, loaded, saveKey, saveModel }),
    [settings, loaded, saveKey, saveModel],
  );
}
