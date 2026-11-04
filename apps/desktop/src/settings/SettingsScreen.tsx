import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { useServiceHealth } from "@/lib/services/useServices";
import type { EditorInfo } from "../home/data";
import { fetchDetectedSnapshot } from "../home/projects";
import { SECTIONS, type SectionId } from "./sections";
import { EditorsSection } from "./sections/EditorsSection";
import { KeysSection } from "./sections/KeysSection";
import { PreferencesSection } from "./sections/PreferencesSection";
import { useSettings } from "./useSettings";

type SettingsScreenProps = {
  /**
   * Kept for the home dock caller. Settings is a dock destination —
   * the person goes back via the dock, not a header arrow.
   */
  onBack: () => void;
};

/**
 * Settings shell: a segmented control switching the three sections,
 * with Recheck at the right. No title header — the dock names the
 * destination, and each section keeps only its one-line intro.
 */
export function SettingsScreen(_props: SettingsScreenProps) {
  void _props;
  const {
    settings,
    loaded,
    saveKey,
    saveProviderEnabled,
    saveCustomModels,
    saveModelEnabled,
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
      <div className="flex items-center justify-between gap-3">
        <SegmentedControl aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <SegmentedControlItem
              key={entry.id}
              data-checked={section === entry.id ? "" : undefined}
              aria-pressed={section === entry.id}
              onClick={() => setSection(entry.id)}
            >
              {entry.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
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
            saveModelEnabled={saveModelEnabled}
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
  );
}

/** Flat bars at the real size while the store loads. No shimmer. */
function LoadingBlocks() {
  return (
    <div aria-label="Loading settings" className="flex flex-col gap-8">
      <div className="h-[92px] rounded-card bg-card" />
      <div className="flex flex-col gap-2">
        <div className="h-4 w-16 rounded bg-white/[0.06]" />
        <div className="h-[132px] rounded-card bg-card" />
        <div className="h-[132px] rounded-card bg-card" />
      </div>
    </div>
  );
}
