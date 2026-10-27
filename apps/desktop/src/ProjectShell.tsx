import {
  HomeIcon,
  PaintbrushIcon,
  PaletteIcon,
  ScissorsIcon,
  WaypointsIcon,
} from "lucide-react";
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
import { OrchestratorBoard } from "./orchestrator/OrchestratorBoard";

/** Same field as the home gallery (`HomeScreen`). */
const SHELL_BG = "#111111";

type ProjectShellProps = {
  projectName: string;
  editorId?: EditorId;
  onHome: () => void;
};

/** Same dock as home. Icons are the project lenses. */
const SECTIONS = [
  { id: "orchestrator", label: "Orchestrator", icon: WaypointsIcon },
  { id: "edit", label: "Edit", icon: ScissorsIcon },
  { id: "effects", label: "Effects", icon: PaintbrushIcon },
  { id: "colour", label: "Colour", icon: PaletteIcon },
] as const;

type DockTipPayload = { label: string };

const dockTooltip = TooltipCreateHandle<DockTipPayload>();

type SectionId = (typeof SECTIONS)[number]["id"];

/** Blank project view: a way home, a prompt, section nav, and the Chair mark. */
export function ProjectShell({ projectName, editorId, onHome }: ProjectShellProps) {
  const [section, setSection] = useState<SectionId>("orchestrator");

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
        <h1 className="min-w-0 truncate text-sm font-medium text-neutral-200">
          {projectName}
        </h1>
        {editorId ? <EditorLogo id={editorId} className="size-4" /> : null}
      </header>
      <main className="min-h-0 flex-1 pb-36">
        {section === "orchestrator" ? <OrchestratorBoard /> : null}
      </main>
      <div className="pointer-events-auto absolute inset-x-0 bottom-[calc(1.25rem+3rem+0.75rem)] z-10 flex justify-center px-4">
        <ChatPrompt />
      </div>
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
                  onClick={() => setSection(item.id)}
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
