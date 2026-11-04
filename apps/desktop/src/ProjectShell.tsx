import { ArrowLeft, BlocksIcon, HomeIcon, MessageSquareIcon, PanelRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChatPrompt } from "@/components/chat-prompt";
import { ServiceStatus } from "@/components/service-status";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import type { Timeline } from "@chair/timeline-ir";
import {
  Tooltip,
  TooltipCreateHandle,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChairMark } from "./home/ChairMark";
import type { EditorId } from "./home/data";
import { EditorLogo } from "./home/EditorLogo";
import { buildUndoChangeset } from "@chair/timeline-ir";
import { AssetShelf } from "./orchestrator/AssetShelf";
import { CreationBoard } from "./orchestrator/CreationBoard";
import { parseAction } from "./orchestrator/actions";
import { PlanDoc } from "./orchestrator/PlanDoc";
import { RunningTasks, type RunningTask } from "./orchestrator/RunningTasks";
import { TaskChat, UNDO_PROMPT } from "./orchestrator/TaskChat";
import { setupTask } from "./orchestrator/taskSetup";
import { useLiveTasks } from "./orchestrator/taskThread";
import { PanelDrawer } from "./PanelDrawer";
import { HistoryCard } from "./project/HistoryCard";
import { historyForTask, useProject } from "./project/store";
import { SettingsScreen } from "./settings/SettingsScreen";
import { useSettings } from "./settings/useSettings";

/** Same field as the home gallery (`HomeScreen`). */
const SHELL_BG = "#111111";

type ProjectShellProps = {
  projectId: string;
  projectName: string;
  editorId?: EditorId;
  onHome: () => void;
};

/** Chat first: the thread is the screen, Pieces is the shelf beside it. */
const SECTIONS = [
  { id: "chat", label: "Chat", icon: MessageSquareIcon },
  { id: "pieces", label: "Pieces", icon: BlocksIcon },
] as const;

type DockTipPayload = { label: string };

const dockTooltip = TooltipCreateHandle<DockTipPayload>();

/** Suggested prompts that fill the composer on the empty board. */
const SUGGESTIONS = [
  "Trim the silences",
  "Riser into the montage",
  "Duck music under my voice",
  "Make a dither title piece",
];

function formatCutDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

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

type SectionId = (typeof SECTIONS)[number]["id"];
type SideTab = "plan" | "shelf" | "history";
type PlanMode = "edit" | "talk";

/** The tabbed Plan/Shelf/History card, shared by the side column and the narrow drawer. */
function SidePanel({
  tab,
  onTab,
  plan,
  shelf,
  history,
}: {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  plan: ReactNode;
  shelf: ReactNode;
  history: ReactNode;
}) {
  return (
    <>
      <Tabs value={tab} onValueChange={(value) => onTab(value as SideTab)}>
        <TabsList size="sm" className="grid w-full shrink-0 grid-cols-3">
          <TabsTab value="plan">Plan</TabsTab>
          <TabsTab value="shelf">Shelf</TabsTab>
          <TabsTab value="history">History</TabsTab>
        </TabsList>
      </Tabs>
      <div className="mt-3 min-h-0 flex-1 overflow-hidden">
        {tab === "plan" ? plan : tab === "shelf" ? shelf : history}
      </div>
    </>
  );
}

/** Chat in the center, Plan/Shelf/History in the side panel. */
export function ProjectShell({ projectId, projectName, editorId, onHome }: ProjectShellProps) {
  const [section, setSection] = useState<SectionId>("chat");
  const [sideTab, setSideTab] = useState<SideTab>("plan");
  const { settings } = useSettings();
  const project = useProject(projectId, projectName, { applyMode: settings.applyMode });
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
  const liveTasks = useLiveTasks(createdTasks);
  const seen = useRef(0);
  // The panel opens on Plan with no tasks and on History once one exists,
  // until the person picks a tab themselves.
  const sideTouched = useRef(false);
  useEffect(() => {
    if (sideTouched.current) return;
    setSideTab(createdTasks.length > 0 ? "history" : "plan");
  }, [createdTasks.length]);

  useEffect(() => {
    if (!command || seen.current === command.id) return;
    seen.current = command.id;
    const action = parseAction(command.text);
    if (!action) {
      if (command.text.trim()) {
        setCreatedTasks((current) => {
          const task = { ...setupTask(command.text, command.id), projectId };
          return current.some((existing) => existing.id === task.id)
            ? current
            : [task, ...current];
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
    if (action.key === "accept") {
      setPlanOpen(false);
      setNotice("Accepted. The timeline is unchanged.");
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
      .flatMap((track) => track.clips.map((clip) => ({ id: clip.id, name: clip.name, track: track.name }))) ?? [];

  /** Answer an undo prompt by rewinding the task's full tail at once. */
  const requestTaskUndo = (task: RunningTask): string => {
    const entries = historyForTask(project.history, task.id);
    if (entries.length === 0) return `No applied edits to rewind for ${task.name} yet.`;
    const tip = entries[entries.length - 1]!;
    const undone = buildUndoChangeset(project.history, tip.itemId);
    if (!undone.ok) return `Can't rewind ${task.name} yet: ${undone.reason}`;
    project.undoToHere(tip.itemId);
    const count = entries.length === 1 ? "1 edit" : `${entries.length} edits`;
    return `Rewound ${count} for ${task.name} onto a copy — History shows every step.`;
  };

  const openTask = (task: RunningTask) => {
    setTaskNote(null);
    setTaskChat(task);
  };

  // The Piece Maker takes the full width: the side panel steps aside while
  // the Pieces section (or Settings) owns the screen.
  const showSide = section !== "pieces" && !settingsOpen;

  const pickSideTab = (value: SideTab) => {
    sideTouched.current = true;
    setSideTab(value);
  };

  const planPane = (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <PlanDoc
        open={planOpen}
        mode={planMode}
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
    <AssetShelf
      projectId={projectId}
      clips={effectClips}
      onApplyPiece={project.applyItem}
      onUndoPiece={(itemId) => project.undoToHere(itemId)}
      onOpenHistory={() => setSideTab("history")}
      pieceRefusal={project.refusal?.reason ?? null}
    />
  );
  const historyPane = (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <HistoryCard
        entries={project.history}
        onUndoEntry={(entry) => project.undoToHere(entry.itemId)}
        onUndoLast={() => project.undoLast()}
      />
    </div>
  );

  return (
    <section
      aria-label={projectName}
      className="@container absolute inset-0 flex min-h-0 flex-col overflow-hidden text-neutral-100"
      style={{ backgroundColor: SHELL_BG }}
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
        <h1 className="min-w-0 truncate text-sm font-medium text-neutral-200">
          {projectName}
        </h1>
        {cutBits ? (
          <span className="hidden shrink-0 text-xs tabular-nums text-neutral-500 md:block">
            {cutBits}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
          ) : section === "chat" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-2 @max-[760px]:max-w-none">
                  <RunningTasks
                    history={project.history}
                    tasks={liveTasks}
                    onOpen={openTask}
                    onUndo={(task) => {
                      setTaskChat(task);
                      setTaskNote({ id: Date.now(), text: UNDO_PROMPT });
                    }}
                  />
                  {liveTasks.length === 0 ? (
                    <p className="px-1 text-sm leading-6 text-neutral-500">
                      Say what to cut below. Every applied edit lands on a copy — undo is one key.
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 pb-20 @max-[760px]:max-w-none">
                {createdTasks.length === 0 ? (
                  <div className="flex flex-wrap gap-1.5 px-1" role="group" aria-label="Suggested prompts">
                    {SUGGESTIONS.map((text) => (
                      <button
                        key={text}
                        type="button"
                        onClick={() => setSuggestion({ id: Date.now(), text })}
                        className="rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-neutral-300 ring-1 ring-white/10 transition-colors hover:bg-white/[0.1] hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-ring"
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
          ) : (
            <CreationBoard
              clips={effectClips}
              onApplyEffect={project.applyItem}
              onUndoEffect={(itemId) => project.undoToHere(itemId)}
              onOpenHistory={() => setSideTab("history")}
              refusal={project.refusal?.reason ?? null}
            />
          )}
        </main>
        {showSide ? (
        <aside
          aria-label="Project panel"
          className="flex min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-[28px] bg-[#1a1a1a] p-4 text-neutral-100 shadow-raised ring-1 ring-white/8 @max-[760px]:hidden xl:w-96"
        >
          <SidePanel
            tab={sideTab}
            onTab={pickSideTab}
            plan={planPane}
            shelf={shelfPane}
            history={historyPane}
          />
        </aside>
        ) : null}
        <PanelDrawer open={panelOpen} onClose={() => setPanelOpen(false)}>
          <SidePanel
            tab={sideTab}
            onTab={pickSideTab}
            plan={planPane}
            shelf={shelfPane}
            history={historyPane}
          />
        </PanelDrawer>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24"
        style={{
          background: `linear-gradient(to top, ${SHELL_BG} 0%, color-mix(in srgb, ${SHELL_BG} 78%, transparent) 38%, transparent 100%)`, // taste-skill-ignore: neutral scrim keeps the dock legible over scrolled content.
        }}
      />
      <TooltipProvider delay={220} closeDelay={120} timeout={500}>
        <nav
          aria-label="Project sections"
          className="pointer-events-auto absolute inset-x-0 bottom-5 z-20 flex justify-center px-4"
        >
          <div
            className={cn(
              "flex h-12 max-w-full items-center gap-1 rounded-full px-2",
              "bg-[#1a1a1a]/95 shadow-raised ring-1 ring-white/[0.08] backdrop-blur-md",
              "supports-[backdrop-filter]:bg-[#1a1a1a]/88",
            )}
          >
            {SECTIONS.map((item) => {
              const Icon = item.icon;
              return (
                <DockButton
                  key={item.id}
                  label={item.label}
                  active={section === item.id}
                  onClick={() => {
                    setSection(item.id);
                    setTaskChat(null);
                    setTaskNote(null);
                    setPanelOpen(false);
                  }}
                >
                  <Icon />
                </DockButton>
              );
            })}
          </div>
          <Tooltip handle={dockTooltip}>
            {({ payload }) => (
              <TooltipPopup side="top" sideOffset={10}>
                {payload?.label}
              </TooltipPopup>
            )}
          </Tooltip>
        </nav>
      </TooltipProvider>
      {taskChat ? null : (
        <div className="pointer-events-none absolute bottom-5 left-5 z-20 flex items-center gap-2.5 text-neutral-400 @max-[760px]:hidden">
          <ChairMark className="h-8 w-auto text-neutral-200" />
          <span className="text-base font-medium tracking-wide text-neutral-200">
            Chair
          </span>
        </div>
      )}
    </section>
  );
}

function DockButton({
  label,
  active,
  children,
  onClick,
}: {
  label: string;
  active?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <TooltipTrigger
      handle={dockTooltip}
      payload={{ label }}
      delay={220}
      closeDelay={120}
      render={
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            "relative size-9 rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            active && "bg-foreground/[0.1] text-foreground",
          )}
        />
      }
    >
      {children}
    </TooltipTrigger>
  );
}
