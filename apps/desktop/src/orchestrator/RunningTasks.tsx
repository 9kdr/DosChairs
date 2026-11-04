import { useEffect, useRef } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Loader2, Square, Undo2, Waypoints } from "lucide-react";
import { DitherShader } from "@/lib/dither";
import type { DitherColor } from "@/lib/dither";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { historyForTask, type HistoryEntry } from "../project/store";
import { activityForTask } from "./TaskActivity";
import { createServicesClient } from "@/lib/services/client";
import type { AgentJobStatus } from "@/lib/services/types";
import { stopLiveTask } from "./taskThread";

export type TaskLane = "edit" | "effects" | "colour";

/** What the orchestrator planned for a prompted task: the brief plus wanted lanes. */
export type TaskPlan = {
  brief: string;
  /** Lanes the task wants subagents for, primary first. */
  lanes: TaskLane[];
};

/** Proxy media a task's agent turns read. Source footage is never submitted. */
export type TaskMedia = {
  proxyUrl: string;
  baseRevision?: string;
  totalFrames?: number;
};

export interface RunningTask {
  id: string;
  name: string;
  status: string;
  lane: TaskLane;
  /** Setup plan; absent on tasks that predate prompting. */
  plan?: TaskPlan;
  /** Footage for agent turns; absent until the task has media loaded. */
  media?: TaskMedia;
  /** Project this task belongs to, if opened from a project view. */
  projectId?: string;
  /** Live agent job behind this row; absent until the opening turn submits. */
  jobId?: string;
  jobStatus?: AgentJobStatus;
}

const NON_STOPPABLE_STATUSES = new Set([
  "completed",
  "failed",
  "queued",
  "canceled",
  "cancelled",
  "moderated",
]);

/** True when Stop can cancel the row: live rows only while queued, jobless rows while non-terminal. */
export function canStopTask(task: RunningTask): boolean {
  // The agent only cancels queued jobs; a working job's Stop would just 409.
  if (task.jobStatus !== undefined) return task.jobStatus === "queued";
  return Boolean(task.status) && !NON_STOPPABLE_STATUSES.has(task.status.trim().toLowerCase());
}

export interface RunningTasksProps {
  className?: string;
  tasks?: readonly RunningTask[];
  /** Accepted history: gates each row's Undo button. Empty until accepts land. */
  history?: readonly HistoryEntry[];
  /** Hold the dither shaders on their current frame (e.g. mid-morph). */
  frozen?: boolean;
  onOpen?: (task: RunningTask) => void;
  onUndo?: (task: RunningTask) => void;
  onStop?: (task: RunningTask) => void;
}

const LANE_LABEL: Record<TaskLane, string> = {
  edit: "Edit",
  effects: "Pieces",
  colour: "Colour",
};

export const LANE_INK: Record<TaskLane, DitherColor> = {
  edit: "blue",
  effects: "orange",
  colour: "purple",
};

/** Ghost dot per lane, same treatment as the shelf's asset drag. */
const LANE_DOT: Record<TaskLane, string> = {
  edit: "#60a5fa",
  effects: "#fb923c",
  colour: "#c084fc",
};

/**
 * A dither sea on the right, with one-cell streams dripping out of it toward
 * the left. The sea creeps a cell or two and a few dots breathe in and out.
 * `t` is already scaled by `speed`. A gradient over the row covers the titles.
 */
export const TASK_FIELD = `
float field(vec2 uv, vec2 res, float t) {
  float x = uv.x * res.x;
  float row = floor(uv.y * res.y);
  float id = row + taskSeed * 19.0;
  float shore = 0.46 + hash21(vec2(id, 5.5)) * 0.2;
  float shoreX = shore * res.x;
  float drift = sin(t * 0.35 + hash21(vec2(id, 2.2)) * 6.28318) * 1.7;
  float breathe = 0.07 * sin(t * 0.22 + hash21(vec2(id, 8.8)) * 6.28318);\n  float pool = smoothstep(shore - 0.05, shore + 0.18, uv.x);
  float seaGrain = step(0.26 + breathe, hash21(vec2(floor(x + drift), row)));
  float sea = pool * mix(0.42, 0.92, seaGrain);

  float phase = hash21(vec2(id, 1.9));
  float pace = 8.0 + hash21(vec2(id, 3.4)) * 12.0;
  float travel = max(shoreX + 6.0, 8.0);
  float head = shoreX - mod(phase * travel + t * pace, travel);
  float behind = x - head;
  float tail = 12.0 + hash21(vec2(id, 7.2)) * 36.0;
  float trail = step(x, shoreX) * step(0.0, behind) * (1.0 - smoothstep(0.6, tail, behind));
  float headGlow = (1.0 - smoothstep(0.0, 1.1, abs(x - head))) * step(x, shoreX + 1.0);
  float glyph = step(0.4, hash21(vec2(floor(behind), id)));
  float drip = max(headGlow, trail * mix(0.12, 0.88, glyph));

  float right = smoothstep(0.0, 18.0, res.x - x);
  float top = smoothstep(0.0, 6.0, uv.y * res.y);
  float bottom = smoothstep(0.0, 6.0, (1.0 - uv.y) * res.y);

  return clamp(max(sea, drip) * right * top * bottom, 0.0, 0.84);
}
`;

function TaskRow({
  task,
  seed,
  frozen,
  history,
  onOpen,
  onUndo,
  onStop,
}: {
  task: RunningTask;
  seed: number;
  frozen: boolean;
  history: readonly HistoryEntry[];
  onOpen: () => void;
  onUndo?: () => void;
  onStop?: () => void;
}) {
  const isDraggingRef = useRef(false);
  const dragTimeoutRef = useRef<number | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const upPosRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    return () => {
      if (dragTimeoutRef.current !== null) {
        window.clearTimeout(dragTimeoutRef.current);
      }
      dragGhostRef.current?.remove();
      dragGhostRef.current = null;
    };
  }, []);

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    isDraggingRef.current = true;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(
      "application/x-chair-ref",
      JSON.stringify({
        kind: "task",
        id: task.id,
        label: task.name,
      }),
    );
    // Same pill ghost as the shelf's asset drag: lane dot plus label.
    rootRef.current?.setAttribute("data-dragging", "");
    dragGhostRef.current?.remove();
    const ghost = document.createElement("div");
    const mark = document.createElement("span");
    mark.style.cssText = `width:8px;height:8px;border-radius:999px;background:${LANE_DOT[task.lane]};flex:none`;
    const name = document.createElement("span");
    name.textContent = task.name.length > 28 ? `${task.name.slice(0, 18)}…` : task.name;
    name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    ghost.append(mark, name);
    ghost.style.cssText = [
      "position:fixed",
      "top:-1000px",
      "left:0",
      "z-index:80",
      "display:inline-flex",
      "align-items:center",
      "gap:8px",
      "max-width:220px",
      "padding:6px 10px",
      "border-radius:10px",
      "border:1px solid rgb(255 255 255 / 12%)",
      "background:#2a2a2a",
      "color:#f5f5f5",
      "font:500 13px/1.2 ui-sans-serif,system-ui,sans-serif",
      "box-shadow:inset 0 1px 0 rgb(255 255 255 / 10%), 0 10px 24px rgb(0 0 0 / 35%)",
    ].join(";");
    document.body.appendChild(ghost);
    dragGhostRef.current = ghost;
    event.dataTransfer.setDragImage(ghost, 16, 16);
  };

  const handleDragEnd = () => {
    if (dragTimeoutRef.current !== null) {
      window.clearTimeout(dragTimeoutRef.current);
    }
    rootRef.current?.removeAttribute("data-dragging");
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
    dragTimeoutRef.current = window.setTimeout(() => {
      isDraggingRef.current = false;
      dragTimeoutRef.current = null;
    }, 100);
  };

  const handlePointerDown = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    isDraggingRef.current = false;
    startPosRef.current = { x: event.clientX, y: event.clientY };
    upPosRef.current = { x: event.clientX, y: event.clientY };
  };

  const handlePointerUp = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    upPosRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      if (dragTimeoutRef.current !== null) {
        window.clearTimeout(dragTimeoutRef.current);
        dragTimeoutRef.current = null;
      }
      startPosRef.current = null;
      upPosRef.current = null;
      return;
    }

    if (startPosRef.current) {
      const endX =
        event.clientX !== 0 || event.clientY !== 0
          ? event.clientX
          : (upPosRef.current?.x ?? event.clientX);
      const endY =
        event.clientX !== 0 || event.clientY !== 0
          ? event.clientY
          : (upPosRef.current?.y ?? event.clientY);

      const dist = Math.hypot(
        endX - startPosRef.current.x,
        endY - startPosRef.current.y,
      );
      startPosRef.current = null;
      upPosRef.current = null;

      if (dist > 5) {
        return;
      }
    }

    onOpen();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      onOpen();
    }
  };

  // The board row is the task's live line: lane chip, active step, progress.
  const activity = activityForTask(task);
  const liveStep = activity.steps.find((step) => step.state === "active");
  const undoable = historyForTask(history, task.id).length > 0;

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onMouseDown={handlePointerDown}
      onMouseUp={handlePointerUp}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="dark group relative cursor-pointer rounded-2xl bg-[#1a1a1a] data-[dragging]:opacity-64"
    >
      <DitherShader
        field={TASK_FIELD}
        palette={["transparent", LANE_INK[task.lane]]}
        uniforms={{ taskSeed: seed }}
        speed={0.5}
        animate={!frozen}
        suspended={frozen}
        stillTime={1.6}
        cell={3}
        className="absolute inset-0 overflow-hidden rounded-2xl"
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent, #000 14px, #000 calc(100% - 14px), transparent), linear-gradient(to right, #000 calc(100% - 48px), transparent)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent, #000 14px, #000 calc(100% - 14px), transparent), linear-gradient(to right, #000 calc(100% - 48px), transparent)",
          maskComposite: "intersect",
          WebkitMaskComposite: "source-in",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-1/2"
        style={{
          background:
            "linear-gradient(to right, #1a1a1a 0%, #1a1a1a 60%, transparent 100%)",
        }}
      />
      <div className="relative flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium text-neutral-100">
              {task.name}
            </p>
            <p className="truncate text-xs text-neutral-400">
              {liveStep?.label ?? task.status}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canStopTask(task) ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Stop ${task.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onStop?.();
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className="bg-[#1a1a1a] text-neutral-400 opacity-0 ring-1 ring-white/10 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-neutral-100 focus-visible:opacity-100"
              >
                <Square />
                Stop task
              </Button>
            ) : null}
            {onUndo && undoable ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Undo ${task.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onUndo();
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className="bg-[#1a1a1a] text-neutral-400 ring-1 ring-white/10 hover:text-neutral-100"
              >
                <Undo2 />
                Undo
              </Button>
            ) : null}
            <Loader2 className="size-3.5 shrink-0 animate-spin text-neutral-400" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-neutral-200 ring-1 ring-white/10">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ backgroundColor: LANE_DOT[task.lane] }}
            />
            {LANE_LABEL[task.lane]}
          </span>
          <div
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-valuenow={Math.round(activity.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${task.name} progress`}
          >
            <div
              className="h-full rounded-full bg-neutral-200 transition-[width] duration-500"
              style={{ width: `${Math.round(activity.progress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Live agent jobs for this project, one row per task with a running job.
 * Empty until opening turns submit; terminal jobs leave the list.
 */
export function RunningTasks({
  className,
  tasks = [],
  history = [],
  frozen = false,
  onOpen,
  onUndo,
  onStop,
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
        {tasks.map((task, index) => (
          <TaskRow
            key={task.id}
            task={task}
            seed={index + 1}
            frozen={frozen}
            history={history}
            onOpen={() => onOpen?.(task)}
            onUndo={onUndo ? () => onUndo(task) : undefined}
            onStop={() => {
              onStop?.(task);
              void stopLiveTask(createServicesClient(), task).catch(() => {});
            }}
          />
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
