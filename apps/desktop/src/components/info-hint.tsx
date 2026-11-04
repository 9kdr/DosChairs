import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A one-sentence explanation behind a small info icon, for copy that is
 * useful but not needed at a glance. Sits right after the label it
 * explains. Never carries an error: actionable errors stay visible.
 */
export function InfoHint({
  text,
  label = "More info",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
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
            className={cn("text-muted-foreground", className)}
          />
        }
      >
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}
