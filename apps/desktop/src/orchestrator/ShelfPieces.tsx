import { BlocksIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { writeChairRefs } from "@/lib/chair-ref";
import { cn } from "@/lib/utils";
import {
  fetchPieces,
  PIECE_KIND_LABEL,
  PiecesError,
  type PieceInfo,
  type PiecesFailureKind,
} from "../effects/pieces-api";

/** The real reason a pieces load failed, in plain words. */
function failureText(failure: { kind: PiecesFailureKind; reason: string }): string {
  return failure.kind === "offline"
    ? `${failure.reason}. Start the agent with mise run dev:agent, then check again.`
    : failure.reason;
}

/**
 * Pieces as a Shelf group under the assets: the agent's piece listing in
 * compact rows. Rows drag into the command bar as piece refs, exactly like
 * the full shelf; Create opens the Effect Maker as a full page.
 */
export function ShelfPieces({
  onCreate,
  className,
}: {
  onCreate: () => void;
  className?: string;
}) {
  /** The last good list; a failed reload never clears it. */
  const [pieces, setPieces] = useState<PieceInfo[] | null>(null);
  const [failure, setFailure] = useState<{ kind: PiecesFailureKind; reason: string } | null>(
    null,
  );

  const load = () => {
    setFailure(null);
    const controller = new AbortController();
    fetchPieces("", { limit: 50, signal: controller.signal })
      .then((found) => {
        setPieces(found);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setFailure({
          kind: error instanceof PiecesError ? error.kind : "refused",
          reason: error instanceof Error ? error.message : "pieces failed to load",
        });
      });
    return () => controller.abort();
  };

  useEffect(load, []);

  return (
    <section
      aria-label="Pieces"
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-card bg-card p-4 text-neutral-100",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-2">
        <BlocksIcon className="size-4 shrink-0 text-neutral-400" aria-hidden="true" />
        <h2 className="text-sm font-medium text-neutral-100">Pieces</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          title="Open the Effect Maker"
          onClick={onCreate}
        >
          <PlusIcon />
          Create
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {pieces === null ? (
          failure ? (
            <div className="flex flex-col items-start gap-2 px-1 py-1">
              <p className="text-sm leading-6 text-neutral-400">{failureText(failure)}</p>
              <Button type="button" size="sm" variant="ghost" onClick={load}>
                Check again
              </Button>
            </div>
          ) : (
            <p className="px-1 py-1 text-sm text-muted-foreground">Loading pieces…</p>
          )
        ) : pieces.length === 0 ? (
          failure ? (
            <div className="flex flex-col items-start gap-2 px-1 py-1">
              <p className="text-sm leading-6 text-neutral-400">{failureText(failure)}</p>
              <Button type="button" size="sm" variant="ghost" onClick={load}>
                Check again
              </Button>
            </div>
          ) : (
            <p className="px-1 py-1 text-sm text-muted-foreground">No pieces yet.</p>
          )
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label="Pieces">
            {pieces.map((piece) => (
              <li
                key={piece.id}
                draggable
                title={piece.summary || piece.name}
                onDragStart={(event) =>
                  writeChairRefs(event.dataTransfer, [
                    { kind: "piece", id: piece.id, label: piece.name },
                  ])
                }
                className="flex cursor-grab items-center gap-2 rounded-2xl bg-foreground/[0.03] px-3 py-2 active:cursor-grabbing"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                  {piece.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {PIECE_KIND_LABEL[piece.kind]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
