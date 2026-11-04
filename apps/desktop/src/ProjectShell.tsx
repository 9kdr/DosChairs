import { ArrowLeft, HistoryIcon, HomeIcon, PanelRight, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChatPrompt } from "@/components/chat-prompt";
import { ServiceStatus } from "@/components/service-status";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import type { Timeline } from "@chair/timeline-ir";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCutDuration } from "@/lib/format";
import type { EditorId } from "./home/data";
import { EditorLogo } from "./home/EditorLogo";
import { buildUndoChangeset } from "@chair/timeline-ir";
import { AssetShelf } from "./orchestrator/AssetShelf";
import { CreationBoard } from "./orchestrator/CreationBoard";
import { parseAction } from "./orchestrator/actions";
import { PlanDoc } from "./orchestrator/PlanDoc";
import { RunningTasks, type RunningTask } from "./orchestrator/RunningTasks";
import { ShelfPieces } from "./orchestrator/ShelfPieces";
import { TaskChat, UNDO_PROMPT } from "./orchestrator/TaskChat";
import { setupTask } from "./orchestrator/taskSetup";
import {
  isLiveTaskSettled,
  landedFor,
  redoLandedWrite,
  retryLandedWrite,
  retryLiveTask,
  settledTaskRows,
  undoLandedWrite,
  useLiveTasks,
} from "./orchestrator/taskThread";
import { PanelDrawer } from "./PanelDrawer";
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

/** Suggested prompts that fill the composer on the empty board. Demo-only: every one lands in Resolve today. */
const SUGGESTIONS = [
  "Riser into the reveal",
  "Duck music under my voice",
  "Make a dither title piece",
  "Bouncy cursor on the click",
];

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
type PlanMode = "edit" | "talk";

/**
 * The tabbed Plan/Shelf card, shared by the side column and the narrow
 * drawer. In the drawer, one header row holds the tabs plus the close
 * button; the side column has no close button.
 */
function SidePanel({
  tab,
  onTab,
  plan,
  shelf,
  onClose,
}: {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  plan: ReactNode;
  shelf: ReactNode;
  onClose?: () => void;
}) {
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTab(value as SideTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2">
        <TabsList
          variant="underline"
          size="sm"
          className="grid w-full flex-1 grid-cols-2 border-b border-line"
        >
          <TabsTab value="plan">Plan</TabsTab>
          <TabsTab value="shelf">Shelf</TabsTab>
        </TabsList>
        {onClose ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close panel"
            onClick={onClose}
            autoFocus
            className="shrink-0 self-start"
          >
            <X />
          </Button>
        ) : null}
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-hidden">{tab === "plan" ? plan : shelf}</div>
    </Tabs>
  );
}

/** The board in the center, Plan/Shelf in the side panel. */
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
  const [panelOpen, setPanelOpen] = useState(false);
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
    setPanelOpen(false);
    setPage("history");
  };

  /** The Effect Maker as a full page, from the Shelf's Create button. */
  const openMakerPage = () => {
    setTaskChat(null);
    setTaskNote(null);
    setPanelOpen(false);
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

  // The Effect Maker takes the full width: the side panel steps aside
  // while it (or Settings) owns the screen. History keeps the panel.
  const showSide = page !== "maker" && !settingsOpen;

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
      />
    </div>
  );
  const shelfPane = (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <AssetShelf
        projectId={projectId}
        clips={effectClips}
        onApplyPiece={project.applyItem}
        onUndoPiece={(itemId) => project.undoToHere(itemId)}
        onOpenHistory={openHistoryPage}
        pieceRefusal={project.refusal?.reason ?? null}
        className="min-h-0 flex-1"
      />
      <ShelfPieces onCreate={openMakerPage} className="min-h-0 flex-1" />
    </div>
  );

  return (
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
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Project panel"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen(true)}
            className="@min-[761px]:hidden rounded-lg text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100"
          >
            <PanelRight />
          </Button>
          <ServiceStatus />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
                <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 py-2 @max-[760px]:max-w-none">
                  <RunningTasks
                    history={project.history}
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
                </div>
              </div>
              <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 @max-[760px]:max-w-none">
                {createdTasks.length === 0 ? (
                  <div
                    className="flex flex-wrap gap-1.5 px-1"
                    role="group"
                    aria-label="Suggested prompts"
                  >
                    {SUGGESTIONS.map((text) => (
                      <button
                        key={text}
                        type="button"
                        onClick={() => setSuggestion({ id: Date.now(), text })}
                        className="rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/[0.1] hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {text}
                      </button>
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
              <div className="mx-auto min-h-0 w-full max-w-4xl flex-1">
                <CreationBoard
                  clips={effectClips}
                  onApplyEffect={project.applyItem}
                  onUndoEffect={(itemId) => project.undoToHere(itemId)}
                  onOpenHistory={openHistoryPage}
                  refusal={project.refusal?.reason ?? null}
                  landings={project.landings}
                  onRecordLanding={project.recordLanding}
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
        {showSide ? (
          <aside
            aria-label="Project panel"
            className="flex min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-card bg-card p-4 text-neutral-100 @max-[760px]:hidden xl:w-96"
          >
            <SidePanel tab={sideTab} onTab={setSideTab} plan={planPane} shelf={shelfPane} />
          </aside>
        ) : null}
        <PanelDrawer open={panelOpen} onClose={() => setPanelOpen(false)}>
          <SidePanel
            tab={sideTab}
            onTab={setSideTab}
            plan={planPane}
            shelf={shelfPane}
            onClose={() => setPanelOpen(false)}
          />
        </PanelDrawer>
      </div>
    </section>
  );
}
