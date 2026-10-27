import { HomeIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChairMark } from "./home/ChairMark";

/** Same field as the home gallery (`HomeScreen`). */
const SHELL_BG = "#111111";

type ProjectShellProps = {
  projectName: string;
  onHome: () => void;
};

/** Worker lanes under the orchestrator. Views only — the center stays empty. */
const SECTIONS = [
  { id: "orchestrator", label: "Orchestrator" },
  { id: "edit", label: "Edit" },
  { id: "effects", label: "Effects" },
  { id: "colour", label: "Colour" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** Blank project view: a way home, section nav, and the Chair mark. */
export function ProjectShell({ projectName, onHome }: ProjectShellProps) {
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
      </header>
      <main className="min-h-0 flex-1" />
      <nav
        aria-label="Project sections"
        className="pointer-events-auto absolute inset-x-0 bottom-5 z-20 flex justify-center px-4"
      >
        <div
          className={cn(
            "flex h-12 max-w-full items-center gap-0.5 rounded-full px-1.5",
            "bg-[#1a1a1a]/95 shadow-raised ring-1 ring-white/[0.08] backdrop-blur-md",
            "supports-[backdrop-filter]:bg-[#1a1a1a]/88",
          )}
        >
          {SECTIONS.map((item) => {
            const active = section === item.id;
            return (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={active}
                onClick={() => setSection(item.id)}
                className={cn(
                  "h-9 rounded-full px-3.5 text-sm font-medium text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100",
                  active && "bg-white/[0.1] text-neutral-100",
                )}
              >
                {item.label}
              </Button>
            );
          })}
        </div>
      </nav>
      <div className="pointer-events-none absolute bottom-5 left-5 z-20 flex items-center gap-2.5 text-neutral-400">
        <ChairMark className="h-8 w-auto text-neutral-200" />
        <span className="text-base font-medium tracking-wide text-neutral-200">
          Chair
        </span>
      </div>
    </section>
  );
}
