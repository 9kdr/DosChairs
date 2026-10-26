import { CheckIcon, ScissorsIcon, XIcon } from "lucide-react";
import type { Changeset, Timeline } from "@chair/timeline-ir";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CutPanelProps = {
  timeline: Timeline;
  changeset: Changeset;
  onStatus: (id: string, status: "accepted" | "rejected") => void;
  onClose: () => void;
};

const TRACK_WIDTH: Record<string, string> = {
  video: "bg-violet-400/20",
  audio: "bg-sky-400/20",
  subtitle: "bg-emerald-400/20",
  effect: "bg-amber-400/20",
};

export function CutPanel({ timeline, changeset, onStatus, onClose }: CutPanelProps) {
  const pending = changeset.items.filter((item) => item.status === "pending").length;

  return (
    <aside
      aria-label="Cut"
      className="hidden w-[19rem] shrink-0 flex-col border-l border-line bg-sidebar/70 backdrop-blur-xl lg:flex"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <ScissorsIcon className="size-3.5 text-subtle" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{timeline.name}</p>
        </div>
        <Badge variant={pending > 0 ? "warning" : "success"} size="sm">
          {pending > 0 ? `${pending} pending` : "Clean"}
        </Badge>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Hide cut"
          className="rounded-md text-subtle hover:text-foreground"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>

      <div className="shrink-0 border-b border-line p-3">
        <div className="flex items-center justify-between pb-2">
          <p className="text-[11px] font-medium text-subtle">Timeline</p>
          <p className="text-[11px] text-subtle">24 fps</p>
        </div>
        <div className="relative overflow-hidden rounded-xl border border-foreground/[0.06] bg-background/40 p-2">
          <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-between">
            {Array.from({ length: 9 }).map((_, index) => (
              <span key={index} className="h-1 w-px bg-foreground/10" />
            ))}
          </div>
          <div className="pointer-events-none absolute inset-y-2 left-[18%] w-px bg-violet-400/60">
            <span className="absolute -top-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-violet-300" />
          </div>
          <div className="mt-2.5 space-y-1.5">
            {timeline.tracks.map((track) => (
              <div key={track.id} className="grid grid-cols-[2.25rem_1fr] items-center gap-2">
                <span className="truncate text-[10px] text-subtle">{track.name}</span>
                <div
                  className={cn(
                    "h-6 rounded-md border border-foreground/[0.04]",
                    TRACK_WIDTH[track.kind] ?? "bg-foreground/[0.04]",
                  )}
                />
              </div>
            ))}
          </div>
        </div>
        <p className="pt-2 text-[11px] text-subtle">
          Accepted edits land here. Pending edits change nothing.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex items-center justify-between pb-2">
          <p className="text-[11px] font-medium text-subtle">Changes</p>
          <p className="text-[11px] text-subtle">{changeset.items.length} total</p>
        </div>
        <ul className="space-y-2">
          {changeset.items.map((item) => (
            <li key={item.id} className="glass-row rounded-xl p-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline" size="sm" className="font-mono">
                  {item.op}
                </Badge>
                <span className="truncate text-[11px] text-subtle">{item.beatId}</span>
                <span className="flex-1" />
                <span
                  className={cn(
                    "text-[10px]",
                    item.status === "pending" && "text-warning-foreground",
                    item.status === "accepted" && "text-success-foreground",
                    item.status === "rejected" && "text-subtle",
                  )}
                >
                  {item.status}
                </span>
              </div>
              <p className="mt-2 text-[13px] leading-5 text-foreground/85">{item.rationale}</p>
              {item.status === "pending" ? (
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    className="rounded-md"
                    onClick={() => onStatus(item.id, "accepted")}
                  >
                    <CheckIcon /> Accept
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="rounded-md text-muted-foreground"
                    onClick={() => onStatus(item.id, "rejected")}
                  >
                    Reject
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
