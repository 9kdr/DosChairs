import { BlocksIcon, ChevronLeftIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DitherArt } from "@/components/dither-art";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyArt,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { writeChairRefs } from "@/lib/chair-ref";
import { cn } from "@/lib/utils";
import type { ChangesetItem } from "@chair/timeline-ir";
import type { PieceLanding } from "./effect-model";
import { EffectMaker, type ClipChoice } from "./EffectMaker";
import {
  fetchPieces,
  PIECE_KIND_LABEL,
  PiecesError,
  type PieceInfo,
  type PieceKind,
  type PiecesFailureKind,
} from "./pieces-api";

export type PiecesShelfProps = {
  className?: string;
  /** Clips an effect-kind piece can land on. Empty on Home: the editor still drafts. */
  clips?: ClipChoice[];
  onApplyPiece?: (item: ChangesetItem) => string | null;
  onUndoPiece?: (itemId: string) => void;
  onOpenHistory?: () => void;
  refusal?: string | null;
  landings?: Record<string, PieceLanding>;
  onRecordLanding?: (specId: string, landing: PieceLanding) => void;
  /**
   * Open the Effect Maker on a new piece instead of the list. Page
   * context: the page owns Back, so the editor hides its own.
   */
  startOnNewPiece?: boolean;
};

type KindFilter = "all" | PieceKind;

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "macro", label: "Macros" },
  { id: "effect", label: "Effects" },
  { id: "motion", label: "Motion" },
  { id: "sound", label: "Sound" },
  { id: "look", label: "Looks" },
];

/** The real reason a pieces load failed, in plain words. */
function failureText(failure: { kind: PiecesFailureKind; reason: string }): string {
  return failure.kind === "offline"
    ? `${failure.reason}. Start the agent with mise run dev:agent, then check again.`
    : failure.reason;
}

/**
 * The one Pieces shelf: every macro, effect, motion, sound, and look
 * piece the agent knows, each with its kind. Opening or creating an
 * effect-kind piece shows the Effect Maker editor; other kinds expand
 * in place with their summary and controls. Rows drag out as piece
 * refs for the brief.
 */
export function PiecesShelf({
  className,
  clips = [],
  onApplyPiece,
  onUndoPiece,
  onOpenHistory,
  refusal = null,
  landings,
  onRecordLanding,
  startOnNewPiece = false,
}: PiecesShelfProps) {
  /** The last good list; a failed reload never clears it. */
  const [pieces, setPieces] = useState<PieceInfo[] | null>(null);
  const [failure, setFailure] = useState<{ kind: PiecesFailureKind; reason: string } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Effect-kind piece open in the editor, or blank for a new piece. */
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(() =>
    startOnNewPiece ? { id: "new", name: "New piece" } : null,
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

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      (pieces ?? []).filter(
        (piece) =>
          (kindFilter === "all" || piece.kind === kindFilter) &&
          (needle === "" || piece.name.toLowerCase().includes(needle)),
      ),
    [pieces, kindFilter, needle],
  );

  if (editing) {
    return (
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-3", className)}>
        <div className="flex shrink-0 items-center gap-2">
          {startOnNewPiece ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Back to pieces"
              onClick={() => setEditing(null)}
            >
              <ChevronLeftIcon />
              Pieces
            </Button>
          )}
          <h2 className="min-w-0 truncate text-sm font-medium text-neutral-100">
            {editing.name}
          </h2>
          <span className="shrink-0 text-xs text-muted-foreground">Effect</span>
        </div>
        <EffectMaker
          clips={clips}
          onApply={onApplyPiece ?? (() => null)}
          onUndo={onUndoPiece ?? (() => undefined)}
          onOpenHistory={onOpenHistory ?? (() => undefined)}
          refusal={refusal}
          landings={landings}
          onRecordLanding={onRecordLanding}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-3", className)}>
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-white/[0.06]">
            <BlocksIcon className="size-4 text-neutral-300" aria-hidden="true" />
          </span>
          <h2 className="text-sm font-medium text-neutral-100">Pieces</h2>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            title="Draft a new effect piece"
            onClick={() => setEditing({ id: "new", name: "New piece" })}
          >
            <PlusIcon />
            New piece
          </Button>
        </div>
        <Tabs
          value={kindFilter}
          onValueChange={(value) => setKindFilter(value as KindFilter)}
          className="min-w-0"
        >
          <div className="border-b border-white/[0.06]">
            <TabsList
              variant="underline"
              size="sm"
              className="max-w-full justify-start overflow-x-auto"
            >
              {KIND_FILTERS.map((item) => (
                <TabsTab key={item.id} value={item.id} className="shrink-0">
                  {item.label}
                </TabsTab>
              ))}
            </TabsList>
          </div>
        </Tabs>
      </div>

      <div className="shrink-0">
        <Input
          type="search"
          size="sm"
          value={query}
          placeholder="Search pieces"
          aria-label="Search pieces"
          onChange={(event) => setQuery(event.target.value)}
          className="border-transparent bg-white/[0.04] dark:bg-white/[0.04]"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {failure && pieces !== null && pieces.length > 0 ? (
          <p className="px-1 pb-2 text-xs leading-5 text-muted-foreground">
            Couldn&apos;t refresh pieces — {failureText(failure)}. Showing the last good
            list.
          </p>
        ) : null}
        {pieces === null ? (
          failure ? (
            <div className="flex flex-col items-start gap-2 rounded-2xl bg-white/[0.03] px-5 py-6">
              <h3 className="text-sm font-medium text-neutral-200">Couldn&apos;t load pieces</h3>
              <p className="text-sm leading-6 text-neutral-400">{failureText(failure!)}</p>
              <Button type="button" size="sm" variant="outline" onClick={load}>
                Check again
              </Button>
            </div>
          ) : (
            <p className="px-1 py-2 text-sm text-neutral-400">Loading pieces…</p>
          )
        ) : pieces.length === 0 ? (
          failure ? (
            <div className="flex flex-col items-start gap-2 rounded-2xl bg-white/[0.03] px-5 py-6">
              <h3 className="text-sm font-medium text-neutral-200">Couldn&apos;t load pieces</h3>
              <p className="text-sm leading-6 text-neutral-400">{failureText(failure!)}</p>
              <Button type="button" size="sm" variant="outline" onClick={load}>
                Check again
              </Button>
            </div>
          ) : (
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyArt>
                  <DitherArt seed={5} />
                </EmptyArt>
                <EmptyTitle>No pieces yet</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" size="sm" variant="outline" onClick={load}>
                  Check again
                </Button>
              </EmptyContent>
            </Empty>
          )
        ) : visible.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">Nothing matches.</p>
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label="Pieces">
            {visible.map((piece) => (
              <PieceRow
                key={piece.id}
                piece={piece}
                expanded={expandedId === piece.id}
                onToggle={() =>
                  setExpandedId((current) => (current === piece.id ? null : piece.id))
                }
                onOpen={() => {
                  if (piece.kind === "effect") setEditing({ id: piece.id, name: piece.name });
                  else setExpandedId(piece.id);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PieceRow({
  piece,
  expanded,
  onToggle,
  onOpen,
}: {
  piece: PieceInfo;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <li
      className={cn(
        "group rounded-2xl bg-white/[0.03]",
        expanded && "bg-white/[0.06]",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        draggable
        title={piece.summary || piece.name}
        onClick={onToggle}
        onDoubleClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter") onOpen();
          else if (event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        onDragStart={(event) =>
          writeChairRefs(event.dataTransfer, [{ kind: "piece", id: piece.id, label: piece.name }])
        }
        className="flex w-full cursor-grab items-center gap-2.5 rounded-2xl px-3 py-2 text-left outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            piece.source === "user" ? "bg-amber-300" : "bg-neutral-500",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{piece.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {PIECE_KIND_LABEL[piece.kind]}
        </span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Open ${piece.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
        >
          Open
        </Button>
      </div>
      {expanded ? (
        <div className="px-3 pb-3">
          <p className="text-xs leading-5 text-neutral-400">
            {piece.summary || "No description yet."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {piece.controls.length === 0
              ? "No published controls — drag it into the brief to use it."
              : `${piece.controls.length} control${piece.controls.length === 1 ? "" : "s"}: ${piece.controls
                  .slice(0, 4)
                  .map((control) => control.name)
                  .join(", ")}${piece.controls.length > 4 ? "…" : ""}`}
          </p>
        </div>
      ) : null}
    </li>
  );
}
