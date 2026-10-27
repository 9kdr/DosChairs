import {
  PillSnapSlider,
  type PillSnapApproach,
} from "@/components/ui/pill-snap-slider";
import {
  GRID_SIZE_LAYOUT,
  GRID_SIZE_MAX,
  type GridSize,
} from "./grid-size";

export {
  GRID_SIZE_LAYOUT,
  GRID_SIZE_MAX,
  columnsForWidth,
  maxGridSizeForWidth,
  readStoredGridSize,
  writeStoredGridSize,
  type GridSize,
} from "./grid-size";

export type GridApproach = {
  committed: GridSize;
  toward: GridSize | null;
  heading: -1 | 0 | 1;
  intensity: number;
  dragging: boolean;
};

type GridSizeSliderProps = {
  value: GridSize;
  onChange: (size: GridSize) => void;
  onApproach?: (approach: GridApproach) => void;
  /** Highest snap still distinct at this width. Defaults to Huge. */
  max?: GridSize;
  className?: string;
};

function toGridApproach(approach: PillSnapApproach): GridApproach {
  return {
    committed: approach.committed as GridSize,
    toward: approach.toward == null ? null : (approach.toward as GridSize),
    heading: approach.heading,
    intensity: approach.intensity,
    dragging: approach.dragging,
  };
}

export function GridSizeSlider({
  value,
  onChange,
  onApproach,
  max = GRID_SIZE_MAX,
  className,
}: GridSizeSliderProps) {
  return (
    <PillSnapSlider
      value={Math.min(value, max)}
      min={0}
      max={max}
      step={1}
      className={className}
      onChange={(next) => onChange(next as GridSize)}
      onApproach={
        onApproach
          ? (approach) => onApproach(toGridApproach(approach))
          : undefined
      }
      getAriaLabel={(v) =>
        `Project card size, ${GRID_SIZE_LAYOUT[v as GridSize].label}`
      }
      getAriaValueText={(v) => GRID_SIZE_LAYOUT[v as GridSize].label}
    />
  );
}
