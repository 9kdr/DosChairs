import { describe, expect, it } from "vitest";
import {
  columnsForWidth,
  DEFAULT_GRID_SIZE,
  densestColumnsForWidth,
  GRID_SIZE_MAX,
  maxGridSizeForWidth,
  type GridSize,
} from "./grid-size";

describe("columnsForWidth", () => {
  it("keeps all four snaps distinct on a wide shell", () => {
    const cols = ([0, 1, 2, 3] as GridSize[]).map((size) =>
      columnsForWidth(1024, size),
    );
    expect(cols).toEqual([4, 3, 2, 1]);
    expect(new Set(cols).size).toBe(GRID_SIZE_MAX + 1);
  });

  it("caps densest packing at four columns however wide the shell", () => {
    expect(densestColumnsForWidth(1024)).toBe(4);
    expect(densestColumnsForWidth(1920)).toBe(4);
    expect(columnsForWidth(1920, 0)).toBe(4);
  });

  it("defaults to two columns at 520 and four at 1440", () => {
    // Grid widths after the shell's own padding: 520 - 48, and the
    // max-w-5xl container.
    expect(columnsForWidth(472, DEFAULT_GRID_SIZE)).toBe(2);
    expect(columnsForWidth(1024, DEFAULT_GRID_SIZE)).toBe(4);
  });

  it("scales densest columns with a narrower ratio", () => {
    const cols = ([0, 1, 2, 3] as GridSize[]).map((size) =>
      columnsForWidth(700, size),
    );
    expect(cols[0]).toBeGreaterThanOrEqual(cols[1]!);
    expect(cols[1]).toBeGreaterThanOrEqual(cols[2]!);
    expect(cols[2]).toBeGreaterThanOrEqual(cols[3]!);
    expect(cols[0]).toBeGreaterThan(cols[3]!);
  });
});

describe("maxGridSizeForWidth", () => {
  it("drops Huge when Large and Huge would share one column", () => {
    // densest 3 → stops 0..2 map to 3,2,1 — size 3 would also be 1.
    expect(densestColumnsForWidth(640)).toBe(3);
    expect(maxGridSizeForWidth(640)).toBe(2);
    const max = maxGridSizeForWidth(640);
    const cols = Array.from({ length: max + 1 }, (_, size) =>
      columnsForWidth(640, size as GridSize),
    );
    expect(new Set(cols).size).toBe(cols.length);
  });

  it("keeps all four snaps once four dense cards fit", () => {
    expect(densestColumnsForWidth(720)).toBe(4);
    expect(maxGridSizeForWidth(720)).toBe(3);
    const cols = ([0, 1, 2, 3] as GridSize[]).map((size) =>
      columnsForWidth(720, size),
    );
    expect(cols).toEqual([4, 3, 2, 1]);
  });

  it("never leaves duplicate column counts across allowed snaps", () => {
    for (const width of [400, 480, 560, 640, 700, 720, 800, 1024]) {
      const max = maxGridSizeForWidth(width);
      const cols = Array.from({ length: max + 1 }, (_, size) =>
        columnsForWidth(width, size as GridSize),
      );
      expect(new Set(cols).size).toBe(cols.length);
    }
  });
});
