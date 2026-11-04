import { PuzzleIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { writeChairRefs } from "@/lib/chair-ref";
import type { FetchFn } from "@/lib/services/client";
import { cn } from "@/lib/utils";
import { fetchPieces, type PieceInfo } from "./pieces-api";

/** A piece the brief points at: kept small, sent with generate as { id, label }. */
export type Reference = { id: string; label: string; kind: string };

export function referenceOf(piece: PieceInfo): Reference {
  return { id: piece.id, label: piece.name, kind: piece.kind };
}

/** The chips above the brief: one per referenced piece, each removable. */
export function ReferenceChips({ refs, onRemove }: { refs: Reference[]; onRemove: (id: string) => void }) {
  if (refs.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Referenced pieces">
      {refs.map((ref) => (
        <li
          key={ref.id}
          className="flex max-w-full items-center gap-1.5 rounded-full bg-amber-300/[0.08] py-0.5 ps-2.5 pe-1 text-xs text-amber-100 ring-1 ring-amber-300/25 ring-inset"
        >
          <PuzzleIcon className="size-3 shrink-0 text-amber-300/80" aria-hidden="true" />
          <span className="min-w-0 truncate">@{ref.label}</span>
          <span className="shrink-0 whitespace-nowrap text-amber-200/50">{ref.kind.replace("_", " ")}</span>
          <Button type="button" size="icon-xs" variant="ghost" className="size-5" aria-label={`Remove ${ref.label}`} onClick={() => onRemove(ref.id)}>
            <XIcon className="size-3" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A small shelf of pieces inside the Effect Maker. The project shelf sits on
 * another screen, so this one carries the same drag contract (a chair ref of
 * kind "piece") and also adds on click, for keyboard users.
 */
export function PieceTray({
  onAdd,
  disabled,
  fetchFn,
}: {
  onAdd: (piece: PieceInfo) => void;
  disabled?: boolean;
  fetchFn?: FetchFn;
}) {
  const [pieces, setPieces] = useState<PieceInfo[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchPieces("", { limit: 8, signal: controller.signal, fetchFn })
      .then(setPieces)
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === "AbortError")) setPieces([]);
      });
    return () => controller.abort();
  }, [fetchFn]);

  return (
    <div className="flex flex-col gap-1.5">
      {pieces === null ? (
        <p className="text-xs text-neutral-600">Loading pieces…</p>
      ) : pieces.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Pieces to reference">
          {pieces.map((piece) => (
            <li key={piece.id}>
              <button
                type="button"
                draggable={!disabled}
                disabled={disabled}
                title={piece.summary}
                onClick={() => onAdd(piece)}
                onDragStart={(event) => writeChairRefs(event.dataTransfer, [{ kind: "piece", id: piece.id, label: piece.name }])}
                className={cn(
                  "flex max-w-full cursor-grab items-center gap-1.5 whitespace-nowrap rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-neutral-300 ring-1 ring-white/10 transition-colors",
                  "hover:bg-white/[0.1] hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:opacity-50",
                )}
              >
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", piece.source === "user" ? "bg-amber-300" : "bg-neutral-500")}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">{piece.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
