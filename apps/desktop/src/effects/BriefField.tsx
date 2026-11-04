import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
  AutocompletePrimitive,
  AutocompleteStatus,
} from "@/components/ui/autocomplete";
import { Textarea } from "@/components/ui/textarea";
import type { FetchFn } from "@/lib/services/client";
import { findMention, insertMention } from "./mentions";
import { fetchPieces, type PieceInfo } from "./pieces-api";

type Listing = { query: string; pieces: PieceInfo[]; failed: boolean };

function KindLine({ piece }: { piece: PieceInfo }) {
  const count = piece.controls.length;
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-neutral-500">
      {piece.source === "user" ? (
        <span className="size-1.5 rounded-full bg-amber-300" aria-hidden="true" />
      ) : null}
      {piece.kind.replace("_", " ")} · {count}
    </span>
  );
}

/**
 * The brief box. Typing `@` opens a menu of the editor's macros and the
 * built-in pieces; picking one swaps the typed text for a tag and adds a
 * reference chip (the parent owns the chips). Everything else is a plain
 * textarea, so Cmd/Ctrl+Enter still generates.
 */
export function BriefField({
  value,
  onChange,
  onPick,
  onKeyDown,
  disabled,
  fetchFn,
}: {
  value: string;
  onChange: (value: string) => void;
  onPick: (piece: PieceInfo) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled?: boolean;
  fetchFn?: FetchFn;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);

  const found = useMemo(() => findMention(value, caret), [value, caret]);
  const mention = found && found.start !== dismissed && !disabled ? found : null;
  const query = mention?.query ?? null;

  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        fetchPieces(query, { signal: controller.signal, fetchFn })
          .then((pieces) => setListing({ query, pieces, failed: false }))
          .catch((error: unknown) => {
            if (error instanceof Error && error.name === "AbortError") return;
            setListing({ query, pieces: [], failed: true });
          });
      },
      query ? 120 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, fetchFn]);

  const pieces = listing?.pieces ?? [];
  const settled = listing !== null && listing.query === query;

  const readCaret = () => setCaret(area.current?.selectionStart ?? 0);

  const pick = (piece: PieceInfo) => {
    if (!mention) return;
    const next = insertMention(value, mention, piece.name);
    onChange(next.text);
    onPick(piece);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <Autocomplete
      items={pieces}
      mode="none"
      filter={null}
      autoHighlight
      disabled={disabled}
      value={value}
      itemToStringValue={(piece: PieceInfo) => piece.id}
      open={mention !== null}
      onOpenChange={(open) => {
        if (!open && mention) setDismissed(mention.start);
      }}
      onValueChange={(next, details) => {
        if (details.reason === "item-press") {
          const piece = pieces.find((entry) => entry.id === next);
          if (piece) pick(piece);
          return;
        }
        if (details.reason === "input-change") {
          setDismissed(null);
          onChange(next);
        }
      }}
    >
      <AutocompletePrimitive.Input
        render={
          <Textarea
            ref={area}
            size="sm"
            placeholder="Describe the look, or type @ to bring in one of your macros…"
            aria-label="Describe the effect"
            onKeyDown={onKeyDown}
            onKeyUp={readCaret}
            onClick={readCaret}
            onInput={readCaret}
          />
        }
      />
      <AutocompletePopup className="w-(--anchor-width) overflow-hidden" aria-label="Pieces you can reference">
        <AutocompleteStatus className="sr-only">
          {settled ? `${pieces.length} pieces` : "Looking for pieces"}
        </AutocompleteStatus>
        <AutocompleteEmpty>
          {!settled ? "Looking…" : listing?.failed ? "The agent is not running, so pieces cannot load." : "No piece matches that."}
        </AutocompleteEmpty>
        <AutocompleteList className="w-(--anchor-width)">
          {(piece: PieceInfo) => (
            <AutocompleteItem key={piece.id} value={piece} className="justify-between gap-3" title={piece.summary}>
              <span className="min-w-0 truncate">{piece.name}</span>
              <KindLine piece={piece} />
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  );
}
