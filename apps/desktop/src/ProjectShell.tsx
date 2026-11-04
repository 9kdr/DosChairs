import { ArrowLeft, HistoryIcon, HomeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChatPrompt } from "@/components/chat-prompt";
import { ServiceStatus } from "@/components/service-status";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { ToastProvider, toastManager } from "@/components/ui/toast";
import type { Timeline } from "@chair/timeline-ir";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCutDuration } from "@/lib/format";
import type { EditorId } from "./home/data";
import { EditorLogo } from "./home/EditorLogo";
import { buildUndoChangeset } from "@chair/timeline-ir";
import { EffectMaker } from "./effects/EffectMaker";
import { parseAction } from "./orchestrator/actions";
import { PlanDoc } from "./orchestrator/PlanDoc";
import { RunningTasks, type RunningTask } from "./orchestrator/RunningTasks";
import type { ProjectPlan } from "./orchestrator/plan-api";
import { Shelf } from "./orchestrator/Shelf";
import { suggestionsFor, type Suggestion } from "./orchestrator/suggestions";
import { TaskChat, UNDO_PROMPT } from "./orchestrator/TaskChat";
import { setupTask } from "./orchestrator/taskSetup";
import {
  hasCutItems,
  hasSoundItems,
  isLiveTaskSettled,
  landedFor,
  onTaskSettled,
  redoLandedWrite,
  retryLandedWrite,
  retryLiveTask,
  settledTaskRows,
  undoLandedWrite,
  useLiveTasks,
} from "./orchestrator/taskThread";
import { HistoryCard } from "./project/HistoryCard";
import { historyKeyAction, historyKeyAllowed } from "./project/history-keys";
import { historyForTask, useProject } from "./project/store";
import { SettingsScreen } from "./settings/SettingsScreen";

type ProjectShellProps = {
  projectId: string;
  projectName: string;
  editorId?: EditorId;
  onHome: () => void;
};

/** Compact cut line for the header from the timeline the store already has. */
function cutSummary(timeline: Timeline | null): string | null {
  if (!timeline) return null;
  let clips = 0;
  let seconds = 0;
  for (const track of timeline.tracks) {
    clips += track.clips.length;
    for (const clip of track.clips) {
      const { start, duration } = clip.timelineRange;
      const end =
        (start.rate ? start.value / start.rate : 0) +
        (duration.rate ? duration.value / duration.rate : 0);
      if (end > seconds) seconds = end;
    }
  }
  const trackBit = timeline.tracks.length === 1 ? "1 track" : `${timeline.tracks.length} tracks`;
  const clipBit = clips === 1 ? "1 clip" : `${clips} clips`;
  return `${trackBit} · ${clipBit} · ${formatCutDuration(seconds)}`;
}

/** Main-area pages: the board, or one full page with a Back button. */
type Page = "board" | "maker" | "history";
type SideTab = "plan" | "shelf";
/** Narrow windows switch the single column between tasks, plan, and shelf. */
type NarrowTab = "tasks" | SideTab;
type PlanMode = "edit" | "talk";

/** The dashboard: tasks on top, Plan and Shelf below on one canvas. */
export function ProjectShell({ projectId, projectName, editorId, onHome }: ProjectShellProps) {
  const [page, setPage] = useState<Page>("board");
  const [sideTab, setSideTab] = useState<SideTab>("plan");
  const project = useProject(projectId, projectName);
  const [command, setCommand] = useState<{ id: number; text: string } | null>(null);
  const [createdTasks, setCreatedTasks] = useState<RunningTask[]>([]);
  const [taskChat, setTaskChat] = useState<RunningTask | null>(null);
  const [taskNote, setTaskNote] = useState<{ id: number; text: string } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planMode, setPlanMode] = useState<PlanMode>("edit");
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<{ id: number; text: string } | null>(null);
  // The structured plan, mirrored up from the Plan card so suggestions follow it.
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [narrowTab, setNarrowTab] = useState<NarrowTab>("tasks");
  // Bumped after card Undo/Redo/Retry so the rows repaint at once, not next poll.
  const [liveNonce, setLiveNonce] = useState(0);
  const liveTasks = useLiveTasks(createdTasks, liveNonce);
  const workingTasks = liveTasks.filter((task) => !isLiveTaskSettled(task.id));
  // Finished tasks read newest first below; a Resolve write replaces the
  // plain Done line with what landed.
  const recentTasks = settledTaskRows().map((task) => {
    const landed = landedFor(task.id);
    return landed ? { ...task, status: landed.line } : task;
  });
  const seen = useRef(0);

  useEffect(() => {
    if (!command || seen.current === command.id) return;
    seen.current = command.id;
    const action = parseAction(command.text);
    if (!action) {
      if (command.text.trim()) {
        setCreatedTasks((current) => {
          const task = { ...setupTask(command.text, command.id), projectId };
          return current.some((existing) => existing.id === task.id) ? current : [task, ...current];
        });
      }
      return;
    }
    if (action.key === "brief") {
      setPlanMode("edit");
      setPlanOpen(true);
      setSideTab("plan");
      setNotice(null);
      return;
    }
    if (action.key === "again") {
      setNotice("Another pass, same rules.");
      return;
    }
    if (action.slot) setNotice(`${action.key}: ${action.slot}`);
  }, [command, projectId]);

  const cutBits = cutSummary(project.timeline);

  /** Clips an effect-kind piece can land on: every video-track clip in the cut. */
  const effectClips =
    project.timeline?.tracks
      .filter((track) => track.kind === "video")
      .flatMap((track, trackIdx) =>
        track.clips.map((clip, clipIdx) => ({
          id: clip.id,
          name: clip.name,
          track: track.name,
          trackIndex: trackIdx + 1,
          clipIndex: clipIdx,
          trackType: "video" as const,
        })),
      ) ?? [];

  /** Answer an undo prompt by rewinding the task's full tail at once. */
  const requestTaskUndo = (task: RunningTask): string => {
    const entries = historyForTask(project.history, task.id);
    if (entries.length === 0) return `No applied edits to rewind for ${task.name} yet.`;
    const tip = entries[entries.length - 1]!;
    const undone = buildUndoChangeset(project.history, tip.itemId);
    if (!undone.ok) return `Can't rewind ${task.name} yet: ${undone.reason}`;
    project.undoToHere(tip.itemId);
    const count = entries.length === 1 ? "1 edit" : `${entries.length} edits`;
    toastManager.add({ type: "success", title: `Undone: ${task.name}` });
    return `Rewound ${count} for ${task.name}.`;
  };

  const openTask = (task: RunningTask) => {
    setTaskNote(null);
    setTaskChat(task);
  };

  /** History as a full page. Closes any task thread, like the old dock did. */
  const openHistoryPage = () => {
    setTaskChat(null);
    setTaskNote(null);
    setPage("history");
  };

  /** The Effect Maker as a full page, from the Shelf's Create button. */
  const openMakerPage = () => {
    setTaskChat(null);
    setTaskNote(null);
    setPage("maker");
  };

  // u (and its shortcut twin) opens the History page from the board; the
  // page itself keeps the undo behavior, unchanged.
  useEffect(() => {
    if (page !== "board" || taskChat || settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!historyKeyAllowed(event.target)) return;
      if (historyKeyAction(event) !== "undo") return;
      event.preventDefault();
      openHistoryPage();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /** Retry a failed card: resubmit the turn, or re-fire a failed write. */
  const retryTask = (task: RunningTask) => {
    retryLiveTask(task.id);
    retryLandedWrite(task.id);
    setLiveNonce((nonce) => nonce + 1);
  };

  /**
   * Undo a landed write: the original is current again in Resolve, and
   * the task's local tail rewinds so the mirror follows — the rewind
   * records the history entry for the undo. Refusals fail closed.
   */
  const undoResolveWrite = (task: RunningTask) => {
    void (async () => {
      if (!(await undoLandedWrite(task.id))) {
        setLiveNonce((nonce) => nonce + 1);
        return;
      }
      const entries = historyForTask(project.history, task.jobId ?? task.id);
      const tip = entries[entries.length - 1];
      if (tip) project.undoToHere(tip.itemId);
      toastManager.add({ type: "success", title: `Undone: ${task.name}` });
      setLiveNonce((nonce) => nonce + 1);
    })();
  };

  /** Redo an undone write: the stored apply goes again as a new copy. */
  const redoResolveWrite = (task: RunningTask) => {
    void (async () => {
      await redoLandedWrite(task.id);
      setLiveNonce((nonce) => nonce + 1);
    })();
  };

  // Toasts for real task transitions: a finished turn lands or plans,
  // a failed turn says so. Tasks that were already finished on first
  // load never reach here — only session-polled jobs announce.
  useEffect(
    () =>
      onTaskSettled(({ task, job }) => {
        if (job.status === "completed") {
          const landed = hasSoundItems(job) || hasCutItems(job);
          toastManager.add({
            id: `task-${task.id}`,
            type: "success",
            title: `${landed ? "Landed" : "Planned"}: ${task.name}`,
          });
        } else if (job.status === "failed") {
          toastManager.add({
            id: `task-${task.id}`,
            type: "error",
            title: `Failed: ${task.name}`,
          });
        }
      }),
    [],
  );

  // The Effect Maker takes the full width while it (or Settings) owns
  // the screen. History keeps the dashboard. Narrow windows keep a panel.
  const showSide = page !== "maker" && !settingsOpen;
  // Narrow windows get one underline switch instead of two columns.
  // The task thread owns the whole narrow screen, like before.
  const showNarrowTabs = showSide && !taskChat;
  const narrowShowsPanel = showNarrowTabs && narrowTab !== "tasks";
  const allTasks = [...workingTasks, ...recentTasks];
  const suggestions = suggestionsFor({ plan, tasks: allTasks });

  const planPane = (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <PlanDoc
        open={planOpen}
        mode={planMode}
        projectId={projectId}
        onOpen={(mode) => {
          setPlanMode(mode);
          setPlanOpen(true);
        }}
        onClose={() => setPlanOpen(false)}
        notice={notice}
        onPlan={setPlan}
      />
    </div>
  );
  const shelfPane = (
    <Shelf
      projectId={projectId}
      clips={effectClips}
      onApplyPiece={project.applyItem}
      onUndoPiece={(itemId) => project.undoToHere(itemId)}
      onOpenHistory={openHistoryPage}
      pieceRefusal={project.refusal?.reason ?? null}
      landings={project.landings}
      onRecordLanding={project.recordLanding}
      onCreate={openMakerPage}
    />
  );
  const hasTasks = workingTasks.length + recentTasks.length > 0;
  /** A chip: retry the failed task, or drop the prompt into the bar. */
  const pickSuggestion = (item: Suggestion) => {
    if (item.kind === "retry") {
      const target = allTasks.find((task) => task.id === item.taskId);
      if (target) retryTask(target);
    } else {
      setSuggestion({ id: Date.now(), text: item.text });
    }
  };
  const tasksList = (
    <RunningTasks
      projectId={projectId}
      history={project.history}
      // Chips live in the empty card; once tasks exist they sit above the bar.
      suggestions={hasTasks ? [] : suggestions}
      onSuggest={pickSuggestion}
      tasks={workingTasks}
      recentTasks={recentTasks}
      onOpen={openTask}
      onUndo={(task) => {
        setTaskChat(task);
        setTaskNote({ id: Date.now(), text: UNDO_PROMPT });
      }}
      onRetry={retryTask}
      onUndoResolve={undoResolveWrite}
      onRedoResolve={redoResolveWrite}
      onOpenHistory={openHistoryPage}
    />
  );

  return (
    <ToastProvider
      position="bottom-right"
      viewportClassName="data-[position*=bottom]:bottom-36 min-[1000px]:data-[position*=bottom]:bottom-28 data-[position*=right]:right-3 [--toast-inset:--spacing(3)] sm:[--toast-inset:--spacing(3)]"
      toastClassName="rounded-2xl border-white/[0.06]"
    >
      <section
        aria-label={projectName}
        className="@container absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-background text-neutral-100"
      >
      <header className="flex h-12 shrink-0 items-center gap-2.5 pr-28 pl-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Home"
                onClick={onHome}
                className="rounded-lg text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100"
              />
            }
          >
            <HomeIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Home</TooltipPopup>
        </Tooltip>
        {editorId ? <EditorLogo id={editorId} className="size-4" /> : null}
        <h1 className="min-w-0 truncate text-sm font-medium text-neutral-200">{projectName}</h1>
        {cutBits ? (
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:block">
            {cutBits}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="History"
                  onClick={openHistoryPage}
                  className="rounded-lg text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100"
                />
              }
            >
              <HistoryIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">History</TooltipPopup>
          </Tooltip>
          <ServiceStatus />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        {showNarrowTabs ? (
          <Tabs
            value={narrowTab}
            onValueChange={(value) => {
              const next = value as NarrowTab;
              setNarrowTab(next);
              if (next !== "tasks") setSideTab(next);
            }}
            className="@min-[761px]:hidden w-full shrink-0"
          >
            <TabsList
              variant="underline"
              size="sm"
              className="grid w-full grid-cols-3 border-b border-line"
            >
              <TabsTab value="tasks">Tasks</TabsTab>
              <TabsTab value="plan">Plan</TabsTab>
              <TabsTab value="shelf">Shelf</TabsTab>
            </TabsList>
          </Tabs>
        ) : null}
        <div className="flex min-h-0 flex-1 gap-3">
          <main
            className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden${narrowShowsPanel ? " @max-[760px]:hidden" : ""}`}
          >
          {settingsOpen ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2 overscroll-contain">
              <div className="mx-auto flex w-full max-w-4xl shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Back to project"
                  onClick={() => setSettingsOpen(false)}
                >
                  <ArrowLeft />
                  Back
                </Button>
              </div>
              <SettingsScreen onBack={() => setSettingsOpen(false)} />
            </div>
          ) : taskChat ? (
            <TaskChat
              task={taskChat}
              note={taskNote}
              history={project.history}
              onClose={() => {
                setTaskChat(null);
                setTaskNote(null);
              }}
              onSend={(text) => setTaskNote({ id: Date.now(), text })}
              onUndoRequest={requestTaskUndo}
              onUndoEntry={(entry) => project.undoToHere(entry.itemId)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : page === "board" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto flex min-h-full w-full flex-col gap-3 pt-2 pb-4 @min-[1000px]:h-full">
                  {tasksList}
                  <div className="grid grid-cols-1 gap-3 @min-[1000px]:max-h-[560px] @min-[1000px]:min-h-[340px] @min-[1000px]:flex-1 @min-[1000px]:grid-cols-12 @min-[1000px]:grid-rows-[minmax(0,1fr)]">
                    <section
                      aria-label="Plan"
                      className="flex min-h-0 flex-col rounded-card bg-card p-4 text-neutral-100 @max-[760px]:hidden @min-[1000px]:col-span-7"
                    >
                      {planPane}
                    </section>
                    <section
                      aria-label="Shelf"
                      className="flex h-[420px] min-h-0 flex-col rounded-card bg-card p-4 text-neutral-100 @max-[760px]:hidden @min-[1000px]:col-span-5 @min-[1000px]:h-auto"
                    >
                      {shelfPane}
                    </section>
                  </div>
                </div>
              </div>
              <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 @max-[760px]:max-w-none">
                {hasTasks && suggestions.length > 0 ? (
                  <div
                    className="flex flex-wrap gap-1.5 px-1"
                    role="group"
                    aria-label="Suggested next steps"
                  >
                    {suggestions.map((item) => (
                      <Button
                        key={item.label}
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => pickSuggestion(item)}
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
                <ChatPrompt
                  open
                  wide
                  placeholder="Tell Chair what to cut…"
                  suggestion={suggestion}
                  onOpen={() => {}}
                  onClose={() => {}}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onSend={(draft) => {
                    if (draft.text.trim()) {
                      setCommand({ id: Date.now(), text: draft.text });
                    }
                  }}
                />
              </div>
            </div>
          ) : page === "maker" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2 overscroll-contain">
              <div className="mx-auto min-h-0 w-full max-w-4xl flex-1">
                <EffectMaker
                  clips={effectClips}
                  onApply={project.applyItem}
                  onUndo={(itemId) => project.undoToHere(itemId)}
                  onOpenHistory={openHistoryPage}
                  refusal={project.refusal?.reason ?? null}
                  landings={project.landings}
                  onRecordLanding={project.recordLanding}
                  onBack={() => setPage("board")}
                />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-2 overscroll-contain">
              <div className="mx-auto flex w-full max-w-4xl shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Back to tasks"
                  onClick={() => setPage("board")}
                >
                  <ArrowLeft />
                  Back
                </Button>
              </div>
              <div className="mx-auto w-full max-w-4xl">
                <HistoryCard
                  entries={project.history}
                  onUndoEntry={(entry) => project.undoToHere(entry.itemId)}
                  onUndoLast={() => project.undoLast()}
                />
              </div>
            </div>
          )}
          </main>
          {narrowShowsPanel ? (
            <aside
              aria-label="Project panel"
              className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden rounded-card bg-card p-4 text-neutral-100 @min-[761px]:hidden"
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                {sideTab === "plan" ? planPane : shelfPane}
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </section>
    </ToastProvider>
  );
}
