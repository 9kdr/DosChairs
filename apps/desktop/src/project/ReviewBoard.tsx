import { ChevronDownIcon, ClapperboardIcon, HistoryIcon, ListChecksIcon } from "lucide-react";
import { useState } from "react";
import type { RationalTime } from "@chair/timeline-ir";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HistoryEntry, ProjectStore } from "./store";
import type { ChangesetItem } from "@chair/timeline-ir";

const CARD = "rounded-[28px] bg-[#1a1a1a] text-neutral-100 shadow-raised ring-1 ring-white/8";

/** Frames at the timeline rate as H:MM:SS:FF. */
function timecode(time: RationalTime): string {
  const frames = Math.round((time.value / time.rate) * 24);
  const ff = frames % 24;
  const totalSeconds = Math.floor(frames / 24);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  // taste-skill-ignore: timecode fields are zero-padded by definition.
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${hh}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

function seconds(time: RationalTime): string {
  const value = time.value / time.rate;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}s`;
}

export function opLabel(op: string): string {
  return op
    .split("_")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Project review: the proposed edits against this cut, the timeline
 * mirror beside them, and the history of accepted edits below. Accept
 * or reject flips an item's status only; the mirror always shows the
 * cut as it stands.
 */
export function ReviewBoard({ store }: { store: ProjectStore }) {
  const { timeline, changeset, history, pendingCount } = store;
  const clipCount = timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0);
  const [flashId, setFlashId] = useState<string | null>(null);

  const jumpToEntry = (itemId: string) => {
    setFlashId(itemId);
    document
      .getElementById(`history-${itemId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    window.setTimeout(() => {
      setFlashId((current) => (current === itemId ? null : current));
    }, 1600);
  };

  return (
    <div className="h-full overflow-y-auto p-4 pb-[9.5rem]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10">
          <ListChecksIcon className="size-4 text-neutral-300" aria-hidden="true" />
        </span>
        <h2 className="text-sm font-semibold tracking-wide text-neutral-100">Review</h2>
        <Badge variant={pendingCount === 0 ? "success" : "warning"} size="sm">
          {pendingCount === 1 ? "1 pending" : `${pendingCount} pending`}
        </Badge>
        <p className="ml-auto text-xs text-neutral-500">Pending edits never change the cut.</p>
      </div>

      <div className="mt-3 grid grid-cols-1 items-start gap-3 lg:grid-cols-12">
        <section
          aria-label="Proposed edits"
          className={cn(CARD, "flex min-h-0 flex-col gap-1 p-4 lg:col-span-7")}
        >
          <div className="flex shrink-0 items-center gap-2 px-1 pb-1">
            <h3 className="text-sm font-semibold tracking-wide text-neutral-100">Proposed edits</h3>
            {pendingCount > 0 ? (
              <Button type="button" size="sm" onClick={() => store.acceptAll()}>
                Accept all ({pendingCount})
              </Button>
            ) : null}
            <span className="ml-auto text-xs tabular-nums text-neutral-500">
              {changeset.items.length} items
            </span>
          </div>
          <ul className="flex min-h-0 flex-col">
            {changeset.items.map((item) => (
              <ChangesetItemRow
                key={item.id}
                item={item}
                entry={history.find((row) => row.itemId === item.id)}
                onAccept={() => store.acceptItem(item.id)}
                onReject={() => store.rejectItem(item.id)}
                onHistory={() => jumpToEntry(item.id)}
              />
            ))}
          </ul>
        </section>

        <section
          aria-label="Timeline mirror"
          className={cn(CARD, "flex min-h-0 flex-col gap-2 p-4 lg:col-span-5")}
        >
          <div className="flex shrink-0 items-center gap-2 px-1">
            <ClapperboardIcon className="size-4 text-neutral-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold tracking-wide text-neutral-100">
              Timeline mirror
            </h3>
            <span className="ml-auto text-xs tabular-nums text-neutral-500">
              {timeline.rate.num} fps
            </span>
          </div>
          <p className="shrink-0 px-1 text-xs text-neutral-500">{timeline.name} · read-only</p>
          <ul className="flex min-h-0 flex-col gap-3">
            {timeline.tracks.map((track) => (
              <li key={track.id}>
                <p className="px-1 text-xs font-medium text-neutral-400">
                  {track.name}
                  <span className="ml-2 font-normal text-neutral-600">{track.kind}</span>
                </p>
                {track.clips.length === 0 ? (
                  <p className="px-1 py-1 text-xs text-neutral-600">—</p>
                ) : (
                  <ul className="mt-1 flex flex-col">
                    {track.clips.map((clip) => (
                      <li key={clip.id} className="flex items-baseline gap-2 px-1 py-1 text-xs">
                        <span className="min-w-0 flex-1 truncate text-neutral-200">
                          {clip.name}
                        </span>
                        <span className="shrink-0 tabular-nums text-neutral-500">
                          {timecode(clip.timelineRange.start)}
                        </span>
                        <span className="w-8 shrink-0 text-right tabular-nums text-neutral-500">
                          {seconds(clip.timelineRange.duration)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {timeline.markers.length > 0 ? (
            <div className="shrink-0 border-t border-white/[0.06] pt-2">
              <p className="px-1 text-xs font-medium text-neutral-400">Markers</p>
              <ul className="mt-1 flex flex-wrap gap-1.5 px-1">
                {timeline.markers.map((marker) => (
                  <li key={marker.id}>
                    <Badge variant="outline" size="sm">
                      {marker.name} · {timecode(marker.time)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="shrink-0 px-1 text-xs tabular-nums text-neutral-500">
            {clipCount} clips · {timeline.markers.length} markers — pending edits are not applied.
          </p>
        </section>
      </div>

      <section aria-label="History" className={cn(CARD, "mt-3 flex min-h-0 flex-col gap-1 p-4")}>
        <div className="flex shrink-0 items-center gap-2 px-1 pb-1">
          <HistoryIcon className="size-4 text-neutral-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold tracking-wide text-neutral-100">History</h3>
          <span className="text-xs tabular-nums text-neutral-500">
            {history.length === 1 ? "1 entry" : `${history.length} entries`}
          </span>
          <p className="ml-auto text-xs text-neutral-500">Undo to here arrives with #75.</p>
        </div>
        {history.length === 0 ? (
          <p className="px-1 py-2 text-xs text-neutral-500">
            Nothing accepted yet — accepted edits land here with their undo point.
          </p>
        ) : (
          <ol className="flex min-h-0 flex-col">
            {history.map((entry, index) => (
              <li
                key={entry.itemId}
                id={`history-${entry.itemId}`}
                className={cn(
                  "flex scroll-mt-4 items-center gap-3 border-t border-white/[0.06] px-1 py-3 first:border-t-0 first:pt-1 last:pb-1",
                  flashId === entry.itemId && "rounded-lg bg-white/[0.05]",
                )}
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
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled
                  title="Undo to here arrives with #75"
                  className="shrink-0"
                >
                  Undo to here
                </Button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** One proposed edit: its summary, its diff, and its decision. */
function ChangesetItemRow({
  item,
  entry,
  onAccept,
  onReject,
  onHistory,
}: {
  item: ChangesetItem;
  entry: HistoryEntry | undefined;
  onAccept: () => void;
  onReject: () => void;
  onHistory: () => void;
}) {
  const [diffOpen, setDiffOpen] = useState(false);

  return (
    <li className="border-t border-white/[0.06] px-1 py-3 first:border-t-0 first:pt-1 last:pb-1">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-neutral-100">
            {opLabel(item.op)}
            {item.targetId ? (
              <span className="ml-2 font-normal text-neutral-500">{item.targetId}</span>
            ) : null}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-neutral-400">{item.rationale}</p>
        </div>
        {item.status === "pending" ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={onAccept}>
              Accept
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-neutral-400 hover:text-neutral-100"
              onClick={onReject}
            >
              Reject
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={item.status === "accepted" ? "success" : "secondary"} size="sm">
              {item.status === "accepted" ? "Accepted" : "Rejected"}
            </Badge>
            {item.status === "accepted" && entry ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-neutral-400 hover:text-neutral-100"
                onClick={onHistory}
              >
                History
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={diffOpen}
        onClick={() => setDiffOpen((open) => !open)}
        className="mt-1 h-7 px-1 text-xs text-neutral-400 hover:text-neutral-100"
      >
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", diffOpen && "rotate-180")}
          aria-hidden="true"
        />
        Diff
      </Button>
      {diffOpen ? (
        <div className="mt-1 flex flex-col gap-2 rounded-xl bg-black/30 p-3 ring-1 ring-white/[0.06]">
          <PatchBlock label="Forward patch" patch={item.patch} />
          {entry ? (
            <PatchBlock label="Inverse patch (stand-in)" patch={entry.inverse} />
          ) : (
            <p className="text-xs text-neutral-600">Inverse patch lands with the accept.</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** One patch of a diff: pretty JSON, or a dash when there is nothing to show. */
function PatchBlock({
  label,
  patch,
}: {
  label: string;
  patch: Record<string, unknown> | undefined;
}) {
  const keys = patch ? Object.keys(patch) : [];
  return (
    <div>
      <p className="text-xs font-medium text-neutral-400">{label}</p>
      {keys.length === 0 ? (
        <p className="mt-0.5 text-xs text-neutral-600">—</p>
      ) : (
        <pre className="mt-1 overflow-x-auto font-mono text-xs leading-5 text-neutral-300">
          {JSON.stringify(patch, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** HH:MM on the local clock for an accepted-at stamp. */
function clockTime(iso: string): string {
  const date = new Date(iso);
  // taste-skill-ignore: clock fields are zero-padded by definition.
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
