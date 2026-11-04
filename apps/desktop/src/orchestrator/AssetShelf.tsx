import {
  AudioLines,
  ChevronDown,
  ChevronLeft,
  Eye,
  EyeOff,
  Film,
  Folder,
  Image,
  LayoutGrid,
  List,
  ListFilter,
  Puzzle,
  Rows3,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  Ref,
} from "react";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ClipChoice } from "@/effects/EffectMaker";
import type { ChangesetItem } from "@chair/timeline-ir";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { pressStartsDrag, writeChairRefs } from "@/lib/chair-ref";
import { cn } from "@/lib/utils";
import { fileToBase64, importProjectAsset, useProjectAssets } from "@/project/assets";

type AssetKind = "video" | "image" | "audio";
type TypeFilter = "all" | AssetKind;
type ViewStyle = "cards" | "compact" | "more";
type Shift = "fade" | "in" | "out";

type AssetItem = {
  id: string;
  scope: "assets";
  name: string;
  kind: AssetKind;
  previewUrl?: string;
  /** Whether the sidecar already rendered a preview for this file. */
  proxy: "ready" | "missing";
};

/**
 * The shelf's rows are assets only. Pieces live in the dock's Pieces
 * section, which reads the agent's piece listing with kinds.
 */
type ShelfItem = AssetItem;

type FolderItem = {
  id: string;
  name: string;
  assetIds: readonly string[];
};

/** Ghost-dot tone for an outgoing shelf drag: media kind, folder, or piece. */
export type ShelfDragTone = AssetKind | "folder" | "piece";

/** One card in an outgoing shelf drag. Folders ride as asset refs. */
export type ShelfDragItem = {
  id: string;
  label: string;
  tone: ShelfDragTone;
  refKind: "asset" | "piece";
};

const KIND_ICON: Record<AssetKind, LucideIcon> = {
  video: Film,
  image: Image,
  audio: AudioLines,
};

const KIND_COLOR: Record<AssetKind, string> = {
  video: "text-info-foreground",
  image: "text-warning-foreground",
  audio: "text-success-foreground",
};

const KIND_FRAME: Record<AssetKind, string> = {
  video: "bg-info-foreground/10 ring-1 ring-info-foreground/20",
  image: "bg-warning-foreground/10 ring-1 ring-warning-foreground/20",
  audio: "bg-success-foreground/10 ring-1 ring-success-foreground/20",
};

const KIND_LABEL: Record<AssetKind, string> = {
  video: "Video",
  image: "Still",
  audio: "Audio",
};

const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "image", label: "Stills" },
  { id: "audio", label: "Audio" },
];

const VIEWS: { id: ViewStyle; label: string; icon: LucideIcon }[] = [
  { id: "cards", label: "Cards", icon: LayoutGrid },
  { id: "compact", label: "Compact", icon: Rows3 },
  { id: "more", label: "More", icon: List },
];

const SHELF_VIEW_KEY = "chair.shelfView";

/** Below this shelf width the search field collapses to an icon button. */
const SEARCH_COLLAPSE_PX = 420;

function loadShelfView(): ViewStyle {
  const saved = localStorage.getItem(SHELF_VIEW_KEY);
  return saved === "cards" || saved === "compact" || saved === "more" ? saved : "compact";
}

function loadIdList(key: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Command-bar glide: 380ms cubic-bezier(0.22, 1, 0.36, 1). */
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const DURATION = 0.38;

/** Quiet at rest. Hover and selection pick up the same outline face as Plan’s Edit. */
const SHELF_BUTTON = cn(
  "h-auto w-full justify-start border-transparent bg-transparent font-normal whitespace-normal shadow-none",
  "before:shadow-none dark:bg-transparent",
  "hover:border-input hover:bg-input/32 hover:shadow-xs/5",
  "hover:before:shadow-[0_-1px_--theme(--color-white/6%)]",
  "dark:hover:border-input dark:hover:bg-input/32",
  "data-pressed:border-input data-pressed:bg-input/32 data-pressed:shadow-xs/5",
  "data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)]",
  "dark:data-pressed:border-input dark:data-pressed:bg-input/32",
  "data-dragging:opacity-64 sm:h-auto",
);

const MENU_POPUP =
  "min-w-36 rounded-2xl border-0 bg-[#1a1a1a] text-neutral-100 shadow-raised ring-1 ring-white/10 before:hidden";

const MENU_ITEM =
  "min-h-0 grid-cols-1 gap-0 rounded-xl px-2.5 py-1.5 text-sm data-checked:bg-white/8 [&>span:first-child]:hidden [&>span:last-child]:col-start-1 [&>span:last-child]:flex [&>span:last-child]:items-center [&>span:last-child]:gap-2";

/** A thin inner edge, close to the quiet wells. */
const PLACEHOLDER = "shadow-[inset_0_1px_0_rgb(255_255_255/8%)]";

const ITEM_TRANSITION = {
  duration: DURATION,
  ease: EASE,
  layout: { duration: DURATION, ease: EASE },
};

const ITEM_STILL = {
  layout: false as const,
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: ITEM_TRANSITION,
};

const ITEM_MOVE = {
  layout: "position" as const,
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: ITEM_TRANSITION,
};

const FADE_STILL = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: DURATION, ease: EASE },
};

const FADE_MOVE = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: DURATION, ease: EASE },
};

function paneVariants(reduce: boolean | null): Variants {
  const transition = { duration: DURATION, ease: EASE };
  if (reduce) {
    return {
      enter: { opacity: 0, zIndex: 1 },
      center: { opacity: 1, zIndex: 1, transition },
      leave: { opacity: 0, zIndex: 0, pointerEvents: "none", transition },
    };
  }
  return {
    enter: (shift: Shift) => ({
      opacity: 0,
      x: shift === "in" ? 16 : shift === "out" ? -16 : 0,
      y: shift === "fade" ? 8 : 0,
      zIndex: 1,
    }),
    center: { opacity: 1, x: 0, y: 0, zIndex: 1, transition },
    leave: (shift: Shift) => ({
      opacity: 0,
      x: shift === "in" ? -16 : shift === "out" ? 16 : 0,
      y: shift === "fade" ? -8 : 0,
      zIndex: 0,
      pointerEvents: "none",
      transition,
    }),
  };
}

const GHOST_INK: Record<ShelfDragTone, string> = {
  video: "#60a5fa",
  image: "#fbbf24",
  audio: "#34d399",
  folder: "#d4d4d4",
  piece: "#a3a3a3",
};

function KindMark({ kind, dense = false }: { kind: AssetKind | null; dense?: boolean }) {
  const Icon = kind ? KIND_ICON[kind] : Puzzle;
  return (
    <Icon
      className={cn("shrink-0 text-neutral-400", dense ? "size-3.5" : "size-4")}
      aria-hidden="true"
    />
  );
}

type Box = { x: number; y: number; w: number; h: number };

function normalizeBox(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function boxesMeet(a: Box, b: Box) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function kindFor(name: string): AssetKind {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"].includes(ext)) return "image";
  if (["wav", "mp3", "aif", "aiff", "flac", "m4a"].includes(ext)) return "audio";
  return "video";
}

/**
 * Group rule for a shelf drag: the held card alone, unless it sits inside a
 * multi-select — then every selected card rides, each with its own ref kind.
 */
export function dragItemsFor(
  chosen: readonly string[],
  assets: readonly { id: string; name: string; kind: AssetKind }[],
  folders: readonly { id: string; name: string }[],
  pieces: readonly { id: string; name: string }[],
  id: string,
  label: string,
  tone: ShelfDragTone,
): ShelfDragItem[] {
  const single: ShelfDragItem = {
    id,
    label,
    tone,
    refKind: tone === "piece" ? "piece" : "asset",
  };
  if (!chosen.includes(id) || chosen.length < 2) return [single];
  const group: ShelfDragItem[] = [];
  for (const sid of chosen) {
    const asset = assets.find((item) => item.id === sid);
    if (asset) {
      group.push({ id: sid, label: asset.name, tone: asset.kind, refKind: "asset" });
      continue;
    }
    const folderItem = folders.find((item) => item.id === sid);
    if (folderItem) {
      group.push({ id: sid, label: folderItem.name, tone: "folder", refKind: "asset" });
      continue;
    }
    const piece = pieces.find((item) => item.id === sid);
    if (piece) group.push({ id: sid, label: piece.name, tone: "piece", refKind: "piece" });
  }
  return group.length > 0 ? group : [single];
}

type SearchFieldProps = {
  value: string;
  placeholder: string;
  label: string;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
};

/** The shelf search field, shared by the full-width row and the narrow overlay. */
function SearchField({
  value,
  placeholder,
  label,
  inputRef,
  onChange,
  onKeyDown,
  onBlur,
}: SearchFieldProps) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-500" />
      <Input
        ref={inputRef}
        type="search"
        size="sm"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        className="**:data-[slot=input]:pl-8"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
    </div>
  );
}

/** The shelf list area before the listing lands. */
function ShelfLoading({ still }: { still: boolean }) {
  return (
    <motion.div
      aria-label="Loading assets"
      {...(still ? FADE_STILL : FADE_MOVE)}
      className="flex items-center gap-2 px-1 py-2"
    >
      <Spinner className="size-4 shrink-0 text-neutral-400" />
      <p className="text-sm text-neutral-400">Loading assets…</p>
    </motion.div>
  );
}

/** The listing failed: one sentence plus a retry, inside the shelf frame. */
function ShelfError({
  message,
  onRetry,
  still,
}: {
  message: string;
  onRetry: () => void;
  still: boolean;
}) {
  return (
    <motion.div
      role="alert"
      aria-label="Assets failed to load"
      {...(still ? FADE_STILL : FADE_MOVE)}
      className="flex flex-col gap-3 px-1 py-2"
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 shrink-0 text-amber-300" aria-hidden="true" />
        <h3 className="text-sm font-semibold tracking-wide text-neutral-100">
          Couldn&apos;t load the assets
        </h3>
      </div>
      <p className="text-sm leading-6 text-neutral-400">{message}</p>
      <div>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </motion.div>
  );
}

/** The project has no assets yet. Frame and header stay. */
function ShelfEmpty({ onRetry, still }: { onRetry: () => void; still: boolean }) {
  return (
    <motion.div {...(still ? FADE_STILL : FADE_MOVE)}>
      <Empty className="py-8 md:py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Film />
          </EmptyMedia>
          <EmptyTitle>No assets yet</EmptyTitle>
          <EmptyDescription>Import, or connect Resolve.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Check again
          </Button>
        </EmptyContent>
      </Empty>
    </motion.div>
  );
}

/** One status mark: the sidecar already rendered a preview for this file. */
function ProxyBadge({ className }: { className?: string }) {
  return (
    <Badge size="sm" variant="success" className={cn("shrink-0", className)}>
      Proxy
    </Badge>
  );
}

type AssetShelfProps = {
  className?: string;
  /** Which project's listing to render, through the agent assets endpoint. */
  projectId: string;
  /** Freeze item motion to the opacity-only variant while the board morphs. */
  frozen?: boolean;
  /** Lock indicator transitions so highlights track 1:1 mid-morph. */
  transitionLock?: boolean;
  /**
   * Kept for callers that also feed the dock's Pieces section; the shelf
   * itself renders assets only.
   */
  clips?: ClipChoice[];
  onApplyPiece?: (item: ChangesetItem) => string | null;
  onUndoPiece?: (itemId: string) => void;
  onOpenHistory?: () => void;
  pieceRefusal?: string | null;
};

export function AssetShelf({ className, projectId, frozen = false, transitionLock = false }: AssetShelfProps) {
  const reduce = useReducedMotion();
  const listing = useProjectAssets(projectId);
  // Files the user imports with no linked editor ride above the listing.
  // They are session-local: the shelf never writes them into the project.
  const [imports, setImports] = useState<AssetItem[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  // Sizing for the assets list, compact unless the user picked otherwise.
  // Persisted across sessions.
  const [view, setView] = useState<ViewStyle>(loadShelfView);
  useEffect(() => {
    localStorage.setItem(SHELF_VIEW_KEY, view);
  }, [view]);
  const [query, setQuery] = useState("");
  // Below SEARCH_COLLAPSE_PX the field collapses to an icon button; the
  // expanded field overlays the toolbar row so the rows below never shift.
  const [narrow, setNarrow] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const shelfRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  // Escape sets this so focus returns to the toggle once it remounts.
  const refocusToggle = useRef(false);
  useLayoutEffect(() => {
    const node = shelfRef.current;
    if (!node) return;
    const measure = () => {
      const next = node.getBoundingClientRect().width < SEARCH_COLLAPSE_PX;
      setNarrow((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!narrow) setSearchOpen(false);
  }, [narrow]);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (!searchOpen && refocusToggle.current) {
      refocusToggle.current = false;
      searchToggleRef.current?.focus();
    }
  }, [searchOpen]);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [shift, setShift] = useState<Shift>("fade");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const folders = listing.folders;
  const assets: AssetItem[] = useMemo(
    () => [...imports, ...listing.assets.map((asset) => ({ ...asset, scope: "assets" as const }))],
    [imports, listing.assets],
  );
  const filedIds = useMemo(
    () => new Set(folders.flatMap((folder) => folder.assetIds)),
    [folders],
  );
  // First listing in: select the first asset, the way the shelf used to
  // open on its first row. Once only; clearing the selection sticks.
  const didAutoselect = useRef(false);
  useEffect(() => {
    if (didAutoselect.current || listing.phase !== "ready" || selectedIds.length > 0) return;
    const first = assets[0];
    if (!first) return;
    didAutoselect.current = true;
    setSelectedIds([first.id]);
  }, [assets, listing.phase, selectedIds.length]);
  // Hidden items stay in the project but are marked to keep out of model
  // context. Removed items leave the shelf (the file itself is untouched).
  // Both persist so the shelf remembers across sessions.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(
    () => new Set(loadIdList("chair.shelfHidden")),
  );
  const [removedIds, setRemovedIds] = useState<Set<string>>(
    () => new Set(loadIdList("chair.shelfRemoved")),
  );
  useEffect(() => {
    localStorage.setItem("chair.shelfHidden", JSON.stringify([...hiddenIds]));
  }, [hiddenIds]);
  useEffect(() => {
    localStorage.setItem("chair.shelfRemoved", JSON.stringify([...removedIds]));
  }, [removedIds]);
  const toggleHidden = (id: string) => {
    setHiddenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const removeItem = (id: string) => {
    setRemovedIds((current) => new Set(current).add(id));
    setSelectedIds((current) => current.filter((selected) => selected !== id));
  };
  const [selecting, setSelecting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const dragGhost = useRef<HTMLDivElement | null>(null);
  const selectedIdsRef = useRef(selectedIds);
  const marqueeDrag = useRef<{
    pointerId: number;
    origin: { x: number; y: number };
    originClient: { x: number; y: number };
    base: string[];
    moved: boolean;
    held: HTMLElement | null;
    frame: number;
    at: { x: number; y: number } | null;
  } | null>(null);
  selectedIdsRef.current = selectedIds;
  const variants = useMemo(() => paneVariants(reduce), [reduce]);
  const itemMotion = reduce || frozen ? ITEM_STILL : ITEM_MOVE;
  const listMode = reduce || frozen ? "sync" : "popLayout";

  const needle = query.trim().toLowerCase();
  const folder = folders.find((item) => item.id === openFolder) ?? null;
  const paneKey = `${view}:${openFolder ?? "root"}`;

  const folderRows = useMemo(() => {
    if (folder) return [];
    return folders.filter((item) => !removedIds.has(item.id)).filter((item) => {
      const contents = item.assetIds.flatMap((id) => {
        if (removedIds.has(id)) return [];
        const asset = assets.find((entry) => entry.id === id);
        return asset ? [asset] : [];
      });
      const typed = contents.filter(
        (asset) => typeFilter === "all" || asset.kind === typeFilter,
      );
      if (typed.length === 0) return false;
      if (!needle) return true;
      if (item.name.toLowerCase().includes(needle)) return true;
      return typed.some((asset) => asset.name.toLowerCase().includes(needle));
    });
  }, [assets, folder, folders, needle, removedIds, typeFilter]);

  const visible = useMemo(() => {
    const pool = folder
      ? folder.assetIds.flatMap((id) => {
          if (removedIds.has(id)) return [];
          const asset = assets.find((entry) => entry.id === id);
          return asset ? [asset] : [];
        })
      : assets.filter((item) => !filedIds.has(item.id) && !removedIds.has(item.id));
    return pool.filter((item) => {
      if (typeFilter !== "all" && item.kind !== typeFilter) return false;
      return item.name.toLowerCase().includes(needle);
    });
  }, [assets, filedIds, folder, needle, removedIds, typeFilter]);

  const importFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const picked = [...list];
    setShift(openFolder ? "out" : "fade");
    setOpenFolder(null);
    setTypeFilter("all");
    setQuery("");
    // Linked editors take the file through the agent and the shelf
    // re-reads the listing; anything that fails keeps today's
    // session-local staging above the listing instead.
    void (async () => {
      const staged: AssetItem[] = [];
      let landed = 0;
      for (const file of picked) {
        try {
          await importProjectAsset(projectId, file.name, await fileToBase64(file));
          landed += 1;
        } catch {
          const kind = kindFor(file.name);
          staged.push({
            id: `import-${file.name}-${file.size}-${file.lastModified}`,
            scope: "assets",
            name: file.name,
            kind,
            previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
            proxy: "missing",
          });
        }
      }
      if (landed > 0) listing.refresh();
      if (staged.length === 0) return;
      setImports((current) => [...staged, ...current]);
      const first = staged[0];
      if (first) setSelectedIds([first.id]);
    })();
  };

  const contentPoint = (clientX: number, clientY: number) => {
    const root = listRef.current;
    if (!root) return { x: 0, y: 0 };
    const rect = root.getBoundingClientRect();
    return {
      x: clientX - rect.left + root.scrollLeft,
      y: clientY - rect.top + root.scrollTop,
    };
  };

  const hitsIn = (box: Box) => {
    const root = listRef.current;
    if (!root) return [];
    const rootRect = root.getBoundingClientRect();
    const scrollLeft = root.scrollLeft;
    const scrollTop = root.scrollTop;
    const ids: string[] = [];
    for (const node of root.querySelectorAll<HTMLElement>("[data-shelf-id]")) {
      const id = node.dataset.shelfId;
      if (!id) continue;
      const rect = node.getBoundingClientRect();
      const item = {
        x: rect.left - rootRect.left + scrollLeft,
        y: rect.top - rootRect.top + scrollTop,
        w: rect.width,
        h: rect.height,
      };
      if (boxesMeet(box, item)) ids.push(id);
    }
    return ids;
  };

  const paintMarquee = (box: Box | null) => {
    const node = listRef.current?.querySelector<HTMLElement>("[data-shelf-marquee]");
    if (!node) return;
    if (!box) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.style.left = `${box.x}px`;
    node.style.top = `${box.y}px`;
    node.style.width = `${box.w}px`;
    node.style.height = `${box.h}px`;
  };

  const onListPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-shelf-action]")) return;
    if (target.closest("[data-drag-handle], input, textarea")) return;
    const held = target.closest<HTMLElement>("[data-shelf-id]");
    // A press on a selected card drags; the shelf marks exactly those
    // cards draggable, so this is the same rule as the card itself.
    if (
      held?.dataset.shelfId &&
      pressStartsDrag({
        selected: selectedIdsRef.current.includes(held.dataset.shelfId),
        draggable: held.draggable,
      })
    ) {
      return;
    }
    if (!held && target.closest("button")) return;
    // Reachable only for presses the drag rule yields to marquee: the card
    // is not draggable, so there is nothing to disable, and React owns the
    // draggable attribute from here on (never write it from this handler).
    const drag = {
      pointerId: event.pointerId,
      origin: contentPoint(event.clientX, event.clientY),
      originClient: { x: event.clientX, y: event.clientY },
      base: event.shiftKey ? [...selectedIdsRef.current] : [],
      moved: false,
      held,
      frame: 0,
      at: null as { x: number; y: number } | null,
    };
    marqueeDrag.current = drag;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== drag.pointerId) return;
      const dx = move.clientX - drag.originClient.x;
      const dy = move.clientY - drag.originClient.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) setSelecting(true);
      drag.moved = true;
      // Pointer moves fire faster than frames: remember the latest point
      // and do the measure/paint/hit-test once per frame.
      drag.at = { x: move.clientX, y: move.clientY };
      if (drag.frame !== 0) return;
      drag.frame = requestAnimationFrame(() => {
        drag.frame = 0;
        const at = drag.at ?? drag.originClient;
        const root = listRef.current;
        if (root) {
          const bounds = root.getBoundingClientRect();
          if (at.y < bounds.top + 28) root.scrollTop -= 10;
          else if (at.y > bounds.bottom - 28) root.scrollTop += 10;
        }
        const box = normalizeBox(drag.origin, contentPoint(at.x, at.y));
        paintMarquee(box);
        const hits = hitsIn(box);
        const next = drag.base.length === 0 ? hits : [...new Set([...drag.base, ...hits])];
        setSelectedIds((current) => (sameIds(current, next) ? current : next));
      });
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      cancelAnimationFrame(drag.frame);
      if (drag.moved) suppressClick.current = true;
      else if (!drag.held) setSelectedIds([]);
      marqueeDrag.current = null;
      paintMarquee(null);
      setSelecting(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onDownRef = useRef(onListPointerDown);
  onDownRef.current = onListPointerDown;
  const stopListen = useRef<(() => void) | null>(null);

  const bindList = (node: HTMLDivElement | null) => {
    if (node) listRef.current = node;
    if (stopListen.current) return;
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      const root = [...document.querySelectorAll<HTMLDivElement>("[data-shelf-list]")].find((list) =>
        list.contains(event.target as Node),
      );
      if (!root) return;
      listRef.current = root;
      onDownRef.current(event as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    window.addEventListener("pointerdown", onDown, true);
    stopListen.current = () => window.removeEventListener("pointerdown", onDown, true);
  };

  const beginDrag = (event: DragEvent, id: string, label: string, tone: ShelfDragTone) => {
    suppressClick.current = true;
    // Pieces drag from PiecesShelf, never from these rows: no piece ids here.
    const group = dragItemsFor(selectedIdsRef.current, assets, folders, [], id, label, tone);
    writeChairRefs(
      event.dataTransfer,
      group.map((item) => ({ kind: item.refKind, id: item.id, label: item.label })),
    );
    const root = listRef.current;
    for (const item of group) {
      const row = root?.querySelector<HTMLElement>(`[data-shelf-id="${CSS.escape(item.id)}"]`);
      if (row) row.dataset.dragging = "";
    }
    dragGhost.current?.remove();
    const ghost = document.createElement("div");
    const mark = document.createElement("span");
    mark.style.cssText = `width:8px;height:8px;border-radius:999px;background:${GHOST_INK[tone]};flex:none`;
    const name = document.createElement("span");
    const caption = group.length > 1 ? `${group.length} selected` : label;
    name.textContent = caption.length > 28 ? `${caption.slice(0, 18)}…` : caption;
    name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    ghost.append(mark, name);
    ghost.style.cssText = [
      "position:fixed",
      "top:-1000px",
      "left:0",
      "z-index:80",
      "display:inline-flex",
      "align-items:center",
      "gap:8px",
      "max-width:220px",
      "padding:6px 10px",
      "border-radius:10px",
      "border:1px solid rgb(255 255 255 / 12%)",
      "background:#2a2a2a",
      "color:#f5f5f5",
      "font:500 13px/1.2 ui-sans-serif,system-ui,sans-serif",
      "box-shadow:inset 0 1px 0 rgb(255 255 255 / 10%), 0 10px 24px rgb(0 0 0 / 35%)",
    ].join(";");
    document.body.appendChild(ghost);
    dragGhost.current = ghost;
    event.dataTransfer.setDragImage(ghost, 16, 16);
  };

  const finishDrag = () => {
    for (const row of document.querySelectorAll<HTMLElement>("[data-shelf-id][data-dragging]")) {
      delete row.dataset.dragging;
    }
    dragGhost.current?.remove();
    dragGhost.current = null;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const activate = (run: () => void) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    run();
  };

  const showFolder = (id: string) => {
    setShift("in");
    setOpenFolder(id);
  };

  const hideFolder = () => {
    setShift("out");
    setOpenFolder(null);
  };

  const filterLabel = TYPE_FILTERS.find((item) => item.id === typeFilter)?.label ?? "All";
  const searchLabel = "Search assets";
  const viewChoice = VIEWS.find((item) => item.id === view) ?? {
    id: "cards" as const,
    label: "Cards",
    icon: LayoutGrid,
  };
  const ViewIcon = viewChoice.icon;
  // No data at all: the empty state. Data that only filters to
  // nothing keeps the "Nothing matches." line instead.
  const listedCount = folders.length + assets.length;
  const shelfEmpty = listing.phase === "ready" && listedCount === 0;
  const filteredEmpty =
    listing.phase === "ready" &&
    !shelfEmpty &&
    folderRows.length === 0 &&
    visible.length === 0;
  const rowGap = view === "more" ? "gap-1" : view === "compact" ? "gap-1.5" : "gap-2";

  // Shift-click range selection in render order: folders first, then items.
  const orderedIds = useMemo(
    () => [...folderRows.map((item) => item.id), ...visible.map((item) => item.id)],
    [folderRows, visible],
  );
  const anchorRef = useRef<string | null>(null);
  const selectClick = (id: string, shiftKey: boolean) => {
    if (!shiftKey) {
      anchorRef.current = id;
      setSelectedIds([id]);
      return;
    }
    const anchor = anchorRef.current ?? id;
    const from = orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(id);
    if (from < 0 || to < 0) {
      anchorRef.current = id;
      setSelectedIds([id]);
      return;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    setSelectedIds(orderedIds.slice(lo, hi + 1));
  };

  return (
    <section
      ref={shelfRef}
      data-transition-lock={transitionLock ? "true" : undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-[28px] bg-[#1a1a1a] p-5 text-neutral-100 shadow-raised ring-1 ring-white/8",
        className,
      )}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <Film className="size-4 shrink-0 text-neutral-400" />
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-wide text-neutral-100">Assets</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => fileRef.current?.click()}
        >
          <Upload />
          Import
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          multiple
          accept="video/*,image/*,audio/*"
          aria-label="Import assets"
          onChange={(event) => {
            importFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-3 overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      <div className="relative z-20 flex min-w-0 shrink-0 flex-wrap items-center gap-1.5">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="max-w-full min-w-0 shrink overflow-hidden border-white/12"
                  aria-label={`Filter: ${filterLabel}`}
                />
              }
            >
              <ListFilter />
              <span className="min-w-0 truncate">{filterLabel}</span>
              <ChevronDown />
            </MenuTrigger>
            <MenuPopup align="start" className={MENU_POPUP}>
              <MenuRadioGroup
                value={typeFilter}
                onValueChange={(value) => {
                  if (value === "all" || value === "video" || value === "image" || value === "audio") {
                    setTypeFilter(value);
                  }
                }}
              >
                {TYPE_FILTERS.map((item) => (
                  <MenuRadioItem key={item.id} value={item.id} closeOnClick className={MENU_ITEM}>
                    {item.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="max-w-full min-w-0 shrink overflow-hidden border-white/12"
                aria-label={`View: ${viewChoice.label}`}
              />
            }
          >
            <ViewIcon />
            <span className="min-w-0 truncate">{viewChoice.label}</span>
            <ChevronDown />
          </MenuTrigger>
          <MenuPopup align="start" className={MENU_POPUP}>
            <MenuRadioGroup
              value={view}
              onValueChange={(value) => {
                if (value !== "cards" && value !== "compact" && value !== "more") return;
                if (value === view) return;
                setShift("fade");
                setView(value);
              }}
            >
              {VIEWS.map((item) => {
                const Icon = item.icon;
                return (
                  <MenuRadioItem key={item.id} value={item.id} closeOnClick className={MENU_ITEM}>
                    <Icon className="size-3.5" />
                    {item.label}
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        {narrow && !searchOpen ? (
          <Button
            ref={searchToggleRef}
            type="button"
            size="icon-sm"
            variant="ghost"
            className={cn("ml-auto shrink-0 border-white/12", query !== "" && "bg-accent")}
            aria-label={searchLabel}
            onClick={() => setSearchOpen(true)}
          >
            <Search />
          </Button>
        ) : narrow ? (
          <div className="ml-auto size-8 shrink-0 sm:size-7" aria-hidden="true" />
        ) : (
          <SearchField
            value={query}
            placeholder={searchLabel}
            label={searchLabel}
            onChange={setQuery}
          />
        )}
        {narrow && searchOpen ? (
          <div className="absolute inset-0 flex items-center bg-[#1a1a1a]">
            <SearchField
              value={query}
              placeholder={searchLabel}
              label={searchLabel}
              inputRef={searchInputRef}
              onChange={setQuery}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                refocusToggle.current = true;
                setSearchOpen(false);
              }}
              onBlur={() => {
                if (query === "") setSearchOpen(false);
              }}
            />
          </div>
        ) : null}
      </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence custom={shift} initial={false}>
            <motion.div
              key={paneKey}
              custom={shift}
              variants={variants}
              initial="enter"
              animate="center"
              exit="leave"
              className="absolute inset-0 flex min-h-0 flex-col"
            >
              {folder ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mb-1 shrink-0 self-start px-1"
                  aria-label={`Back from ${folder.name}`}
                  onClick={hideFolder}
                >
                  <ChevronLeft />
                  {folder.name}
                </Button>
              ) : null}
              <div
                ref={bindList}
                data-shelf-list=""
                className={cn(
                  "relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-0.5 pb-1 select-none",
                  selecting && "touch-none",
                )}
              >
                {listing.phase === "loading" ? (
                  <ShelfLoading still={reduce || frozen} />
                ) : listing.phase === "error" ? (
                  <ShelfError
                    message={listing.error ?? "Could not load the assets."}
                    onRetry={listing.retry}
                    still={reduce || frozen}
                  />
                ) : shelfEmpty ? (
                  <ShelfEmpty onRetry={listing.retry} still={reduce || frozen} />
                ) : view === "cards" ? (
                  <ul className="relative grid grid-cols-2 content-start gap-2">
                    <AnimatePresence mode={listMode} initial={false}>
                      {folderRows.map((item) => (
                        <motion.li key={item.id} className="min-w-0" {...itemMotion}>
                          <div className="group relative min-w-0">
                            <FolderCard
                              id={item.id}
                              name={item.name}
                              dimmed={hiddenIds.has(item.id)}
                              selected={selectedIds.includes(item.id)}
                              onOpen={(event) =>
                                activate(() => {
                                  if (event.shiftKey) selectClick(item.id, true);
                                  else showFolder(item.id);
                                })
                              }
                              onDragStart={(event) => beginDrag(event, item.id, item.name, "folder")}
                              onDragEnd={finishDrag}
                            />
                            <ShelfCardActions
                              id={item.id}
                              hidden={hiddenIds.has(item.id)}
                              selected={selectedIds.includes(item.id)}
                              removable={false}
                              onHide={toggleHidden}
                              onRemove={removeItem}
                            />
                          </div>
                        </motion.li>
                      ))}
                      {visible.map((item) => (
                        <motion.li key={item.id} className="min-w-0" {...itemMotion}>
                          <div className="group relative min-w-0">
                            <Tile
                              item={item}
                              dimmed={hiddenIds.has(item.id)}
                              selected={selectedIds.includes(item.id)}
                              onSelect={(event) =>
                                activate(() => selectClick(item.id, event.shiftKey))
                              }
                              onDragStart={(event) =>
                                beginDrag(
                                  event,
                                  item.id,
                                  item.name,
                                  item.scope === "assets" ? item.kind : "piece",
                                )
                              }
                              onDragEnd={finishDrag}
                            />
                            <ShelfCardActions
                              id={item.id}
                              hidden={hiddenIds.has(item.id)}
                              selected={selectedIds.includes(item.id)}
                              removable
                              onHide={toggleHidden}
                              onRemove={removeItem}
                            />
                          </div>
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                ) : (
                  <>
                {folderRows.length > 0 ? (
                  <ul className={cn("relative mb-1.5 flex flex-col", rowGap)}>
                    <AnimatePresence mode={listMode} initial={false}>
                      {folderRows.map((item) => {
                        const folderDrag = pressStartsDrag({
                          selected: selectedIds.includes(item.id),
                          draggable: true,
                        });
                        return (
                        <motion.li key={item.id} className="min-w-0" {...itemMotion}>
                          <div className="group relative min-w-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-shelf-id={item.id}
                            aria-pressed={selectedIds.includes(item.id)}
                            data-pressed={selectedIds.includes(item.id) ? "" : undefined}
                            draggable={folderDrag || undefined}
                            className={cn(
                              SHELF_BUTTON,
                              hiddenIds.has(item.id) && "opacity-60",
                              folderDrag && "cursor-grab active:cursor-grabbing",
                              view === "compact" && "h-8 justify-start! gap-3! px-2.5 text-left sm:h-8",
                              view === "more" && "h-8 px-2 text-xs sm:h-8",
                            )}
                            onClick={(event) =>
                              activate(() => {
                                if (event.shiftKey) selectClick(item.id, true);
                                else showFolder(item.id);
                              })
                            }
                            onDragStart={
                              folderDrag
                                ? (event) => beginDrag(event, item.id, item.name, "folder")
                                : undefined
                            }
                            onDragEnd={folderDrag ? finishDrag : undefined}
                          >
                            {folderDrag ? (
                              <DragHandle
                                passive
                                className={cn(
                                  "flex min-w-0 w-full items-center",
                                  view === "more" ? "gap-1.5" : "gap-3",
                                )}
                                onDragStart={(event) => beginDrag(event, item.id, item.name, "folder")}
                                onDragEnd={finishDrag}
                              >
                                <Folder
                                  className={cn(
                                    "shrink-0 text-neutral-400",
                                    view === "more" ? "size-3" : "size-3.5",
                                  )}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate text-left">{item.name}</span>
                                {view === "more" ? (
                                  <span className="shrink-0 text-[10px] font-normal text-neutral-500">
                                    Folder
                                  </span>
                                ) : null}
                              </DragHandle>
                            ) : (
                              <>
                            <DragHandle
                              className="shrink-0 cursor-grab active:cursor-grabbing"
                              onDragStart={(event) => beginDrag(event, item.id, item.name, "folder")}
                              onDragEnd={finishDrag}
                            >
                            <Folder
                              className={cn(
                                "text-neutral-400",
                                view === "more" ? "size-3" : "size-3.5",
                              )}
                              aria-hidden="true"
                            />
                            </DragHandle>
                            <span className="min-w-0 flex-1 truncate text-left">{item.name}</span>
                            {view === "more" ? (
                              <span className="shrink-0 text-[10px] font-normal text-neutral-500">
                                Folder
                              </span>
                            ) : null}
                              </>
                            )}
                          </Button>
                          <ShelfCardActions
                            id={item.id}
                            hidden={hiddenIds.has(item.id)}
                            selected={selectedIds.includes(item.id)}
                            removable={false}
                            onHide={toggleHidden}
                            onRemove={removeItem}
                          />
                          </div>
                        </motion.li>
                        );
                      })}
                    </AnimatePresence>
                  </ul>
                ) : null}
                {visible.length > 0 ? (
                    <ul className={cn("relative flex flex-col", rowGap)}>
                      <AnimatePresence mode={listMode} initial={false}>
                        {visible.map((item) => (
                          <motion.li key={item.id} className="min-w-0" {...itemMotion}>
                            <div className="group relative min-w-0">
                            <Row
                              item={item}
                              dense={view === "more"}
                              dimmed={hiddenIds.has(item.id)}
                              selected={selectedIds.includes(item.id)}
                              onSelect={(event) =>
                              activate(() => selectClick(item.id, event.shiftKey))
                            }
                              onDragStart={(event) =>
                                beginDrag(
                                  event,
                                  item.id,
                                  item.name,
                                  item.scope === "assets" ? item.kind : "piece",
                                )
                              }
                              onDragEnd={finishDrag}
                            />
                            <ShelfCardActions
                              id={item.id}
                              hidden={hiddenIds.has(item.id)}
                              selected={selectedIds.includes(item.id)}
                              removable
                              onHide={toggleHidden}
                              onRemove={removeItem}
                            />
                            </div>
                          </motion.li>
                        ))}
                      </AnimatePresence>
                    </ul>
                ) : null}
                  </>
                )}
                <AnimatePresence initial={false}>
                  {filteredEmpty ? (
                    <motion.p
                      key="empty"
                      className="px-1 text-sm text-neutral-500"
                      {...(reduce || frozen ? FADE_STILL : FADE_MOVE)}
                    >
                      Nothing matches.
                    </motion.p>
                  ) : null}
                </AnimatePresence>
                <div
                  data-shelf-marquee=""
                  hidden
                  aria-hidden="true"
                  className="pointer-events-none absolute z-30 rounded-md border-2 border-white/80 bg-white/25"
                />
              </div>
              <SmoothScrollTarget target={listRef} lerp={0.075} />
            </motion.div>
          </AnimatePresence>
        </div>
        </div>
      </div>
    </section>
  );
}

function DragHandle({
  className,
  onDragStart,
  onDragEnd,
  children,
  passive = false,
}: {
  className?: string;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
  children: ReactNode;
  /** Inert layout when the card itself carries the drag (selected cards). */
  passive?: boolean;
}) {
  return (
    <span
      data-drag-handle={passive ? undefined : ""}
      draggable={!passive}
      className={className}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {children}
    </span>
  );
}

function ShelfAction({
  label,
  onAction,
  children,
}: {
  label: string;
  onAction: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-shelf-action=""
            onClick={(event) => {
              event.stopPropagation();
              onAction();
              // Release focus so focus-within does not hold the overlay
              // open after the click; it hides with the hover from then on.
              event.currentTarget.blur();
            }}
            className="flex size-6 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100 [&_svg]:size-4"
          >
            {children}
          </button>
        }
      />
      <TooltipPopup sideOffset={4}>{label}</TooltipPopup>
    </Tooltip>
  );
}

function ShelfCardActions({
  id,
  hidden,
  selected,
  removable,
  onHide,
  onRemove,
}: {
  id: string;
  hidden: boolean;
  selected: boolean;
  removable: boolean;
  onHide: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  // Pinned open on the selected card only. Everywhere else the actions
  // flip with the hover on the same frame: no opacity transition, and
  // pointer events off while hidden so the invisible buttons never steal
  // row clicks or drags. Focus-within keeps keyboard users covered.
  const pinned = selected;
  const resting =
    "absolute top-1 right-1 z-10 flex gap-0.5 opacity-0 pointer-events-none " +
    "group-focus-within:opacity-100 group-focus-within:pointer-events-auto " +
    "group-hover:opacity-100 group-hover:pointer-events-auto";
  return (
    <div className={pinned ? "absolute top-1 right-1 z-10 flex gap-0.5" : resting}>
      <ShelfAction
        label={hidden ? "Show to model" : "Hide from model"}
        onAction={() => onHide(id)}
      >
        {hidden ? <Eye /> : <EyeOff />}
      </ShelfAction>
      {removable ? (
        <ShelfAction label="Remove from project" onAction={() => onRemove(id)}>
          <Trash2 />
        </ShelfAction>
      ) : null}
    </div>
  );
}

function FolderCard({
  id,
  name,
  dimmed,
  selected,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  id: string;
  name: string;
  dimmed?: boolean;
  selected: boolean;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
}) {
  const cardDrag = pressStartsDrag({ selected, draggable: true });
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-shelf-id={id}
      aria-pressed={selected}
      data-pressed={selected ? "" : undefined}
      draggable={cardDrag || undefined}
      onClick={onOpen}
      onDragStart={cardDrag ? onDragStart : undefined}
      onDragEnd={cardDrag ? onDragEnd : undefined}
      className={cn(
        SHELF_BUTTON,
        dimmed && "opacity-60",
        cardDrag && "cursor-grab active:cursor-grabbing",
        "h-auto flex-col gap-1.5 px-1.5 pt-1.5 pb-2 sm:h-auto",
      )}
    >
      <DragHandle
        passive={cardDrag}
        className={cn(
          "flex aspect-video w-full cursor-grab items-center justify-center overflow-hidden rounded-lg bg-white/8 active:cursor-grabbing",
          PLACEHOLDER,
        )}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <Folder className="size-6 text-neutral-300" aria-hidden="true" />
      </DragHandle>
      <span className="block w-full truncate text-center text-xs font-medium">{name}</span>
    </Button>
  );
}

function Tile({
  item,
  selected,
  dimmed,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  item: ShelfItem;
  selected: boolean;
  dimmed?: boolean;
  onSelect: (event: ReactMouseEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
}) {
  const kind = item.scope === "assets" ? item.kind : null;
  const Icon = kind ? KIND_ICON[kind] : Puzzle;
  const proxied = item.scope === "assets" && item.proxy === "ready";
  const cardDrag = pressStartsDrag({ selected, draggable: true });
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-shelf-id={item.id}
      aria-pressed={selected}
      data-pressed={selected ? "" : undefined}
      draggable={cardDrag || undefined}
      onClick={onSelect}
      onDragStart={cardDrag ? onDragStart : undefined}
      onDragEnd={cardDrag ? onDragEnd : undefined}
      className={cn(
        SHELF_BUTTON,
        dimmed && "opacity-60",
        cardDrag && "cursor-grab active:cursor-grabbing",
        "h-auto flex-col gap-1.5 px-1.5 pt-1.5 pb-2 sm:h-auto",
      )}
    >
      <DragHandle
        passive={cardDrag}
        className={cn(
          "relative flex aspect-video w-full cursor-grab items-center justify-center overflow-hidden rounded-lg active:cursor-grabbing",
          kind ? KIND_FRAME[kind] : "bg-white/8",
          item.scope === "assets" && item.previewUrl ? undefined : PLACEHOLDER,
        )}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        {item.scope === "assets" && item.previewUrl ? (
          <img src={item.previewUrl} alt="" className="size-full object-cover" />
        ) : (
          <Icon
            className={cn("size-6", kind ? KIND_COLOR[kind] : "text-neutral-300")}
            aria-hidden="true"
          />
        )}
        {proxied ? <ProxyBadge className="absolute top-1 left-1" /> : null}
      </DragHandle>
      <span className="block w-full truncate text-center text-xs font-medium">
        {item.name}
      </span>
    </Button>
  );
}

function Row({
  item,
  dense,
  selected,
  dimmed,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  item: ShelfItem;
  dense: boolean;
  selected: boolean;
  dimmed?: boolean;
  onSelect: (event: ReactMouseEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
}) {
  const kind = item.scope === "assets" ? item.kind : null;
  const kindLabel = kind ? KIND_LABEL[kind] : "Piece";
  const cardDrag = pressStartsDrag({ selected, draggable: true });
  const name = <span className="min-w-0 flex-1 truncate text-left font-medium">{item.name}</span>;
  const proxied = item.scope === "assets" && item.proxy === "ready";
  const proxy = proxied ? <ProxyBadge /> : null;
  const meta = dense ? (
    <span className="shrink-0 text-[10px] font-normal text-neutral-500">{kindLabel}</span>
  ) : null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-shelf-id={item.id}
      aria-pressed={selected}
      data-pressed={selected ? "" : undefined}
      draggable={cardDrag || undefined}
      onClick={onSelect}
      onDragStart={cardDrag ? onDragStart : undefined}
      onDragEnd={cardDrag ? onDragEnd : undefined}
      className={cn(
        SHELF_BUTTON,
        dimmed && "opacity-60",
        cardDrag && "cursor-grab active:cursor-grabbing",
        // A badged row reserves the hover-action zone, so the badge
        // never slides under the hide/remove buttons.
        dense
          ? proxied
            ? "h-8 pr-[68px] pl-2 text-xs sm:h-8"
            : "h-8 px-2 text-xs sm:h-8"
          : proxied
            ? "h-8 justify-start! gap-3! pr-[68px] pl-2.5 text-left sm:h-8"
            : "h-8 justify-start! gap-3! px-2.5 text-left sm:h-8",
      )}
    >
      {cardDrag ? (
        <DragHandle
          passive
          className={cn("flex min-w-0 w-full items-center", dense ? "gap-1.5" : "gap-3")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <KindMark kind={kind} dense={dense} />
          {name}
          {proxy}
          {meta}
        </DragHandle>
      ) : (
        <>
          <DragHandle
            className="shrink-0 cursor-grab active:cursor-grabbing"
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          >
            <KindMark kind={kind} dense={dense} />
          </DragHandle>
          {name}
          {proxy}
          {meta}
        </>
      )}
    </Button>
  );
}
