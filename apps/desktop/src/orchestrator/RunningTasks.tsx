import { useEffect, useRef } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Loader2, Redo2, RotateCcw, Square, Undo2 } from "lucide-react";
import { DitherShader } from "@/lib/dither";
import type { DitherColor } from "@/lib/dither";
import { Button } from "@/components/ui/button";
import { DitherArt } from "@/components/dither-art";
import { InfoHint } from "@/components/info-hint";
import { Empty, EmptyArt } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { historyForTask, type HistoryEntry } from "../project/store";
import { activityForTask } from "./TaskActivity";
import { createServicesClient } from "@/lib/services/client";
import type { AgentJobStatus } from "@/lib/services/types";
import { landedFor, stopLiveTask } from "./taskThread";

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

/** True when the row failed: a failed job, or a "Failed: …" status line. */
export function isFailedTask(task: RunningTask): boolean {
  if (task.jobStatus === "failed") return true;
  return task.status.trim().toLowerCase().startsWith("failed:");
}

/** True when Stop can cancel the row: live rows only while queued, jobless rows while non-terminal. */
export function canStopTask(task: RunningTask): boolean {
  if (isFailedTask(task)) return false;
  // The agent only cancels queued jobs; a working job's Stop would just 409.
  if (task.jobStatus !== undefined) return task.jobStatus === "queued";
  return Boolean(task.status) && !NON_STOPPABLE_STATUSES.has(task.status.trim().toLowerCase());
}

/**
 * The row's status line: the raw agent address reads as "Agent offline",
 * with the full line in the tooltip. Anything else shows verbatim.
 */
export function displayStatusFor(task: RunningTask): { short: string; detail: string | null } {
  if (/agent is unreachable at \S+/i.test(task.status)) {
    return { short: task.status.replace(/agent is unreachable at \S+/i, "Agent offline"), detail: task.status };
  }
  const landed = landedFor(task.id);
  if (landed?.detail) return { short: task.status, detail: landed.detail };
  return { short: task.status, detail: null };
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
  /** Retry a failed row: resubmit the turn, or re-fire a failed write. */
  onRetry?: (task: RunningTask) => void;
  /** Undo a landed Resolve write: the original is current again. */
  onUndoResolve?: (task: RunningTask) => void;
  /** Redo an undone write: the stored apply goes again as a new copy. */
  onRedoResolve?: (task: RunningTask) => void;
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
  colour: "#c084fc", // taste-skill-ignore: lane-identity coding shared with the dither ink; the lanes predate this round.
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
  bright,
  history,
  onOpen,
  onUndo,
  onStop,
  onRetry,
  onUndoResolve,
  onRedoResolve,
}: {
  task: RunningTask;
  seed: number;
  frozen: boolean;
  /** Only the first active row carries the bright dither; all others stay calm. */
  bright: boolean;
  history: readonly HistoryEntry[];
  onOpen: () => void;
  onUndo?: () => void;
  onStop?: () => void;
  onRetry?: () => void;
  onUndoResolve?: () => void;
  onRedoResolve?: () => void;
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
  const failed = isFailedTask(task);
  const landed = landedFor(task.id);
  const status = displayStatusFor({ ...task, status: liveStep?.label ?? task.status });
  const rowActionClass =
    "bg-card text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-neutral-100 focus-visible:opacity-100 @max-[760px]:opacity-100";

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
      className="dark group relative cursor-pointer rounded-card bg-card data-[dragging]:opacity-64"
    >
      {bright ? (
        <DitherShader
          field={TASK_FIELD}
          palette={["transparent", LANE_INK[task.lane]]}
          uniforms={{ taskSeed: seed }}
          speed={0.5}
          animate={!frozen}
          suspended={frozen}
          stillTime={1.6}
          cell={3}
          className="absolute inset-0 overflow-hidden rounded-card"
          style={{
            maskImage:
              "linear-gradient(to bottom, transparent, #000 14px, #000 calc(100% - 14px), transparent), linear-gradient(to right, transparent 66%, #000 84%)", // taste-skill-ignore: mask confines the dither sea to the row's right edge, not a fill.
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent, #000 14px, #000 calc(100% - 14px), transparent), linear-gradient(to right, transparent 66%, #000 84%)", // taste-skill-ignore: mask confines the dither sea to the row's right edge, not a fill.
            maskComposite: "intersect",
            WebkitMaskComposite: "source-in",
          }}
        />
      ) : null}
      {bright ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(to right, var(--card) 0%, var(--card) 66%, transparent 84%)", // taste-skill-ignore: neutral scrim keeps the task titles legible over the dither sea.
          }}
        />
      ) : null}
      <div className="relative flex flex-col gap-2.5 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className={cn("min-w-0 flex-1", bright && "max-w-[64%]")}>
            <p className="truncate text-title font-medium text-neutral-100">
              {task.name}
            </p>
            <p className="truncate text-meta text-muted-foreground" title={status.detail ?? undefined}>
              {LANE_LABEL[task.lane]} · {status.short}
              {landed && landed.skipped.length > 0 ? (
                <>
                  {" "}
                  <InfoHint>
                    {landed.skipped.length === 1 ? (
                      landed.skipped[0]!.reason
                    ) : (
                      <span>
                        {landed.skipped.map((skip) => (
                          <span key={skip.intent} className="block">
                            {skip.reason}
                          </span>
                        ))}
                      </span>
                    )}
                  </InfoHint>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {failed && onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Retry ${task.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRetry();
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className={rowActionClass}
              >
                <RotateCcw />
                Retry
              </Button>
            ) : null}
            {!failed && landed?.state === "landed" && landed.undo && onUndoResolve ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Undo Resolve write for ${task.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onUndoResolve();
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className={rowActionClass}
              >
                <Undo2 />
                Undo
              </Button>
            ) : null}
            {!failed && landed?.state === "undone" && landed.redo && onRedoResolve ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Redo Resolve write for ${task.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRedoResolve();
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className={rowActionClass}
              >
                <Redo2 />
                Redo
              </Button>
            ) : null}
            {!failed && !landed && canStopTask(task) ? (
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
                className={rowActionClass}
              >
                <Square />
                Stop task
              </Button>
            ) : null}
            {onUndo && undoable && !landed ? (
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
                className={rowActionClass}
              >
                <Undo2 />
                Undo
              </Button>
            ) : null}
            {!failed && !landed ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-neutral-400" />
            ) : null}
          </div>
        </div>
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
  onRetry,
  onUndoResolve,
  onRedoResolve,
}: RunningTasksProps) {
  if (tasks.length === 0) {
    return (
      <div className={cn("rounded-card bg-card p-5 text-neutral-100", className)}>
        <Empty className="gap-4 py-6">
          <EmptyArt>
            <DitherArt seed={2} />
          </EmptyArt>
          <p className="text-sm text-muted-foreground">Nothing running</p>
        </Empty>
      </div>
    );
  }
  // Visual only: the first active row carries the one bright dither.
  // Finished rows (landed or failed) and every later row stay calm.
  const brightId = tasks.find(
    (task) => !isFailedTask(task) && landedFor(task.id) === undefined,
  )?.id;
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          seed={index + 1}
          frozen={frozen}
          bright={task.id === brightId}
          history={history}
          onOpen={() => onOpen?.(task)}
          onUndo={onUndo ? () => onUndo(task) : undefined}
          onStop={() => {
            onStop?.(task);
            void stopLiveTask(createServicesClient(), task).catch(() => {});
          }}
          onRetry={onRetry ? () => onRetry(task) : undefined}
          onUndoResolve={onUndoResolve ? () => onUndoResolve(task) : undefined}
          onRedoResolve={onRedoResolve ? () => onRedoResolve(task) : undefined}
        />
      ))}
    </div>
  );
}
