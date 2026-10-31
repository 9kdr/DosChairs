import { ClapperboardIcon, ListChecksIcon } from "lucide-react";
import type { RationalTime } from "@chair/timeline-ir";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProjectStore } from "./store";

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

function opLabel(op: string): string {
  return op
    .split("_")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Project review: the proposed edits against this cut, and the timeline
 * mirror beside them. Accept or reject flips an item's status only; the
 * mirror always shows the cut as it stands.
 */
export function ReviewBoard({ store }: { store: ProjectStore }) {
  const { timeline, changeset, pendingCount } = store;
  const clipCount = timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0);

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
            <span className="ml-auto text-xs tabular-nums text-neutral-500">
              {changeset.items.length} items
            </span>
          </div>
          <ul className="flex min-h-0 flex-col">
            {changeset.items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 border-t border-white/[0.06] px-1 py-3 first:border-t-0 first:pt-1 last:pb-1"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-100">
                    {opLabel(item.op)}
                    {item.targetId ? (
                      <span className="ml-2 font-normal text-neutral-500">{item.targetId}</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-neutral-400">
                    {item.rationale}
                  </p>
                </div>
                {item.status === "pending" ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => store.acceptItem(item.id)}
                    >
                      Accept
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-neutral-400 hover:text-neutral-100"
                      onClick={() => store.rejectItem(item.id)}
                    >
                      Reject
                    </Button>
                  </div>
                ) : (
                  <Badge variant={item.status === "accepted" ? "success" : "secondary"} size="sm">
                    {item.status === "accepted" ? "Accepted" : "Rejected"}
                  </Badge>
                )}
              </li>
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
    </div>
  );
}
