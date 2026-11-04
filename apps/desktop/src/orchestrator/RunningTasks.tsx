import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import {
  ArrowUpRight,
  Check,
  HistoryIcon,
  Loader2,
  Redo2,
  RotateCcw,
  Square,
  Undo2,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DitherShader } from "@/lib/dither";
import type { DitherColor } from "@/lib/dither";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/info-hint";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { clockTime, historyForTask, opLabel, type HistoryEntry } from "../project/store";
import { activityForTask } from "./TaskActivity";
import type { Suggestion } from "./suggestions";
import { createServicesClient } from "@/lib/services/client";
import type { AgentJobStatus } from "@/lib/services/types";
import {
  headerStatusFor,
  isTaskSeen,
  landedFor,
  liveSubmitError,
  markTaskSeen,
  stopLiveTask,
} from "./taskThread";

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
  /** When the task started, as a unix-millis stamp. Absent on older tasks. */
  startedAt?: number;
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
    return {
      short: task.status.replace(/agent is unreachable at \S+/i, "Agent offline"),
      detail: task.status,
    };
  }
  const landed = landedFor(task.id);
  if (landed?.detail) return { short: task.status, detail: landed.detail };
  return { short: task.status, detail: null };
}

/** Status lines that say nothing: the tile shows a quiet spinner instead. */
const QUIET_STATUS = new Set([
  "the agent is working",
  "waiting for the agent",
  "queued on the agent",
  "agent working",
  "running",
  "starting the turn…",
  "starting the turn...",
  "working…",
]);

/** The tile's current step: the live line, unless it is machinery. */
export function stepTextFor(task: RunningTask): string | null {
  const activity = activityForTask(task);
  const live = activity.steps.find((step) => step.state === "active")?.label ?? task.status;
  const short = displayStatusFor({ ...task, status: live }).short;
  return QUIET_STATUS.has(short.trim().toLowerCase()) ? null : short;
}

export interface RunningTasksProps {
  className?: string;
  /** Working tasks: running, waiting, or queued. The board sorts oldest first. */
  tasks?: readonly RunningTask[];
  /** Finished tasks, oldest first. The board shows the newest five. */
  recentTasks?: readonly RunningTask[];
  /** Accepted history: gates each tile's Undo button. Empty until accepts land. */
  history?: readonly HistoryEntry[];
  /** Real next steps for the empty card; renders nothing when empty. */
  suggestions?: readonly Suggestion[];
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
  /** Open the full History page, from the Recent group's link. */
  onOpenHistory?: () => void;
  /** A suggestion chip was picked: retry its task, or fill the bar. */
  onSuggest?: (suggestion: Suggestion) => void;
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

function TaskTile({
  task,
  seed,
  frozen,
  finished,
  expanded,
  history,
  onToggle,
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
  /** Finished tiles (Recent) never dither; only working tiles do. */
  finished: boolean;
  expanded: boolean;
  history: readonly HistoryEntry[];
  onToggle: () => void;
  onOpen: () => void;
  onUndo?: () => void;
  onStop?: () => void;
  onRetry?: () => void;
  onUndoResolve?: () => void;
  onRedoResolve?: () => void;
}) {
  const reduce = useReducedMotion();
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

  const handlePointerDown = (event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    isDraggingRef.current = false;
    startPosRef.current = { x: event.clientX, y: event.clientY };
    upPosRef.current = { x: event.clientX, y: event.clientY };
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    upPosRef.current = { x: event.clientX, y: event.clientY };
  };

  const toggle = () => {
    if (finished) markTaskSeen(task.projectId, task.id);
    onToggle();
  };

  const open = () => {
    if (finished) markTaskSeen(task.projectId, task.id);
    onOpen();
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

      const dist = Math.hypot(endX - startPosRef.current.x, endY - startPosRef.current.y);
      startPosRef.current = null;
      upPosRef.current = null;

      if (dist > 5) {
        return;
      }
    }

    toggle();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      toggle();
    }
  };

  const failed = isFailedTask(task);
  const landed = landedFor(task.id);
  const step = stepTextFor(task);
  const detail = displayStatusFor(task).detail;
  // The tile reads the same status as the thread header, so the card and
  // the header agree: Landed/Undone, Failed/Stopped, Planned, or the live
  // step (null reads as the quiet spinner).
  const status = headerStatusFor({
    terminal: task.jobStatus ?? null,
    landed: landed?.state ?? null,
    step,
    live: true,
    fallback: task.status,
  });
  const entries = historyForTask(history, task.id);
  const undoable = entries.length > 0;
  // Retry only where it can do something: a turn that never sent, or a
  // write that failed. A finished agent turn never resubmits.
  const retryable = liveSubmitError(task.id) !== undefined || landed?.state === "failed";
  const showDither = !finished && !failed;
  const seen = finished && isTaskSeen(task.projectId, task.id);
  const activity = activityForTask(task);
  // Finished tiles show the flow steps as done; the outcome already sits in
  // the meta line (and the landed line below), so the live step drops out
  // instead of repeating it.
  const steps = finished
    ? activity.steps
        .filter((item) => item.state !== "active")
        .map((item) => ({ ...item, state: "done" as const }))
    : activity.steps;
  const outcome = failed ? "Failed" : (status ?? "Done");
  const outcomeDot =
    outcome === "Landed"
      ? "bg-emerald-400"
      : outcome === "Failed"
        ? "bg-red-400"
        : outcome === "Undone" || outcome === "Stopped"
          ? "bg-amber-400"
          : "bg-neutral-500";
  const tileActionClass = "text-muted-foreground hover:text-neutral-100";
  const action = (
    label: string,
    Icon: typeof Undo2,
    text: string,
    run: (() => void) | undefined,
  ) => (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        run?.();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={tileActionClass}
    >
      <Icon />
      {text}
    </Button>
  );

  return (
    <motion.div
      layout
      transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
      className="min-w-0"
    >
      <div
        ref={rootRef}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onMouseDown={handlePointerDown}
        onMouseUp={handlePointerUp}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className="dark group relative cursor-pointer overflow-hidden rounded-2xl bg-surface-raised outline-none transition-colors hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-ring data-[dragging]:opacity-64"
      >
        {showDither ? (
          // The dither bleeds in from the right edge and is clipped by the
          // tile's rounded corners. Its left edge fades out, and the text
          // column below keeps clear of it, so it never sits under a title.
          <DitherShader
            field={TASK_FIELD}
            palette={["transparent", LANE_INK[task.lane]]}
            uniforms={{ taskSeed: seed }}
            speed={0.5}
            animate={!frozen && !reduce}
            suspended={frozen || Boolean(reduce)}
            stillTime={1.6}
            cell={3}
            className="pointer-events-none absolute inset-y-0 right-0 w-[40%] max-w-[360px] opacity-45"
            style={{
              maskImage: "linear-gradient(to right, transparent 0%, #000 55%)", // taste-skill-ignore: mask fades the dither's left edge so it bleeds in from the tile's right edge, not a fill.
              WebkitMaskImage: "linear-gradient(to right, transparent 0%, #000 55%)", // taste-skill-ignore: mask fades the dither's left edge so it bleeds in from the tile's right edge, not a fill.
            }}
          />
        ) : null}
        <div className="relative flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className={cn("min-w-0 flex-1", showDither && "pr-6 @max-[620px]:pr-0")}>
              <p className="truncate text-title font-medium text-neutral-100" title={task.name}>
                {task.name}
              </p>
              <p
                className="flex min-w-0 items-center gap-1.5 truncate text-meta text-muted-foreground"
                title={landed?.line ?? detail ?? undefined}
              >
                {finished ? (
                  <span
                    role="img"
                    aria-label={seen ? outcome : `${outcome}, not yet looked at`}
                    className={cn("size-1.5 shrink-0 rounded-full", outcomeDot, seen && "opacity-50")}
                  />
                ) : (
                  <Loader2
                    className="size-3 shrink-0 animate-spin text-neutral-400"
                    aria-label="Working"
                  />
                )}
                <span className={cn("shrink-0", finished && !seen && "text-neutral-200")}>
                  {finished ? outcome : (step ?? "Working")}
                </span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{LANE_LABEL[task.lane]}</span>
                {landed && landed.skipped.length > 0 ? (
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
                ) : null}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {failed && retryable && onRetry
                ? action(`Retry ${task.name}`, RotateCcw, "Retry", onRetry)
                : null}
              {!failed && landed?.state === "landed" && landed.undo && onUndoResolve
                ? action(`Undo Resolve write for ${task.name}`, Undo2, "Undo", onUndoResolve)
                : null}
              {!failed && landed?.state === "undone" && landed.redo && onRedoResolve
                ? action(`Redo Resolve write for ${task.name}`, Redo2, "Redo", onRedoResolve)
                : null}
              {!failed && !landed && task.jobId && canStopTask(task)
                ? action(`Stop ${task.name}`, Square, "Stop", onStop)
                : null}
              {onUndo && undoable && !landed
                ? action(`Undo ${task.name}`, Undo2, "Undo", onUndo)
                : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Open ${task.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        open();
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                      className={cn(tileActionClass, showDither && "bg-black/40 hover:bg-black/55")}
                    />
                  }
                >
                  <ArrowUpRight />
                </TooltipTrigger>
                <TooltipPopup side="top">Open task</TooltipPopup>
              </Tooltip>
            </div>
          </div>
          <AnimatePresence initial={false}>
            {expanded ? (
              <motion.div
                key="detail"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="flex flex-col gap-2 pt-1">
                  <ol className="flex flex-col gap-1.5" aria-label={`${task.name} steps`}>
                    {steps.map((item) => (
                      <li key={item.id} className="flex items-center gap-2">
                        {item.state === "done" ? (
                          <Check className="size-3.5 shrink-0 text-emerald-400" aria-label="Done" />
                        ) : item.state === "active" ? (
                          <Loader2
                            className="size-3.5 shrink-0 animate-spin text-neutral-300"
                            aria-label="In progress"
                          />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="size-1.5 shrink-0 rounded-full bg-neutral-600"
                          />
                        )}
                        <span
                          className={cn(
                            "min-w-0 truncate text-[13px] leading-5",
                            item.state === "queued" ? "text-muted-foreground" : "text-neutral-200",
                          )}
                        >
                          {item.state === "active" ? (step ?? "Working") : item.label}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {landed || entries.length > 0 ? (
                    <div className="flex flex-col gap-1 border-t border-white/[0.06] pt-2">
                      {landed ? (
                        <p className="text-xs text-muted-foreground">{landed.line}</p>
                      ) : null}
                      {entries.map((entry) => (
                        <p key={entry.itemId} className="truncate text-xs text-muted-foreground">
                          {opLabel(entry.op)} · {clockTime(entry.acceptedAt)}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * The board: working tasks plus the newest finished ones in one card. Only
 * one tile expands at a time. Plain grids keyed by task id: wrap in
 * Reorder.Group when order gains meaning.
 */
export function RunningTasks({
  className,
  tasks = [],
  recentTasks = [],
  history = [],
  suggestions = [],
  frozen = false,
  onOpen,
  onUndo,
  onStop,
  onRetry,
  onUndoResolve,
  onRedoResolve,
  onOpenHistory,
  onSuggest,
}: RunningTasksProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const working = useMemo(
    () => [...tasks].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
    [tasks],
  );
  const recent = useMemo(() => [...recentTasks].slice(-5).reverse(), [recentTasks]);
  const toggle = (id: string) => setExpandedId((current) => (current === id ? null : id));
  // Both groups: Working left, Recent right. One group alone fills the
  // card as a grid with one column per tile, so no half-empty rows.
  const split = working.length > 0 && recent.length > 0;
  const gridFor = (count: number) =>
    split
      ? "grid-cols-1"
      : count === 1
        ? "grid-cols-1"
        : count === 2
          ? "grid-cols-1 @min-[620px]:grid-cols-2"
          : "grid-cols-1 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3";
  const tile = (task: RunningTask, seed: number, finished: boolean) => (
    <TaskTile
      key={task.id}
      task={task}
      seed={seed}
      frozen={frozen}
      finished={finished}
      expanded={expandedId === task.id}
      history={history}
      onToggle={() => toggle(task.id)}
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
  );
  const groupLabel = (label: string, count: number) => (
    <div className="flex items-center gap-2 px-1 pb-2">
      <h3 className="text-meta font-medium text-muted-foreground">{label}</h3>
      <span className="text-meta tabular-nums text-neutral-600">{count}</span>
    </div>
  );
  return (
    <section
      aria-label="Tasks"
      className={cn("@container rounded-card bg-card p-4 text-neutral-100", className)}
    >
      <div className="flex items-center gap-1 pb-3">
        <h2 className="text-title font-medium text-neutral-100">Tasks</h2>
        <InfoHint>
          Each command becomes tasks. A task lands on a copy in Resolve and has one Undo.
        </InfoHint>
        {onOpenHistory ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-neutral-100"
            onClick={onOpenHistory}
          >
            <HistoryIcon />
            History
          </Button>
        ) : null}
      </div>
      {working.length === 0 && recent.length === 0 ? (
        <div className="flex flex-col items-start gap-3 pb-1">
          <p className="text-body text-muted-foreground">
            Nothing running. Describe an edit in the bar below.
          </p>
          {suggestions.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Suggested next steps"
            >
              {suggestions.map((item) => (
                <Button
                  key={item.label}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onSuggest?.(item)}
                >
                  {item.kind === "retry" ? <RotateCcw /> : null}
                  {item.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div
          className={cn(
            "grid grid-cols-1 gap-4",
            split && "@min-[900px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
          )}
        >
          {working.length > 0 ? (
            <section aria-label="Working" className="min-w-0">
              {groupLabel("Working", working.length)}
              <div className={cn("grid gap-2", gridFor(working.length))}>
                {working.map((task, index) => tile(task, index + 1, false))}
              </div>
            </section>
          ) : null}
          {recent.length > 0 ? (
            <section aria-label="Recent" className="min-w-0">
              {groupLabel("Recent", recent.length)}
              <div className={cn("grid gap-2", gridFor(recent.length))}>
                {recent.map((task, index) => tile(task, 101 + index, true))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}
