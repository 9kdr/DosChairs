import { Dialog } from "@base-ui/react/dialog";
import { HistoryIcon, KeyboardIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { fallbackNotice } from "./OpDiff";
import {
  HISTORY_SHORTCUTS,
  historyKeyAction,
  historyKeyAllowed,
  historyKeyNativeEnter,
  moveHistoryFocus,
} from "./history-keys";
import { clockTime, opLabel, type HistoryEntry } from "./store";

/** Who caused the apply: the agent on arrival, or the person by hand. */
export function HistoryActorBadge({ actor }: { actor: HistoryEntry["actor"] }) {
  return (
    <Badge variant={actor === "agent" ? "info" : "secondary"} size="sm">
      {actor === "agent" ? "Agent" : "You"}
    </Badge>
  );
}

/** The adapter fallback line, shared with the compact task card. */
export function HistoryFallbackLine({ entry }: { entry: HistoryEntry }) {
  const notice = fallbackNotice(entry);
  if (!notice) return null;
  return (
    <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-amber-300/[0.07] px-2 py-1 text-[11px] leading-4 text-amber-200/90 ring-1 ring-amber-300/20 ring-inset">
      <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-medium">Fallback — </span>
        {notice}
      </span>
    </p>
  );
}

/**
 * History as a bento card beside the running tasks, in the same
 * card treatment as `RunningTasks`. Each row shows what landed, who
 * did it, when, and the adapter fallback line when the item had one.
 * Undo applies at once onto a copy: u rewinds the last entry,
 * Shift+U rewinds to the focused entry. The agent's hand edits in the
 * editing app bypass this card — the app only sees what it applied.
 */
export function HistoryCard({
  entries,
  onUndoEntry,
  onUndoLast,
  className,
}: {
  entries: HistoryEntry[];
  onUndoEntry?: (entry: HistoryEntry) => void;
  onUndoLast?: () => void;
  className?: string;
}) {
  const [focusedIndex, setFocusedIndex] = useState(() =>
    entries.length > 0 ? entries.length - 1 : -1,
  );
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [helpOpen, setHelpOpen] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const focusEntry = (index: number) => {
    if (entries.length === 0) return;
    const clamped = moveHistoryFocus(entries.length, index, 0);
    setFocusedIndex(clamped);
    const id = entries[clamped]?.itemId;
    if (!id) return;
    const node = rowRefs.current.get(id);
    node?.focus({ preventScroll: true });
    node?.scrollIntoView({ block: "nearest" });
  };

  const setRowRef = (id: string) => (node: HTMLLIElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  };

  const toggleOpen = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!historyKeyAllowed(event.target)) return;
      const action = historyKeyAction(event);
      if (!action) return;
      if (action === "accept" || action === "reject") return;
      if (entries.length === 0) return;
      if (action === "help") {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      // Tabbing to a row button or the row itself sets the base:
      // the key acts where the person already is.
      let base = Math.min(focusedIndex, entries.length - 1);
      const active = document.activeElement;
      if (active instanceof Element) {
        const row = active.closest("[data-entry-id]");
        const id = row?.getAttribute("data-entry-id");
        if (id) {
          const found = entries.findIndex((entry) => entry.itemId === id);
          if (found >= 0) base = found;
        }
      }
      const focused = entries[base];
      if (!focused) return;
      switch (action) {
        case "next":
        case "prev":
          event.preventDefault();
          focusEntry(base + (action === "next" ? 1 : -1));
          break;
        case "undo":
          event.preventDefault();
          onUndoLast?.();
          break;
        case "undoHere":
          event.preventDefault();
          onUndoEntry?.(focused);
          break;
        case "toggle":
          if (historyKeyNativeEnter(event.target)) return;
          event.preventDefault();
          toggleOpen(focused.itemId);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <section
      aria-label="History"
      className={cn(
        "flex flex-col gap-1 rounded-card bg-card p-4 text-neutral-100",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        <HistoryIcon className="size-4 text-neutral-400" aria-hidden="true" />
        <h2 className="text-sm font-medium text-neutral-100">History</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {entries.length === 1 ? "1 entry" : `${entries.length} entries`}
        </span>
        <InfoHint text="Every apply lands on a copy." />
        {onUndoLast && entries.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto text-neutral-400 hover:text-neutral-100"
            title="Rewind the last entry (u)"
            onClick={() => onUndoLast()}
          >
            <Undo2Icon className="size-3.5" aria-hidden="true" />
            Undo
          </Button>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          Nothing applied yet.
        </p>
      ) : (
        <ol aria-label="History entries" className="flex min-h-0 flex-col">
          {entries.map((entry, index) => {
            const open = expandedIds.has(entry.itemId);
            return (
              <li
                key={entry.itemId}
                ref={setRowRef(entry.itemId)}
                data-entry-id={entry.itemId}
                tabIndex={0}
                onFocus={() => setFocusedIndex(index)}
                className={cn(
                  "flex items-start gap-3 rounded-xl border-t border-white/[0.06] px-1 py-3 outline-none transition-colors first:border-t-0 first:pt-1 last:pb-1",
                  index === focusedIndex && "bg-white/[0.05] ring-1 ring-lime-300/60 ring-inset",
                )}
              >
                <span className="w-7 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                  #{index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 truncate text-sm font-medium text-neutral-100">
                    <span className="truncate">
                      {opLabel(entry.op)}
                      {entry.targetId ? (
                        <span className="ml-2 font-normal text-muted-foreground">
                          {entry.targetId}
                        </span>
                      ) : null}
                    </span>
                    <HistoryActorBadge actor={entry.actor} />
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Applied {clockTime(entry.acceptedAt)} by {entry.acceptedBy}
                  </p>
                  <HistoryFallbackLine entry={entry} />
                  {open ? (
                    <div className="mt-1.5 rounded-xl bg-black/30 p-3">
                      <p className="truncate font-mono text-xs text-neutral-400">
                        {entry.itemId}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Rewinds with {opLabel(entry.inverse.op)}
                        {entry.inverse.targetId ? ` on ${entry.inverse.targetId}` : ""}
                        {entry.beatId ? <span> · step {entry.beatId}</span> : null}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-0.5 truncate text-xs text-neutral-500">
                      <span className="font-mono">{entry.itemId}</span>
                      {entry.beatId ? <span> · step {entry.beatId}</span> : null}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!onUndoEntry}
                  title={
                    onUndoEntry
                      ? `Rewind to before ${entry.itemId} (Shift+U on the focused row)`
                      : "Undo is unavailable here"
                  }
                  aria-label={`Undo to here: ${opLabel(entry.op)}${entry.targetId ? ` on ${entry.targetId}` : ""}`}
                  onClick={() => onUndoEntry?.(entry)}
                  className="shrink-0"
                >
                  Undo to here
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {entries.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.06] px-1 pt-2.5 pb-1 text-[11px] leading-5 text-muted-foreground">
          <KeyboardIcon className="size-3.5 text-neutral-500" aria-hidden="true" />
          <span className="flex items-center gap-1">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd>
            <span>move</span>
          </span>
          <span className="flex items-center gap-1">
            <Kbd>u</Kbd>
            <span>undo</span>
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd>
            <span>details</span>
          </span>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="ml-auto flex items-center gap-1.5 rounded-md px-1 py-0.5 text-neutral-400 outline-none hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <Kbd>?</Kbd>
            <span>shortcuts</span>
          </button>
        </div>
      ) : null}

      <Dialog.Root open={helpOpen} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup
            aria-label="History shortcuts"
            className="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card bg-popover p-6 ring-1 ring-white/10 transition-[scale,opacity] duration-150 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
          >
            <Dialog.Title className="text-base font-medium text-neutral-100">
              History shortcuts
            </Dialog.Title>
            <ul aria-label="History shortcuts" className="mt-4 flex flex-col">
              {HISTORY_SHORTCUTS.map((shortcut) => (
                <li
                  key={shortcut.label}
                  className="flex items-center gap-3 border-t border-white/[0.06] px-1 py-2 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <span className="flex w-28 shrink-0 flex-wrap items-center gap-1">
                    {shortcut.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </span>
                  <span className="text-sm text-neutral-300">{shortcut.label}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end">
              <Button type="button" size="sm" onClick={() => setHelpOpen(false)}>
                Done
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
