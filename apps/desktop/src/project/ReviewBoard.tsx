import { ChevronDownIcon, ClapperboardIcon, ListChecksIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { RationalTime } from "@chair/timeline-ir";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { OpDiff } from "./OpDiff";
import { opLabel, type ProjectStore } from "./store";
import type { ChangesetItem } from "@chair/timeline-ir";

export { opLabel };

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

function ReviewTitle() {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-7 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10">
        <ListChecksIcon className="size-4 text-neutral-300" aria-hidden="true" />
      </span>
      <h2 className="text-sm font-semibold tracking-wide text-neutral-100">Review</h2>
    </div>
  );
}

/** Loading, empty, and error states share the board's scroll shell. */
function ReviewLoading() {
  return (
    <div className="h-full overflow-y-auto p-4 pb-[9.5rem]">
      <ReviewTitle />
      <section aria-label="Loading review" className={cn(CARD, "mt-3 flex items-center gap-3 p-4")}>
        <Spinner className="size-5 shrink-0 text-neutral-400" />
        <p className="text-sm text-neutral-300">Loading the review…</p>
      </section>
    </div>
  );
}

function ReviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="h-full overflow-y-auto p-4 pb-[9.5rem]">
      <ReviewTitle />
      <section
        aria-label="Review failed to load"
        className={cn(CARD, "mt-3 flex flex-col gap-3 p-4")}
      >
        <div className="flex items-center gap-2 px-1">
          <TriangleAlertIcon className="size-4 shrink-0 text-amber-300" aria-hidden="true" />
          <h3 className="text-sm font-semibold tracking-wide text-neutral-100">
            Couldn&apos;t load the review
          </h3>
        </div>
        <p className="px-1 text-sm leading-6 text-neutral-400">{message}</p>
        <div className="px-1">
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </section>
    </div>
  );
}

/** No proposal and no mirror: the agent knows nothing for this project yet. */
function ReviewEmpty({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="h-full overflow-y-auto p-4 pb-[9.5rem]">
      <ReviewTitle />
      <section aria-label="No proposals yet" className={cn(CARD, "mt-3 flex flex-col gap-3 p-4")}>
        <h3 className="px-1 text-sm font-semibold tracking-wide text-neutral-100">
          No proposals yet
        </h3>
        <p className="px-1 text-sm leading-6 text-neutral-400">
          When the agent proposes an edit for this project, it lands here for review.
        </p>
        <div className="px-1">
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Check again
          </Button>
        </div>
      </section>
    </div>
  );
}

/**
 * Project review: the proposed edits against this cut and the timeline
 * mirror beside them. Accept or reject flips an item's status only; the
 * mirror always shows the cut as it stands. Accepted edits land in the
 * History card beside the running tasks. Before the review loads, or
 * when there is no proposal yet, the board says so honestly instead of
 * showing stand-in edits.
 */
export function ReviewBoard({ store }: { store: ProjectStore }) {
  if (store.phase === "loading") {
    return <ReviewLoading />;
  }
  if (store.phase === "error") {
    return (
      <ReviewError
        message={store.error ?? "Could not load the review."}
        onRetry={() => store.retry()}
      />
    );
  }
  const timeline = store.timeline;
  if (timeline === null) {
    return <ReviewEmpty onRetry={() => store.retry()} />;
  }
  const { changeset, pendingCount } = store;
  const clipCount = timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0);
  const rollbackPending = store.rollback
    ? store.rollback.items.filter((item) => item.status === "pending").length
    : 0;

  return (
    <div className="h-full overflow-y-auto p-4 pb-[9.5rem]">
      <div className="flex flex-wrap items-center gap-2">
        <ReviewTitle />
        <Badge variant={pendingCount === 0 ? "success" : "warning"} size="sm">
          {pendingCount === 1 ? "1 pending" : `${pendingCount} pending`}
        </Badge>
        <p className="ml-auto text-xs text-neutral-500">Pending edits never change the cut.</p>
      </div>

      {store.refusal ? (
        <div role="alert" className={cn(CARD, "mt-3 flex items-start gap-2 p-4 ring-amber-300/25")}>
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          <p className="text-sm leading-6 text-neutral-200">
            Couldn&apos;t accept{store.refusal.itemId ? ` ${store.refusal.itemId}` : ""}:{" "}
            <span className="text-neutral-400">{store.refusal.reason}</span> Nothing changed.
          </p>
        </div>
      ) : null}

      {store.rollback ? (
        <section
          aria-label="Undo proposal"
          className={cn(CARD, "mt-3 flex min-h-0 flex-col gap-1 p-4")}
        >
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-1 pb-1">
            <h3 className="text-sm font-semibold tracking-wide text-neutral-100">Undo proposal</h3>
            <Badge variant={rollbackPending === 0 ? "success" : "warning"} size="sm">
              {rollbackPending === 1 ? "1 pending" : `${rollbackPending} pending`}
            </Badge>
            {rollbackPending > 0 ? (
              <Button type="button" size="sm" onClick={() => store.acceptAllUndo()}>
                Accept undo ({rollbackPending})
              </Button>
            ) : null}
          </div>
          {store.rollback.summary ? (
            <p className="px-1 pb-1 text-xs leading-5 text-neutral-500">
              {store.rollback.summary} Accepting rewinds the cut newest first.
            </p>
          ) : null}
          <ul className="flex min-h-0 flex-col">
            {store.rollback.items.map((item) => (
              <ChangesetItemRow
                key={item.id}
                item={item}
                onAccept={() => store.acceptItem(item.id)}
                onReject={() => store.rejectItem(item.id)}
              />
            ))}
          </ul>
        </section>
      ) : null}

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
            {changeset !== null ? (
              <span className="ml-auto text-xs tabular-nums text-neutral-500">
                {changeset.items.length} items
              </span>
            ) : null}
          </div>
          {changeset === null ? (
            <div className="flex flex-col items-start gap-2 px-1 py-3">
              <p className="text-sm text-neutral-300">No proposals yet.</p>
              <p className="text-xs leading-5 text-neutral-500">
                New proposals from the agent land here for review.
              </p>
              <Button type="button" size="sm" variant="outline" onClick={() => store.retry()}>
                Check again
              </Button>
            </div>
          ) : (
            <ul className="flex min-h-0 flex-col">
              {changeset.items.map((item) => (
                <ChangesetItemRow
                  key={item.id}
                  item={item}
                  onAccept={() => store.acceptItem(item.id)}
                  onReject={() => store.rejectItem(item.id)}
                />
              ))}
            </ul>
          )}
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
    </div>
  );
}

/** One proposed edit: its summary, its visual diff, and its decision. */
function ChangesetItemRow({
  item,
  onAccept,
  onReject,
}: {
  item: ChangesetItem;
  onAccept: () => void;
  onReject: () => void;
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
        <div className="mt-1 rounded-xl bg-black/30 p-3 ring-1 ring-white/[0.06]">
          <OpDiff item={item} />
          {item.status === "pending" ? (
            <p className="mt-2 text-xs text-neutral-600">The undo point lands with the accept.</p>
          ) : item.status === "accepted" ? (
            <p className="mt-2 text-xs text-neutral-600">
              Undo point recorded — see History beside Running tasks.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** HH:MM on the local clock for an accepted-at stamp. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  // taste-skill-ignore: clock fields are zero-padded by definition.
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
