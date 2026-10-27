import { HomeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChairMark } from "./home/ChairMark";

type ProjectShellProps = {
  projectName: string;
  onHome: () => void;
};

/** Blank project view: a way home, the open name, and the Chair mark. */
export function ProjectShell({ projectName, onHome }: ProjectShellProps) {
  return (
    <section
      aria-label={projectName}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-edge pr-28 pl-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Home"
                onClick={onHome}
                className="rounded-lg text-muted-foreground hover:text-foreground"
              />
            }
          >
            <HomeIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Home</TooltipPopup>
        </Tooltip>
        <ChairMark className="h-5 w-auto text-foreground/80" />
        <h1 className="min-w-0 truncate text-sm font-medium text-foreground">
          {projectName}
        </h1>
      </header>
      <main className="min-h-0 flex-1" />
    </section>
  );
}
