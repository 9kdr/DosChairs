/**
 * Shelf-to-prompt drag contract (issue #199): one MIME type, one payload
 * shape, one marquee-vs-drag rule, shared by the shelf cards that write
 * the drag and the chat prompt that reads it.
 */

/** DataTransfer type for a dragged chair ref (asset, task, or piece chip). */
export const CHAIR_REF = "application/x-chair-ref";

export type ChairRef = {
  kind: "asset" | "task" | "piece";
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

function parseChairRef(parsed: unknown): ChairRef | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { kind?: unknown; id?: unknown; label?: unknown };
  if (record.kind !== "asset" && record.kind !== "task" && record.kind !== "piece") return null;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.label !== "string" || record.label.length === 0) return null;
  return { kind: record.kind, id: record.id, label: record.label };
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

/** Drag tone for an outgoing shelf drag: media kind, folder, or piece. */
export type ShelfDragTone = "video" | "image" | "audio" | "folder" | "piece";

/** One row in an outgoing shelf drag. Folders ride as asset refs. */
export type ShelfDragItem = {
  id: string;
  label: string;
  tone: ShelfDragTone;
  refKind: "asset" | "piece";
};

/**
 * Group rule for a shelf drag: the held row alone, unless it sits inside a
 * multi-select — then every selected row rides, each with its own ref kind.
 */
export function dragItemsFor(
  chosen: readonly string[],
  assets: readonly { id: string; name: string; kind: "video" | "image" | "audio" }[],
  folders: readonly { id: string; name: string }[],
  pieces: readonly { id: string; name: string }[],
  id: string,
  label: string,
  tone: ShelfDragTone,
): ShelfDragItem[] {
  const single: ShelfDragItem = {
    id,
    label,
    tone,
    refKind: tone === "piece" ? "piece" : "asset",
  };
  if (!chosen.includes(id) || chosen.length < 2) return [single];
  const group: ShelfDragItem[] = [];
  for (const sid of chosen) {
    const asset = assets.find((item) => item.id === sid);
    if (asset) {
      group.push({ id: sid, label: asset.name, tone: asset.kind, refKind: "asset" });
      continue;
    }
    const folderItem = folders.find((item) => item.id === sid);
    if (folderItem) {
      group.push({ id: sid, label: folderItem.name, tone: "folder", refKind: "asset" });
      continue;
    }
    const piece = pieces.find((item) => item.id === sid);
    if (piece) group.push({ id: sid, label: piece.name, tone: "piece", refKind: "piece" });
  }
  return group.length > 0 ? group : [single];
}
