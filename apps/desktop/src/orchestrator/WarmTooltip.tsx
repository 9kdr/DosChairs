import type { ReactElement, ReactNode } from "react";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const popupClass = cn(
  "rounded-full border-transparent bg-[#1a1a1a] text-neutral-100 shadow-raised ring-1 ring-white/8",
  "transition-[width,height,scale,opacity,translate] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)]",
  "data-starting-style:translate-y-1 data-ending-style:translate-y-1",
  "before:hidden",
  "motion-reduce:transition-none motion-reduce:data-starting-style:translate-y-0 motion-reduce:data-ending-style:translate-y-0",
);

/**
 * Shared delay for a cluster of tips. The first waits, then the next opens
 * at once while the group is still warm.
 */
export function WarmTooltipGroup({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delay={400} closeDelay={80} timeout={300}>
      {children}
    </TooltipProvider>
  );
}

export function WarmTooltip({
  label,
  side = "top",
  render,
}: {
  label: ReactNode;
  side?: "top" | "bottom";
  render: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger closeOnClick render={render} />
      <TooltipPopup className={popupClass} side={side} sideOffset={8}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}
