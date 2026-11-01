import { ArrowRightIcon, SparklesIcon, VolumeXIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ChangesetItem } from "@chair/timeline-ir";
import { cn } from "@/lib/utils";

/** Safe readers over the free-form patch blob. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One human sentence saying what this proposed edit would change.
 * Pure, so the copy stays honest without rendering the app.
 */
export function diffSummary(item: ChangesetItem): string {
  const patch = item.patch ?? {};
  const target = item.targetId;
  switch (item.op) {
    case "add_marker": {
      const name = str(obj(patch.marker)?.name);
      return name ? `Adds marker “${name}”.` : "Adds a marker.";
    }
    case "remove_marker": {
      const name = str(obj(patch.marker)?.name) ?? target;
      return name ? `Removes marker “${name}”.` : "Removes a marker.";
    }
    case "trim": {
      const edge = str(patch.edge) ?? "head";
      const frames = num(patch.frames);
      if (frames == null) {
        return target ? `Trims the ${edge} of ${target}.` : `Trims the ${edge} of a clip.`;
      }
      return target
        ? `Trims ${frames} frames off the ${edge} of ${target}.`
        : `Trims ${frames} frames off the ${edge}.`;
    }
    case "add_clip": {
      const clipId = str(patch.clipId);
      if (clipId && target) return `Adds clip ${clipId} to ${target}.`;
      if (clipId) return `Adds clip ${clipId}.`;
      if (target) return `Adds a clip to ${target}.`;
      return "Adds a clip.";
    }
    case "remove_clip":
      return target ? `Removes ${target}.` : "Removes a clip.";
    case "ripple":
      return target
        ? `Ripples ${target} to close the gap.`
        : "Ripples the timeline to close a gap.";
    case "move":
      return target ? `Moves ${target} to its new position.` : "Moves a clip to a new position.";
    case "set_speed": {
      const speed = num(patch.speed);
      if (speed != null && target) return `Sets ${target} to ${speed}× speed.`;
      if (speed != null) return `Sets playback speed to ${speed}×.`;
      if (target) return `Changes playback speed of ${target}.`;
      return "Changes playback speed.";
    }
    case "add_transition":
      return target ? `Adds a transition to ${target}.` : "Adds a transition.";
    case "remove_transition":
      return target ? `Removes the transition from ${target}.` : "Removes a transition.";
    case "add_effect": {
      const preset = str(patch.presetName);
      if (preset && target) return `Adds the ${preset} effect to ${target}.`;
      if (preset) return `Adds the ${preset} effect.`;
      if (target) return `Adds an effect to ${target}.`;
      return "Adds an effect.";
    }
    case "remove_effect": {
      const preset = str(patch.presetName) ?? str(obj(patch.effect)?.presetName);
      const effectId = str(patch.effectId) ?? str(obj(patch.effect)?.id);
      if (preset && target) return `Removes the ${preset} effect from ${target}.`;
      if (effectId && target) return `Removes effect ${effectId} from ${target}.`;
      if (target) return `Removes an effect from ${target}.`;
      return "Removes an effect.";
    }
    case "add_track":
      return target ? `Adds track ${target}.` : "Adds a track.";
    case "remove_track":
      return target ? `Removes track ${target}.` : "Removes a track.";
    case "set_gain": {
      const db = num(patch.gainDb) ?? num(patch.db);
      if (db != null && target) return `Sets ${target} gain to ${db} dB.`;
      if (db != null) return `Sets gain to ${db} dB.`;
      if (target) return `Adjusts gain on ${target}.`;
      return "Adjusts gain.";
    }
    case "mute_clip":
      return target ? `Mutes ${target}.` : "Mutes a clip.";
  }
}

const BAR = "h-7 rounded-md";

/** One clip block: neutral when unchanged, lime when it is the change. */
function ClipBar({ tone = "base", className }: { tone?: "base" | "new"; className?: string }) {
  return (
    <div
      className={cn(BAR, "min-w-0 flex-1", tone === "new" ? "bg-lime-300" : "bg-[#3d3d3d]", className)}
    />
  );
}

/** An empty slot on the track: dashed, nothing there. */
function EmptySlot({ className }: { className?: string }) {
  return (
    <div
      className={cn(BAR, "min-w-0 flex-1 border border-dashed border-neutral-600", className)}
    />
  );
}

/** A timeline ruler, with a lime pin when the marker lands. */
function Ruler({ pin = false }: { pin?: boolean }) {
  return (
    <div className="relative h-8 w-full">
      <div className="absolute inset-x-1 bottom-2 flex h-3 items-end justify-between">
        {Array.from({ length: 9 }).map((_, index) => (
          <span
            key={index}
            className="w-px bg-neutral-600"
            style={{ height: index % 4 === 0 ? 12 : 7 }}
          />
        ))}
      </div>
      <div className="absolute inset-x-1 bottom-2 h-px bg-neutral-600" />
      {pin ? (
        <div className="absolute bottom-5 left-1/2 size-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-lime-300" />
      ) : null}
    </div>
  );
}

/** The frames a trim cuts away: hatched, on their way out. */
function TrimHatch() {
  return (
    <div
      className={cn(BAR, "w-1/4 shrink-0 bg-neutral-800")}
      style={{
        backgroundImage: "repeating-linear-gradient(45deg, #525252 0 2px, transparent 2px 6px)", // taste-skill-ignore: diagonal hatch marks the cut frames.
      }}
    />
  );
}

/** A few waveform bars, neutral or lime. */
function Wave({ tone = "base", scale = 1 }: { tone?: "base" | "new"; scale?: number }) {
  const peaks = [10, 18, 13, 22, 15, 20, 11];
  return (
    <div className="flex h-8 items-center gap-[3px]">
      {peaks.map((peak, index) => (
        <span
          key={index}
          className={cn("w-1 rounded-full", tone === "new" ? "bg-lime-300" : "bg-neutral-500")}
          style={{ height: Math.min(28, Math.max(4, Math.round(peak * scale))) }}
        />
      ))}
    </div>
  );
}

/** Track rows, the last one lime when it is the new track. */
function TrackStack({ rows, newLast = false }: { rows: number; newLast?: boolean }) {
  return (
    <div className="flex w-full flex-col gap-1">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className={cn(
            "h-2.5 rounded-sm",
            newLast && index === rows - 1 ? "bg-lime-300/90" : "bg-neutral-600",
          )}
        />
      ))}
    </div>
  );
}

/** Two clips joined by the lime transition diamond. */
function TransitionClips() {
  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1">
      <ClipBar />
      <ClipBar />
      <div className="absolute left-1/2 size-4 -translate-x-1/2 rotate-45 rounded-[3px] bg-lime-300" />
    </div>
  );
}

/** A clip carrying its effect pill. */
function EffectClip({ preset }: { preset?: string }) {
  return (
    <div className="relative min-w-0 flex-1">
      <ClipBar className="w-full" />
      <span className="absolute top-1/2 right-1 flex max-w-full -translate-y-1/2 items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-lime-200 ring-1 ring-lime-300/40">
        <SparklesIcon className="size-3 shrink-0" />
        <span className="truncate">{preset ?? "Effect"}</span>
      </span>
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-16 items-center justify-center gap-1 overflow-hidden rounded-xl bg-black/30 px-3 ring-1 ring-white/[0.06]">
      {children}
    </div>
  );
}

/** The before/after pair for one op kind. Lime marks what is new. */
function panelsForOp(item: ChangesetItem): { before: ReactNode; after: ReactNode } {
  const patch = item.patch ?? {};
  switch (item.op) {
    case "add_marker":
      return { before: <Ruler />, after: <Ruler pin /> };
    case "remove_marker":
      return { before: <Ruler pin />, after: <Ruler /> };
    case "trim": {
      const tail = str(patch.edge) === "tail";
      const kept = <ClipBar className="flex-1" />;
      return tail
        ? { before: <>{kept}<TrimHatch /></>, after: <>{kept}<EmptySlot className="w-1/4 flex-none" /></> }
        : { before: <><TrimHatch />{kept}</>, after: <><EmptySlot className="w-1/4 flex-none" />{kept}</> };
    }
    case "add_clip":
      return { before: <EmptySlot />, after: <ClipBar tone="new" /> };
    case "remove_clip":
      return { before: <ClipBar />, after: <EmptySlot /> };
    case "ripple":
      return {
        before: <><ClipBar /><div className="w-3 shrink-0" /><ClipBar /></>,
        after: <><ClipBar /><ClipBar tone="new" /></>,
      };
    case "move":
      return {
        before: <><ClipBar /><EmptySlot /></>,
        after: <><EmptySlot /><ClipBar tone="new" /></>,
      };
    case "set_speed": {
      const speed = num(patch.speed);
      const label = speed != null ? `${speed}×` : "?×";
      const faster = speed == null || speed >= 1;
      return {
        before: (
          <div className={cn(BAR, "flex flex-1 items-center justify-center bg-[#3d3d3d]")}>
            <span className="text-[11px] font-medium text-neutral-300">1×</span>
          </div>
        ),
        after: (
          <div
            className={cn(
              BAR,
              "flex items-center justify-center bg-[#3d3d3d]",
              faster ? "w-2/3" : "flex-1",
            )}
          >
            <span className="text-[11px] font-medium text-lime-200">{label}</span>
          </div>
        ),
      };
    }
    case "add_transition":
      return {
        before: <><ClipBar /><ClipBar /></>,
        after: <TransitionClips />,
      };
    case "remove_transition":
      return {
        before: <TransitionClips />,
        after: <><ClipBar /><ClipBar /></>,
      };
    case "add_effect": {
      const preset = str(patch.presetName);
      return { before: <ClipBar />, after: <EffectClip preset={preset} /> };
    }
    case "remove_effect": {
      const preset = str(patch.presetName) ?? str(obj(patch.effect)?.presetName);
      return { before: <EffectClip preset={preset} />, after: <ClipBar /> };
    }
    case "add_track":
      return { before: <TrackStack rows={2} />, after: <TrackStack rows={3} newLast /> };
    case "remove_track":
      return { before: <TrackStack rows={3} />, after: <TrackStack rows={2} /> };
    case "set_gain": {
      const db = num(patch.gainDb) ?? num(patch.db) ?? 0;
      return { before: <Wave />, after: <Wave tone="new" scale={db >= 0 ? 1.35 : 0.6} /> };
    }
    case "mute_clip":
      return {
        before: <Wave />,
        after: (
          <>
            <div className="h-0.5 w-16 rounded bg-neutral-600" />
            <VolumeXIcon className="size-3.5 shrink-0 text-neutral-400" />
          </>
        ),
      };
  }
}

/**
 * What one proposed edit would change: one sentence plus a small
 * before/after graphic. Lime marks what is new; the sentence carries
 * the meaning, so the graphic stays out of the accessible tree.
 */
export function OpDiff({ item }: { item: ChangesetItem }) {
  const { before, after } = panelsForOp(item);
  return (
    <div>
      <p className="text-[13px] leading-5 text-neutral-200">{diffSummary(item)}</p>
      <div
        aria-hidden="true"
        className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-x-2 gap-y-1"
      >
        <Panel>{before}</Panel>
        <ArrowRightIcon className="size-4 shrink-0 text-neutral-600" />
        <Panel>{after}</Panel>
        <p className="text-[11px] leading-4 text-neutral-500">Before</p>
        <span />
        <p className="text-[11px] leading-4 text-neutral-500">After</p>
      </div>
    </div>
  );
}
