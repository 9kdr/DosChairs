import { Grid2x2Icon, Grid3x3Icon, LayoutGridIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  GRID_SIZE_LAYOUT,
  GRID_SIZE_MAX,
  type GridSize,
} from "./grid-size";

const SIZE_ICONS = [Grid3x3Icon, LayoutGridIcon, Grid2x2Icon, SquareIcon] as const;

type GridSizeToggleProps = {
  value: GridSize;
  onChange: (size: GridSize) => void;
  /** Highest snap still distinct at this width. Defaults to Huge. */
  max?: GridSize;
  className?: string;
};

/**
 * Card density as icon stops in a pill: dense on the left, huge on
 * the right. One stop per snap that still changes the column count.
 */
export function GridSizeToggle({
  value,
  onChange,
  max = GRID_SIZE_MAX,
  className,
}: GridSizeToggleProps) {
  const stops: GridSize[] = ([0, 1, 2, 3] as GridSize[]).filter(
    (size) => size <= max,
  );
  return (
    <div
      role="group"
      aria-label="Project card size"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full bg-card p-1",
        className,
      )}
    >
      {stops.map((size) => {
        const Icon = SIZE_ICONS[size];
        const label = GRID_SIZE_LAYOUT[size].label;
        const active = size === Math.min(value, max);
        return (
          <Button
            key={size}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            title={label}
            aria-pressed={active}
            onClick={() => onChange(size)}
            className={cn(
              "rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
              active && "bg-foreground/[0.1] text-foreground",
            )}
          >
            <Icon />
          </Button>
        );
      })}
    </div>
  );
}
