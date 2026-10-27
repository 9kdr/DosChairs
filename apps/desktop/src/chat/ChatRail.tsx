import {
  ClapperboardIcon,
  HomeIcon,
  MessageSquareIcon,
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
  projectName?: string;
  onToggleThreads: () => void;
  onNewChat: () => void;
  onHome: () => void;
};

export function ChatRail({
  threadsOpen,
  projectName,
  onToggleThreads,
  onNewChat,
  onHome,
}: ChatRailProps) {
  return (
    <nav
      aria-label="Workspace"
      className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-edge bg-sidebar py-2 md:flex"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Home"
              onClick={onHome}
              className="mb-1 rounded-lg text-muted-foreground hover:text-foreground"
            />
          }
        >
          <HomeIcon />
        </TooltipTrigger>
        <TooltipPopup side="right">
          {projectName ? `Home · ${projectName}` : "Home"}
        </TooltipPopup>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="New chat"
              onClick={onNewChat}
              className="mb-2 rounded-lg border-edge bg-surface text-foreground/80 shadow-raised hover:bg-surface-quiet"
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
          <MenuItem onClick={onHome}>Home</MenuItem>
          <MenuItem onClick={onNewChat}>New chat</MenuItem>
          <MenuItem onClick={onToggleThreads}>
            {threadsOpen ? "Hide threads" : "Show threads"}
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
  className,
  children,
  onClick,
}: {
  label: string;
  active: boolean;
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
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
