import { BlocksIcon, HomeIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipCreateHandle,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// "marketplace" stays in the type for the later feature; the dock hides it for now.
export type HomeTab = "projects" | "pieces" | "marketplace";

type HomeDockProps = {
  tab: HomeTab;
  onTab: (tab: HomeTab) => void;
  onSettings: () => void;
};

type DockTipPayload = { label: string };

/** One shared tip so the bubble morphs between dock icons. */
const dockTooltip = TooltipCreateHandle<DockTipPayload>();

export function HomeDock({ tab, onTab, onSettings }: HomeDockProps) {
  return (
    <TooltipProvider delay={220} closeDelay={120} timeout={500}>
      <nav
        aria-label="Home"
        className="pointer-events-auto absolute inset-x-0 bottom-5 z-20 flex justify-center px-4"
      >
        <div
          className={cn(
            "flex h-12 max-w-full items-center gap-1 rounded-full px-2",
            "bg-card/95 shadow-rim backdrop-blur-md",
            "supports-[backdrop-filter]:bg-card/88",
          )}
        >
          <DockButton
            label="Projects"
            active={tab === "projects"}
            onClick={() => onTab("projects")}
          >
            <HomeIcon />
          </DockButton>
          <DockButton
            label="Pieces"
            active={tab === "pieces"}
            onClick={() => onTab("pieces")}
          >
            <BlocksIcon />
          </DockButton>
          <span
            aria-hidden="true"
            className="mx-1 h-5 border-l border-white/[0.08] border-r border-black/50"
          />

          <DockButton label="Settings" onClick={onSettings}>
            <SettingsIcon />
          </DockButton>
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
