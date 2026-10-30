import { Check, Loader2 } from "lucide-react";
import { DitherShader } from "@/lib/dither";
import { cn } from "@/lib/utils";
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

/** Live rail beside the thread: what this task is doing right now. */
export function TaskActivityPanel({ task }: { task: RunningTask }) {
  const activity = activityForTask(task);
  return (
    <aside
      aria-label="Task activity"
      className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto lg:flex"
    >
      <div className="flex flex-col gap-3 rounded-[28px] bg-[#1a1a1a] p-4 text-neutral-100 shadow-raised ring-1 ring-white/8">
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
              background:
                "linear-gradient(to top, #1a1a1a 0%, #1a1a1a 45%, transparent 100%)",
            }}
          />
          <p className="absolute inset-x-3 bottom-2 text-xs leading-5 text-neutral-300">
            {activity.headline}
          </p>
        </div>

        <div
          className="h-1 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-valuenow={Math.round(activity.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Task progress"
        >
          <div
            className="h-full rounded-full bg-neutral-200 transition-[width] duration-500"
            style={{ width: `${Math.round(activity.progress * 100)}%` }}
          />
        </div>

        <ol className="flex flex-col gap-2">
          {activity.steps.map((step) => (
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
                  step.state === "queued" ? "text-neutral-500" : "text-neutral-200",
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
