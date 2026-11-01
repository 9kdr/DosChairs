import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useServiceHealth } from "@/lib/services/useServices";
import type { EditorInfo } from "../home/data";
import { fetchDetectedSnapshot } from "../home/projects";
import { SettingsSidebar } from "./SettingsSidebar";
import type { SectionId } from "./sections";
import { EditorsSection } from "./sections/EditorsSection";
import { KeysSection } from "./sections/KeysSection";
import { PreferencesSection } from "./sections/PreferencesSection";
import { useSettings } from "./useSettings";

type SettingsScreenProps = {
  onBack: () => void;
};

/**
 * Settings shell: header plus a sidebar of sections with one
 * section open at a time. Grid: 208 sidebar + 32 gap + panel in a
 * 896 column (208 + 32 + 656).
 */
export function SettingsScreen({ onBack }: SettingsScreenProps) {
  const {
    settings,
    loaded,
    saveKey,
    saveProviderEnabled,
    saveCustomModels,
    saveEditorConnection,
  } = useSettings();
  const { agent, agentHealth, refresh } = useServiceHealth();
  const [section, setSection] = useState<SectionId>("keys");
  const agentUp =
    agent.phase === "up" ? true : agent.phase === "down" ? false : null;
  const [detected, setDetected] = useState<EditorInfo[] | null>(null);
  const [detectNonce, setDetectNonce] = useState(0);

  useEffect(() => {
    let live = true;
    void fetchDetectedSnapshot()
      .then((snapshot) => {
        if (live) setDetected(snapshot.editors);
      })
      .catch(() => {
        if (live) setDetected(null);
      });
    return () => {
      live = false;
    };
  }, [detectNonce]);

  const refreshAll = () => {
    refresh();
    setDetectNonce((current) => current + 1);
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <header className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back to home"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-neutral-100">Settings</h1>
          <p className="text-sm text-neutral-400">
            Providers, editors, and preferences.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={refreshAll}
          disabled={agent.phase === "checking"}
        >
          <RefreshCwIcon />
          Recheck
        </Button>
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <div className="shrink-0 md:w-52">
          <SettingsSidebar current={section} onSelect={setSection} />
        </div>
        <div className="min-w-0 flex-1">
          {!loaded ? (
            <LoadingBlocks />
          ) : section === "keys" ? (
            <KeysSection
              settings={settings}
              agentUp={agentUp}
              agentHealth={agentHealth}
              saveKey={saveKey}
              saveProviderEnabled={saveProviderEnabled}
              saveCustomModels={saveCustomModels}
            />
          ) : section === "editors" ? (
            <EditorsSection
              connections={settings.editors}
              agentUp={agentUp}
              detected={detected}
              saveConnection={saveEditorConnection}
              refresh={refreshAll}
            />
          ) : (
            <PreferencesSection />
          )}
        </div>
      </div>
    </div>
  );
}

/** Flat bars at the real size while the store loads. No shimmer. */
function LoadingBlocks() {
  return (
    <div aria-label="Loading settings" className="flex flex-col gap-8">
      <div className="h-[92px] rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]" />
      <div className="flex flex-col gap-2">
        <div className="h-4 w-16 rounded bg-white/[0.06]" />
        <div className="h-[132px] rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]" />
        <div className="h-[132px] rounded-2xl bg-white/[0.03] ring-1 ring-white/[0.06]" />
      </div>
    </div>
  );
}
