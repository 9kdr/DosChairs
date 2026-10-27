import { HomeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChairMark } from "./home/ChairMark";

/** Same field as the home gallery (`HomeScreen`). */
const SHELL_BG = "#111111";

type ProjectShellProps = {
  projectName: string;
  onHome: () => void;
};

/** Blank project view: a way home, the open name, and the Chair mark. */
export function ProjectShell({ projectName, onHome }: ProjectShellProps) {
  return (
    <section
      aria-label={projectName}
      className="relative flex h-full min-h-0 flex-col overflow-hidden text-neutral-100"
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
      <div className="pointer-events-none absolute bottom-5 right-5 z-20 flex items-center gap-2.5 text-neutral-400">
        <ChairMark className="h-8 w-auto text-neutral-200" />
        <span className="text-base font-medium tracking-wide text-neutral-200">
          Chair
        </span>
      </div>
    </section>
  );
}
