export const GRID_SIZE_MAX = 3;

export type GridSize = 0 | 1 | 2 | 3;

const GRID_SIZE_STORAGE_KEY = "chair.home.gridSize";

export function isGridSize(value: unknown): value is GridSize {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/** Last size the person picked on the home grid slider. */
export function readStoredGridSize(fallback: GridSize = 1): GridSize {
  try {
    const raw = localStorage.getItem(GRID_SIZE_STORAGE_KEY);
    if (raw == null) return fallback;
    const parsed = Number(raw);
    if (isGridSize(parsed)) return parsed;
  } catch {
    // private mode / unavailable storage
  }
  return fallback;
}

export function writeStoredGridSize(size: GridSize): void {
  try {
    localStorage.setItem(GRID_SIZE_STORAGE_KEY, String(size));
  } catch {
    // private mode / unavailable storage
  }
}

export const GRID_SIZE_LAYOUT: Record<
  GridSize,
  { gapPx: number; gapClass: string; label: string }
> = {
  0: { gapPx: 16, gapClass: "gap-4", label: "Dense" },
  1: { gapPx: 20, gapClass: "gap-5", label: "Comfortable" },
  2: { gapPx: 24, gapClass: "gap-6", label: "Large" },
  3: { gapPx: 28, gapClass: "gap-7", label: "Huge" },
};

/** Smallest card width used to measure how many columns the shell can hold. */
export const GRID_DENSE_CARD_MIN_PX = 168;

/** Gap used when measuring densest packing — always the dense stop. */
const DENSE_GAP_PX = GRID_SIZE_LAYOUT[0].gapPx;

/**
 * How many dense cards fit across `width`.
 * Measured with the dense gap so densest does not drift as the snap changes.
 */
export function densestColumnsForWidth(width: number): number {
  if (width <= 0) return 1;
  return Math.max(
    1,
    Math.floor(
      (width + DENSE_GAP_PX) / (GRID_DENSE_CARD_MIN_PX + DENSE_GAP_PX),
    ),
  );
}

/**
 * Highest snap that still changes the column count.
 * Below ~4 dense cards, Huge (and sometimes Large) would collapse onto
 * the same single-column layout — drop those stops so the bar has no twin.
 */
export function maxGridSizeForWidth(width: number): GridSize {
  const densest = densestColumnsForWidth(width);
  return Math.min(GRID_SIZE_MAX, Math.max(0, densest - 1)) as GridSize;
}

/**
 * Columns for a snap at the current shell width.
 * Dense (0) uses every column that fits; each step up drops one column
 * until a single card.
 */
export function columnsForWidth(width: number, size: GridSize): number {
  const densest = densestColumnsForWidth(width);
  return Math.max(1, densest - size);
}
