import {
  BlocksIcon,
  HomeIcon,
  MonitorPlayIcon,
  SettingsIcon,
  StoreIcon,
  UserRoundIcon,
} from "lucide-react";
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
import type { EditorInfo } from "./data";

export type HomeTab = "projects" | "pieces" | "marketplace" | "editors";

type HomeDockProps = {
  tab: HomeTab;
  editors: readonly EditorInfo[];
  onTab: (tab: HomeTab) => void;
  onAccount: () => void;
  onSettings: () => void;
};

type DockTipPayload = { label: string };

/** One shared tip so the bubble morphs between dock icons. */
const dockTooltip = TooltipCreateHandle<DockTipPayload>();

export function HomeDock({
  tab,
  editors,
  onTab,
  onAccount,
  onSettings,
}: HomeDockProps) {
  const inProject = editors.filter((editor) => editor.status === "inProject").length;

  return (
    <TooltipProvider delay={220} closeDelay={120} timeout={500}>
      <nav
        aria-label="Home"
        className="pointer-events-auto absolute inset-x-0 bottom-5 z-20 flex justify-center px-4"
      >
        <div
          className={cn(
            "flex h-12 max-w-full items-center gap-1 rounded-full px-2",
            "bg-[#1a1a1a]/95 shadow-raised ring-1 ring-white/[0.08] backdrop-blur-md",
            "supports-[backdrop-filter]:bg-[#1a1a1a]/88",
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
          <DockButton
            label="Marketplace"
            active={tab === "marketplace"}
            onClick={() => onTab("marketplace")}
          >
            <StoreIcon />
          </DockButton>
          <DockButton
            label={
              inProject > 0
                ? `Editors · ${inProject} in project`
                : "Editors · none in project"
            }
            active={tab === "editors"}
            onClick={() => onTab("editors")}
            badge={inProject > 0}
          >
            <MonitorPlayIcon />
          </DockButton>

          <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />

          <DockButton label="Account" onClick={onAccount}>
            <UserRoundIcon />
          </DockButton>
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
  badge,
  children,
  onClick,
}: {
  label: string;
  active?: boolean;
  badge?: boolean;
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
      {badge ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1.5 right-1.5 size-1.5 rounded-full bg-success"
        />
      ) : null}
    </TooltipTrigger>
  );
}
