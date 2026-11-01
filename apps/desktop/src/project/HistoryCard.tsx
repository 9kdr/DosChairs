import { HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clockTime, opLabel } from "./ReviewBoard";
import type { HistoryEntry } from "./store";

/**
 * Accepted edits as a bento card beside the running tasks, in the same
 * card treatment as `RunningTasks`. Each row shows what landed, when, and
 * which changeset item and plan step it came from; Undo to here proposes
 * rewinding that entry plus its tail, and the proposal lands in Review
 * for accept.
 */
export function HistoryCard({
  entries,
  onUndoEntry,
  className,
}: {
  entries: HistoryEntry[];
  onUndoEntry?: (entry: HistoryEntry) => void;
  className?: string;
}) {
  return (
    <section
      aria-label="History"
      className={cn(
        "flex flex-col gap-1 rounded-[28px] bg-[#1a1a1a] p-4 text-neutral-100 shadow-raised ring-1 ring-white/8",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        <HistoryIcon className="size-4 text-neutral-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold tracking-wide text-neutral-100">History</h2>
        <span className="text-xs tabular-nums text-neutral-500">
          {entries.length === 1 ? "1 entry" : `${entries.length} entries`}
        </span>
        <p className="ml-auto text-xs text-neutral-500">Undo proposes; Review accepts.</p>
      </div>
      {entries.length === 0 ? (
        <p className="px-1 py-2 text-xs text-neutral-500">
          Nothing accepted yet — accepted edits land here with their undo point.
        </p>
      ) : (
        <ol className="flex min-h-0 flex-col">
          {entries.map((entry, index) => (
            <li
              key={entry.itemId}
              className="flex items-center gap-3 border-t border-white/[0.06] px-1 py-3 first:border-t-0 first:pt-1 last:pb-1"
            >
              <span className="w-7 shrink-0 text-xs tabular-nums text-neutral-500">
                #{index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-neutral-100">
                  {opLabel(entry.op)}
                  {entry.targetId ? (
                    <span className="ml-2 font-normal text-neutral-500">{entry.targetId}</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Accepted {clockTime(entry.acceptedAt)} by {entry.acceptedBy}
                </p>
                <p className="mt-0.5 truncate text-xs text-neutral-600">
                  <span className="font-mono">{entry.itemId}</span>
                  {entry.beatId ? <span> · step {entry.beatId}</span> : null}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!onUndoEntry}
                title={
                  onUndoEntry
                    ? `Propose rewinding to before ${entry.itemId}`
                    : "Undo is unavailable here"
                }
                aria-label={`Undo to here: ${opLabel(entry.op)}${entry.targetId ? ` on ${entry.targetId}` : ""}`}
                onClick={() => onUndoEntry?.(entry)}
                className="shrink-0"
              >
                Undo to here
              </Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
