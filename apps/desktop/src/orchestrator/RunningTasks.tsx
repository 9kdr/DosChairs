import { Loader2, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RunningTask {
  id: string;
  name: string;
  status: string;
}

export interface RunningTasksProps {
  className?: string;
  tasks?: readonly RunningTask[];
}

export const STANDIN_TASKS: readonly RunningTask[] = [
  {
    id: "task-1",
    name: "Assemble rough cut",
    status: "Arranging A-roll on V1 timeline",
  },
  {
    id: "task-2",
    name: "Auto-transcribe dialogue",
    status: "Transcribing track A1 (68%)",
  },
  {
    id: "task-3",
    name: "Detect silence & jump cuts",
    status: "Scanning audio pauses",
  },
  {
    id: "task-4",
    name: "Match scene color",
    status: "Balancing shot 04 to reference",
  },
];

/**
 * Stand-in rows for tasks currently running in this project.
 * Not a live agent.
 */
export function RunningTasks({
  className,
  tasks = STANDIN_TASKS,
}: RunningTasksProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-[28px] bg-[#1a1a1a] p-4 text-neutral-100 shadow-raised ring-1 ring-white/8",
        className,
      )}
    >
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <Waypoints className="size-4 text-neutral-400" />
          <h2 className="text-sm font-semibold tracking-wide text-neutral-100">
            Running Tasks
          </h2>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-neutral-400">
          <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
          {tasks.length} active
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="flex items-center justify-between gap-3 rounded-2xl bg-white/[0.03] px-3.5 py-2.5 ring-1 ring-white/[0.06]"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-neutral-100">
                {task.name}
              </p>
              <p className="truncate text-xs text-neutral-400">
                {task.status}
              </p>
            </div>
            <Loader2 className="size-3.5 shrink-0 animate-spin text-neutral-400" />
          </div>
        ))}
        {tasks.length === 0 ? (
          <p className="py-4 text-center text-xs text-neutral-400">
            No running tasks
          </p>
        ) : null}
      </div>
    </div>
  );
}
