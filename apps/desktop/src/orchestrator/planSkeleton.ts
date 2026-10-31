export type MdBlock = { start: number; end: number };

/**
 * Line ranges of the document's blocks, in order, blank lines excluded.
 * The single source of truth for both rendering and keyboard navigation,
 * so the two can never disagree about where a block starts or ends.
 */
export function splitMarkdownBlocks(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  const isBlank = (line: string) => line.trim() === "";
  const isHeading = (line: string) => /^(#{1,3})\s+/.test(line);
  const isQuote = (line: string) => /^\s*>\s?/.test(line);
  const isBullet = (line: string) => /^\s*([-*])\s+/.test(line);
  const isOrdered = (line: string) => /^\s*\d+\.\s+/.test(line);
  let index = 0;
  while (index < lines.length) {
    if (isBlank(lines[index] ?? "")) {
      index += 1;
      continue;
    }
    const start = index;
    const line = lines[index] ?? "";
    if (isHeading(line)) {
      index += 1;
    } else if (isQuote(line)) {
      while (index < lines.length && isQuote(lines[index] ?? "")) index += 1;
    } else if (isBullet(line)) {
      while (index < lines.length && isBullet(lines[index] ?? "")) index += 1;
    } else if (isOrdered(line)) {
      while (index < lines.length && isOrdered(lines[index] ?? "")) index += 1;
    } else {
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (
          current.trim() === "" ||
          isHeading(current) ||
          isQuote(current) ||
          isBullet(current) ||
          isOrdered(current)
        ) {
          break;
        }
        index += 1;
      }
    }
    blocks.push({ start, end: index });
  }
  return blocks;
}

export type SkeletonGroupKind = "h1" | "h2" | "h3" | "quote" | "list" | "text";

export type SkeletonGroup = {
  kind: SkeletonGroupKind;
  /** Bar widths in order, as CSS percentages. */
  widths: string[];
};

// Characters per wrapped text-sm line in the open plan card, calibrated
// against the Brief (200 chars over 3 lines, 150 over 2). A rough guide,
// not a measure: the real text sits underneath and holds the layout.
const CHARS_PER_LINE = 88;
// A last line shorter than this still reads as a line, not a speck.
const MIN_LAST_WIDTH = 30;
// A long doc shows at most this many bars: the skeleton is a hint.
const MAX_BARS_PER_BLOCK = 6;
const MAX_BARS_TOTAL = 42;

/** Full bars plus one partial last bar from the leftover characters. */
function barsForLength(length: number): string[] {
  const capped = Math.min(length, CHARS_PER_LINE * MAX_BARS_PER_BLOCK);
  const widths = Array<string>(Math.floor(capped / CHARS_PER_LINE)).fill("100%");
  const rest = capped % CHARS_PER_LINE;
  if (rest > 0) {
    widths.push(`${Math.max(MIN_LAST_WIDTH, Math.round((rest / CHARS_PER_LINE) * 100))}%`);
  }
  return widths;
}

/**
 * One bar group per paragraph of the document, so the loading skeleton
 * mirrors the real text it covers: separated groups, varying bar counts
 * and widths, headings visually distinct. Deterministic in the text.
 */
export function skeletonGroupsForText(text: string): SkeletonGroup[] {
  if (!text.trim()) return [{ kind: "text", widths: ["38%"] }];
  const lines = text.split("\n");
  const groups: SkeletonGroup[] = [];
  let total = 0;
  for (const block of splitMarkdownBlocks(text)) {
    if (total >= MAX_BARS_TOTAL) break;
    const first = lines[block.start] ?? "";
    const heading = first.match(/^(#{1,3})\s+/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const length = first.trim().length;
      groups.push({
        kind: level === 1 ? "h1" : level === 2 ? "h2" : "h3",
        widths: [`${Math.min(72, Math.max(24, Math.round((length / CHARS_PER_LINE) * 100)))}%`],
      });
      total += 1;
      continue;
    }
    const kind: SkeletonGroupKind = /^\s*>\s?/.test(first)
      ? "quote"
      : /^\s*([-*]|\d+\.)\s+/.test(first)
        ? "list"
        : "text";
    const widths = lines
      .slice(block.start, block.end)
      .flatMap((line) => barsForLength(line.trim().length))
      .slice(0, MAX_BARS_PER_BLOCK);
    groups.push({ kind, widths });
    total += widths.length;
  }
  return groups;
}
