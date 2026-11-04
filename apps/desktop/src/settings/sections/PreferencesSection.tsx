import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import type { AppSettings } from "../settings-store";

/**
 * App preferences: how agent edits land, plus the service shelf.
 * Apply mode is the visible #112 setting: Auto applies each agent
 * edit on arrival onto a copy (a new timeline, version, or track) and
 * logs it in history; Ask first holds every edit in Review until the
 * person accepts or rejects it. Switching modes never touches history.
 */
export function PreferencesSection({
  applyMode,
  saveApplyMode,
}: {
  applyMode: AppSettings["applyMode"];
  saveApplyMode: (mode: AppSettings["applyMode"]) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-8">
      <section
        aria-label="Apply mode"
        className="flex flex-col gap-2 rounded-[28px] bg-surface p-5 shadow-raised ring-1 ring-white/8"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-neutral-100">Apply mode</h2>
            <p className="mt-1 text-sm leading-6 text-neutral-400">
              {applyMode === "auto"
                ? "Auto: agent edits apply on arrival onto a copy and land in history, undoable with one key."
                : "Ask first: agent edits wait in Review until you accept or reject each one."}
            </p>
          </div>
          <SegmentedControl aria-label="Apply mode">
            <SegmentedControlItem
              data-checked={applyMode === "auto" ? "" : undefined}
              aria-pressed={applyMode === "auto"}
              onClick={() => void saveApplyMode("auto")}
            >
              Auto
            </SegmentedControlItem>
            <SegmentedControlItem
              data-checked={applyMode === "ask" ? "" : undefined}
              aria-pressed={applyMode === "ask"}
              onClick={() => void saveApplyMode("ask")}
            >
              Ask first
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
      </section>
      <div className="rounded-2xl border border-dashed border-white/10 px-5 py-4">
        <p className="text-sm text-neutral-400">
          Service URLs, paths, and device live here — coming in #172.
        </p>
      </div>
    </div>
  );
}
