import { Dialog } from "@base-ui/react/dialog";
import {
  ChevronDownIcon,
  ClapperboardIcon,
  KeyboardIcon,
  ListChecksIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChangesetItem, RationalTime, Timeline } from "@chair/timeline-ir";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { fallbackNotice, OpDiff } from "./OpDiff";
import {
  HISTORY_SHORTCUTS,
  historyKeyAction,
  historyKeyAllowed,
  historyKeyNativeEnter,
  moveHistoryFocus,
} from "./history-keys";
import { opLabel, type ProjectStore } from "./store";

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
          No edits yet
        </h3>
        <p className="px-1 text-sm leading-6 text-neutral-400">
          When the agent applies an edit for this project, it lands here.
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

/** One key cap in the hint row and the shortcut overlay. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-medium text-neutral-300 ring-1 ring-inset ring-white/10">
      {children}
    </kbd>
  );
}

/**
 * Project review: the agent's edits against this cut and the timeline
 * mirror beside them. In Auto mode edits apply on arrival onto a copy
 * and this board is the record; in Ask-first mode edits wait here as
 * pending until the person accepts or rejects each one. Applied edits
 * land in the History card beside the running tasks with their undo
 * point. Before the review loads, or when there is nothing yet, the
 * board says so honestly instead of showing stand-in edits.
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
  // A new proposal starts the board over: focus, expansion, and the
  // overlay all reset with its id, never mid-review.
  return <ReviewReady key={store.changeset?.id ?? "none"} store={store} timeline={timeline} />;
}

/**
 * The loaded board. In Ask-first mode it is keyboard-first: j/k and the
 * arrows move between items with a visible focus ring, a/r decide the
 * focused item (deciding advances), Enter expands the details, and ?
 * lists every shortcut. Typing anywhere leaves the keys alone. In Auto
 * mode the items already applied, so the list is click-only record and
 * the History card owns the keys.
 */
function ReviewReady({ store, timeline }: { store: ProjectStore; timeline: Timeline }) {
  const askMode = store.applyMode === "ask";
  const items = store.changeset?.items ?? [];
  const [focusedIndex, setFocusedIndex] = useState(() => {
    const firstPending = items.findIndex((item) => item.status === "pending");
    return firstPending >= 0 ? firstPending : 0;
  });
  const [helpOpen, setHelpOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const focusItem = (index: number) => {
    if (items.length === 0) return;
    const clamped = moveHistoryFocus(items.length, index, 0);
    setFocusedIndex(clamped);
    const id = items[clamped]?.id;
    if (!id) return;
    const node = rowRefs.current.get(id);
    node?.focus({ preventScroll: true });
    node?.scrollIntoView({ block: "nearest" });
  };

  const toggleOpen = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setRowRef = (id: string) => (node: HTMLLIElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  };

  useEffect(() => {
    if (!askMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!historyKeyAllowed(event.target)) return;
      const action = historyKeyAction(event);
      if (!action) return;
      if (action === "help") {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (action !== "next" && action !== "prev" && action !== "accept" && action !== "reject" && action !== "toggle") return;
      if (items.length === 0) return;
      // Tabbing to a row button or the row itself sets the base:
      // the key acts where the person already is.
      let base = Math.min(focusedIndex, items.length - 1);
      const active = document.activeElement;
      if (active instanceof Element) {
        const row = active.closest("[data-item-id]");
        const id = row?.getAttribute("data-item-id");
        if (id) {
          const found = items.findIndex((item) => item.id === id);
          if (found >= 0) base = found;
        }
      }
      const focused = items[base];
      if (!focused) return;
      switch (action) {
        case "next":
        case "prev":
          event.preventDefault();
          focusItem(base + (action === "next" ? 1 : -1));
          break;
        case "accept":
        case "reject":
          if (focused.status !== "pending") return;
          event.preventDefault();
          if (action === "accept") store.acceptItem(focused.id);
          else store.rejectItem(focused.id);
          focusItem(base + 1);
          break;
        case "toggle":
          if (historyKeyNativeEnter(event.target)) return;
          event.preventDefault();
          toggleOpen(focused.id);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const { changeset, pendingCount } = store;
  const clipCount = timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0);

  return (
    <div className="h-full overflow-y-auto p-4 pb-[9.5rem]">
      <div className="flex flex-wrap items-center gap-2">
        <ReviewTitle />
        <Badge variant={pendingCount === 0 ? "success" : "warning"} size="sm">
          {pendingCount === 1 ? "1 pending" : `${pendingCount} pending`}
        </Badge>
        <p className="ml-auto text-xs text-neutral-500">
          {askMode
            ? "Waiting for your accept. Nothing applies until then."
            : "Applied onto a copy. Undo is one key."}
        </p>
      </div>

      {store.refusal ? (
        <div role="alert" className={cn(CARD, "mt-3 flex items-start gap-2 p-4 ring-amber-300/25")}>
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          <p className="text-sm leading-6 text-neutral-200">
            Couldn&apos;t apply{store.refusal.itemId ? ` ${store.refusal.itemId}` : ""}:{" "}
            <span className="text-neutral-400">{store.refusal.reason}</span> Nothing changed.
          </p>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-1 items-start gap-3 lg:grid-cols-12">
        <section
          aria-label={askMode ? "Proposed edits" : "Applied edits"}
          className={cn(CARD, "flex min-h-0 flex-col gap-1 p-4 lg:col-span-7")}
        >
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-1 pb-1">
            <h3 className="text-sm font-semibold tracking-wide text-neutral-100">
              {askMode ? "Proposed edits" : "Applied edits"}
            </h3>
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
              <p className="text-sm text-neutral-300">No edits yet.</p>
              <p className="text-xs leading-5 text-neutral-500">
                {askMode
                  ? "New edits from the agent wait here for your accept."
                  : "New edits from the agent apply on arrival and land here as a record."}
              </p>
              <Button type="button" size="sm" variant="outline" onClick={() => store.retry()}>
                Check again
              </Button>
            </div>
          ) : (
            <ul aria-label="Edit items" className="flex min-h-0 flex-col">
              {changeset.items.map((item, index) => (
                <ChangesetItemRow
                  key={item.id}
                  item={item}
                  focused={askMode && index === focusedIndex}
                  focusable={askMode}
                  rowRef={setRowRef(item.id)}
                  onFocusRow={() => setFocusedIndex(index)}
                  open={expandedIds.has(item.id)}
                  onToggleOpen={() => toggleOpen(item.id)}
                  onAccept={() => store.acceptItem(item.id)}
                  onReject={() => store.rejectItem(item.id)}
                />
              ))}
            </ul>
          )}
          {askMode && changeset !== null && changeset.items.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.06] px-1 pt-2.5 pb-1 text-[11px] leading-5 text-neutral-500">
              <KeyboardIcon className="size-3.5 text-neutral-600" aria-hidden="true" />
              <span className="flex items-center gap-1">
                <Kbd>j</Kbd>
                <Kbd>k</Kbd>
                <span>move</span>
              </span>
              <span className="flex items-center gap-1">
                <Kbd>a</Kbd>
                <span>accept</span>
              </span>
              <span className="flex items-center gap-1">
                <Kbd>r</Kbd>
                <span>reject</span>
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
          <p className="shrink-0 px-1 text-xs text-neutral-500">{timeline.name} · follows every apply</p>
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
            {clipCount} clips · {timeline.markers.length} markers — applies land on copies;
            source media untouched.
          </p>
        </section>
      </div>

      {askMode ? (
        <Dialog.Root open={helpOpen} onOpenChange={setHelpOpen}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
            <Dialog.Popup
              aria-label="Review shortcuts"
              className="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-[#161616] p-6 ring-1 ring-white/10 transition-[scale,opacity] duration-150 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
            >
              <Dialog.Title className="text-base font-semibold text-neutral-100">
                Review shortcuts
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-neutral-400">
                Accept without the mouse. Shortcuts rest while typing.
              </Dialog.Description>
              <ul aria-label="Review shortcuts" className="mt-4 flex flex-col">
                {HISTORY_SHORTCUTS.filter(
                  (shortcut) => shortcut.keys[0] !== "u" && shortcut.keys[0] !== "Shift U",
                ).map((shortcut) => (
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
              <p className="mt-4 text-xs leading-5 text-neutral-500">
                Accept is always explicit: one key decides one edit. There is no key for accept
                all.
              </p>
              <div className="mt-5 flex justify-end">
                <Button type="button" size="sm" onClick={() => setHelpOpen(false)}>
                  Done
                </Button>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </div>
  );
}

/** One edit: its summary, its fallback line, its visual diff, and its decision. */
function ChangesetItemRow({
  item,
  focused,
  focusable,
  rowRef,
  onFocusRow,
  open,
  onToggleOpen,
  onAccept,
  onReject,
}: {
  item: ChangesetItem;
  focused: boolean;
  focusable: boolean;
  rowRef?: (node: HTMLLIElement | null) => void;
  onFocusRow?: () => void;
  open: boolean;
  onToggleOpen: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const notice = fallbackNotice(item);

  return (
    <li
      ref={rowRef}
      data-item-id={item.id}
      tabIndex={focusable ? 0 : -1}
      onFocus={focusable ? onFocusRow : undefined}
      className={cn(
        "rounded-xl border-t border-white/[0.06] px-1 py-3 outline-none transition-colors first:border-t-0 first:pt-1 last:pb-1",
        focused && "bg-white/[0.05] ring-1 ring-lime-300/60 ring-inset",
      )}
    >
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
              {item.status === "accepted" ? "Applied" : "Rejected"}
            </Badge>
          </div>
        )}
      </div>
      {notice ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-300/[0.07] px-2.5 py-1.5 text-xs leading-5 text-amber-200/90 ring-1 ring-amber-300/20 ring-inset">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">Fallback — </span>
            {notice}
          </span>
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={onToggleOpen}
        className="mt-1 h-7 px-1 text-xs text-neutral-400 hover:text-neutral-100"
      >
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
        Diff
      </Button>
      {open ? (
        <div className="mt-1 rounded-xl bg-black/30 p-3 ring-1 ring-white/[0.06]">
          <OpDiff item={item} />
          {item.status === "pending" ? (
            <p className="mt-2 text-xs text-neutral-600">
              The undo point lands with the accept — applied onto a copy, never the source.
            </p>
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
