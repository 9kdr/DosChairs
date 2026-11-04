import { useRef, type Ref } from "react";
import { Check, HistoryIcon, Loader2 } from "lucide-react";
import { DitherShader } from "@/lib/dither";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HistoryActorBadge, HistoryFallbackLine } from "../project/HistoryCard";
import { clockTime, opLabel } from "../project/store";
import type { HistoryEntry } from "../project/store";
import { LANE_INK, TASK_FIELD, type RunningTask } from "./RunningTasks";

export type ActivityState = "done" | "active" | "queued";

export interface ActivityStep {
  id: string;
  label: string;
  state: ActivityState;
}

export interface TaskActivity {
  headline: string;
  progress: number;
  steps: ActivityStep[];
}

const LANE_FLOW: Record<RunningTask["lane"], { done: string; next: string }> = {
  edit: { done: "Parsed the brief", next: "Review the cut" },
  effects: { done: "Located the hook", next: "Grade the highlight pass" },
  colour: { done: "Loaded the reference", next: "Balance the remaining shots" },
};

/**
 * Derives what the task is doing from the task itself: the live status is
 * the active step, bracketed by where its lane started and what comes next.
 * When a live agent exists, this is the seam it feeds — same shape, real
 * states — instead of another bespoke view.
 */
export function activityForTask(task: RunningTask): TaskActivity {
  const flow = LANE_FLOW[task.lane];
  return {
    headline: task.status,
    progress: 1 / 3,
    steps: [
      { id: "done", label: flow.done, state: "done" },
      { id: "active", label: task.status, state: "active" },
      { id: "next", label: flow.next, state: "queued" },
    ],
  };
}

/**
 * Live rail beside the thread: what this task is doing right now, plus what
 * it already landed. The thread feeds the live run; without one the panel
 * falls back to the task's own status. The applied-entries card is the
 * task's undo history: each row rewinds to before it at once.
 */
export function TaskActivityPanel({
  task,
  activity,
  history = [],
  onUndoEntry,
}: {
  task: RunningTask;
  activity?: TaskActivity;
  history?: readonly HistoryEntry[];
  onUndoEntry?: (entry: HistoryEntry) => void;
}) {
  const shown = activity ?? activityForTask(task);
  const scrollRef = useRef<HTMLElement | null>(null);
  return (
    <aside
      ref={scrollRef as Ref<HTMLElement>}
      aria-label="Task activity"
      className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain lg:flex"
    >
      <SmoothScrollTarget target={scrollRef} lerp={0.075} />
      <div className="flex flex-col gap-3 rounded-card bg-card p-4 text-neutral-100">
        <div className="relative h-28 shrink-0 overflow-hidden rounded-2xl">
          <DitherShader
            field={TASK_FIELD}
            palette={["transparent", LANE_INK[task.lane]]}
            uniforms={{ taskSeed: 7 }}
            speed={0.5}
            stillTime={1.6}
            cell={3}
            className="absolute inset-0 overflow-hidden rounded-2xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: "linear-gradient(to top, var(--card) 0%, var(--card) 45%, transparent 100%)", // taste-skill-ignore: neutral scrim keeps the headline legible over the task art.
            }}
          />
          <p className="absolute inset-x-3 bottom-2 text-xs leading-5 text-neutral-300">
            {shown.headline}
          </p>
        </div>

        <div
          className="h-1 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-valuenow={Math.round(shown.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Task progress"
        >
          <div
            className="h-full rounded-full bg-neutral-200 transition-[width] duration-500"
            style={{ width: `${Math.round(shown.progress * 100)}%` }}
          />
        </div>

        <ol className="flex flex-col gap-2">
          {shown.steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2.5">
              {step.state === "done" ? (
                <Check className="mt-1 size-3.5 shrink-0 text-emerald-400" aria-label="Done" />
              ) : step.state === "active" ? (
                <Loader2
                  className="mt-1 size-3.5 shrink-0 animate-spin text-neutral-300"
                  aria-label="In progress"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={cn("mt-[7px] size-1.5 shrink-0 rounded-full bg-neutral-600")}
                />
              )}
              <span
                className={cn(
                  "min-w-0 text-[13px] leading-5",
                  step.state === "queued" ? "text-muted-foreground" : "text-neutral-200",
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-1 rounded-card bg-card p-4 text-neutral-100">
        <div className="flex items-center gap-2 px-1 pb-1">
          <HistoryIcon className="size-4 text-neutral-400" aria-hidden="true" />
          <h2 className="text-sm font-medium text-neutral-100">Edits</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {history.length === 1 ? "1 entry" : `${history.length} entries`}
          </span>
        </div>
        {history.length === 0 ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            Nothing applied yet.
          </p>
        ) : (
          <ol className="flex min-h-0 flex-col">
            {history.map((entry, index) => (
              <li
                key={entry.itemId}
                className="flex items-start gap-2 border-t border-white/[0.06] px-1 py-2.5 first:border-t-0 first:pt-1 last:pb-1"
              >
                <span className="w-6 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                  #{index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] font-medium text-neutral-100">
                    <span className="truncate">{opLabel(entry.op)}</span>
                    <HistoryActorBadge actor={entry.actor} />
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {clockTime(entry.acceptedAt)}
                  </p>
                  <HistoryFallbackLine entry={entry} />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!onUndoEntry}
                  title={
                    onUndoEntry
                      ? `Rewind to before ${entry.itemId}`
                      : "Undo is unavailable here"
                  }
                  aria-label={`Undo to here: ${opLabel(entry.op)}${entry.targetId ? ` on ${entry.targetId}` : ""}`}
                  onClick={() => onUndoEntry?.(entry)}
                  className="shrink-0"
                >
                  Undo to here
                </Button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
