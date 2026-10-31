import { BlocksIcon, HomeIcon, ListChecksIcon, WaypointsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ChatPrompt } from "@/components/chat-prompt";
import { Button } from "@/components/ui/button";
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
import { CreationBoard } from "./orchestrator/CreationBoard";
import { OrchestratorBoard } from "./orchestrator/OrchestratorBoard";
import { TaskChat } from "./orchestrator/TaskChat";
import type { RunningTask } from "./orchestrator/RunningTasks";
import { ReviewBoard } from "./project/ReviewBoard";
import { useProject } from "./project/store";

/** Same field as the home gallery (`HomeScreen`). */
const SHELL_BG = "#111111";

type ProjectShellProps = {
  projectId: string;
  projectName: string;
  editorId?: EditorId;
  onHome: () => void;
};

/** Same dock as home. Icons are the project lenses. */
const SECTIONS = [
  { id: "review", label: "Review", icon: ListChecksIcon },
  { id: "orchestrator", label: "Orchestrator", icon: WaypointsIcon },
  { id: "creation", label: "Creation", icon: BlocksIcon },
] as const;

type DockTipPayload = { label: string };

const dockTooltip = TooltipCreateHandle<DockTipPayload>();

type SectionId = (typeof SECTIONS)[number]["id"];

/** Blank project view: a way home, a command bar, section nav, and the Chair mark. */
export function ProjectShell({ projectId, projectName, editorId, onHome }: ProjectShellProps) {
  const [section, setSection] = useState<SectionId>("review");
  const project = useProject(projectId, projectName);
  const [barOpen, setBarOpen] = useState(false);
  const [command, setCommand] = useState<{ id: number; text: string } | null>(null);
  const [taskChat, setTaskChat] = useState<RunningTask | null>(null);
  const [taskNote, setTaskNote] = useState<{ id: number; text: string } | null>(null);

  return (
    <section
      aria-label={projectName}
      className="absolute inset-0 flex min-h-0 flex-col overflow-hidden text-neutral-100"
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
      </header>
      <main className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          {taskChat ? (
            <TaskChat
              task={taskChat}
              note={taskNote}
              onClose={() => {
                setTaskChat(null);
                setTaskNote(null);
              }}
              onSend={(text) => setTaskNote({ id: Date.now(), text })}
            />
          ) : section === "review" ? (
            <ReviewBoard store={project} />
          ) : section === "orchestrator" ? (
            <OrchestratorBoard
              command={command}
              onOpenTask={(task) => {
                setTaskNote(null);
                setTaskChat(task);
              }}
            />
          ) : (
            <CreationBoard />
          )}
        </div>
        {!taskChat ? (
          <div className="pointer-events-auto absolute inset-x-0 bottom-[calc(1.25rem+3rem+0.75rem)] z-20 flex justify-center px-4">
            <ChatPrompt
              open={barOpen}
              onOpen={() => setBarOpen(true)}
              onClose={() => setBarOpen(false)}
              onSend={(draft) => {
                if (draft.text.trim()) {
                  setCommand({ id: Date.now(), text: draft.text });
                }
                setBarOpen(false);
              }}
            />
          </div>
        ) : null}
      </main>
      {!taskChat ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-64"
          style={{
            background: `linear-gradient(to top, ${SHELL_BG} 0%, color-mix(in srgb, ${SHELL_BG} 78%, transparent) 38%, transparent 100%)`,
          }}
        />
      ) : null}
      {!taskChat ? (
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
      ) : null}
      <div className="pointer-events-none absolute bottom-5 left-5 z-20 flex items-center gap-2.5 text-neutral-400">
        <ChairMark className="h-8 w-auto text-neutral-200" />
        <span className="text-base font-medium tracking-wide text-neutral-200">
          Chair
        </span>
      </div>
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
