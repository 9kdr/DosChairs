import {
  ClapperboardIcon,
  MessageSquareIcon,
  PanelRightIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ChatRailProps = {
  threadsOpen: boolean;
  cutOpen: boolean;
  pending: number;
  onToggleThreads: () => void;
  onToggleCut: () => void;
  onNewChat: () => void;
};

export function ChatRail({
  threadsOpen,
  cutOpen,
  pending,
  onToggleThreads,
  onToggleCut,
  onNewChat,
}: ChatRailProps) {
  return (
    <nav
      aria-label="Workspace"
      className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-background/50 py-2 md:flex"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="New chat"
              onClick={onNewChat}
              className="mb-2 size-8 rounded-[.625rem] border border-foreground/[0.07] bg-foreground/[0.035] shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] hover:bg-foreground/[0.07]"
            />
          }
        >
          <ClapperboardIcon className="size-4 text-foreground/80" />
        </TooltipTrigger>
        <TooltipPopup side="right">New chat</TooltipPopup>
      </Tooltip>

      <RailButton
        label={threadsOpen ? "Hide threads" : "Show threads"}
        active={threadsOpen}
        onClick={onToggleThreads}
      >
        <MessageSquareIcon />
      </RailButton>

      <RailButton
        label={cutOpen ? "Hide cut" : "Show cut"}
        active={cutOpen}
        onClick={onToggleCut}
        badge={pending}
        className="hidden lg:flex"
      >
        <PanelRightIcon />
      </RailButton>

      <div className="mt-auto" />

      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Workspace menu"
              className="rounded-lg text-muted-foreground hover:text-foreground"
            />
          }
        >
          <SettingsIcon />
        </MenuTrigger>
        <MenuPopup side="right" align="end" className="w-48">
          <MenuItem onClick={onNewChat}>New chat</MenuItem>
          <MenuItem onClick={onToggleThreads}>
            {threadsOpen ? "Hide threads" : "Show threads"}
          </MenuItem>
          <MenuItem onClick={onToggleCut}>
            {cutOpen ? "Hide cut" : "Show cut"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled>Settings</MenuItem>
        </MenuPopup>
      </Menu>
    </nav>
  );
}

function RailButton({
  label,
  active,
  badge,
  className,
  children,
  onClick,
}: {
  label: string;
  active: boolean;
  badge?: number;
  className?: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
            className={cn(
              "relative rounded-lg text-muted-foreground hover:text-foreground",
              active && "bg-foreground/[0.07] text-foreground",
              className,
            )}
          />
        }
      >
        {children}
        {badge && badge > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-1.5 bottom-1.5 size-1.5 rounded-full bg-warning"
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
