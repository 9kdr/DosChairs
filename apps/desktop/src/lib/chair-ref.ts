/**
 * Shelf-to-prompt drag contract (issue #199): one MIME type, one payload
 * shape, one marquee-vs-drag rule, shared by the shelf cards that write
 * the drag and the chat prompt that reads it.
 */

/** DataTransfer type for a dragged chair ref (an asset, task, piece, clip, or plan chip). */
export const CHAIR_REF = "application/x-chair-ref";

export type ChairRef = {
  /**
   * What the chip points at: a shelf asset, a task, a piece, footage on
   * the timeline (`clip`), or a plan board item (`plan`). The @ picker
   * writes all five; shelf drags write the first three.
   */
  kind: "asset" | "task" | "piece" | "clip" | "plan";
  id: string;
  label: string;
};

/**
 * A press on a selected, draggable card starts a native drag; anything
 * else (unselected cards, empty shelf space) may start a marquee. The
 * shelf sets `draggable` on exactly these cards, and the marquee handler
 * yields to exactly these cards, so the two can never drift apart.
 */
export function pressStartsDrag(card: { selected: boolean; draggable: boolean }): boolean {
  return card.selected && card.draggable;
}

/** Shelf side: one ref writes a bare object, a group writes an array. */
export function encodeChairRefs(refs: ChairRef[]): string {
  return JSON.stringify(refs.length === 1 ? refs[0] : refs);
}

const CHAIR_KINDS: ReadonlySet<string> = new Set(["asset", "task", "piece", "clip", "plan"]);

function parseChairRef(parsed: unknown): ChairRef | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { kind?: unknown; id?: unknown; label?: unknown };
  if (typeof record.kind !== "string" || !CHAIR_KINDS.has(record.kind)) return null;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.label !== "string" || record.label.length === 0) return null;
  return { kind: record.kind as ChairRef["kind"], id: record.id, label: record.label };
}

/** Prompt side: read back what the shelf wrote; malformed entries drop. */
export function decodeChairRefs(raw: string | null | undefined): ChairRef[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.flatMap((record) => {
    const ref = parseChairRef(record);
    return ref ? [ref] : [];
  });
}

/** Minimal DataTransfer surface the codec needs (structural, DOM-free). */
export type ChairRefTransfer = {
  setData: (type: string, data: string) => void;
  getData: (type: string) => string;
  readonly types: readonly string[];
  effectAllowed: string;
};

/** Shelf side: stamp the refs onto an outgoing drag. */
export function writeChairRefs(
  transfer: Pick<ChairRefTransfer, "setData" | "effectAllowed">,
  refs: ChairRef[],
): void {
  transfer.setData(CHAIR_REF, encodeChairRefs(refs));
  transfer.effectAllowed = "copy";
}

/** Prompt side: does an incoming drag carry chair refs? */
export function acceptsChairRef(transfer: Pick<ChairRefTransfer, "types">): boolean {
  return Array.from(transfer.types).includes(CHAIR_REF);
}

/** Prompt side: read the refs off a drop. */
export function readChairRefs(transfer: Pick<ChairRefTransfer, "getData">): ChairRef[] {
  return decodeChairRefs(transfer.getData(CHAIR_REF));
}
