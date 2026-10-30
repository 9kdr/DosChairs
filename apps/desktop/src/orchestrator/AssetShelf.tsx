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
  Upload,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type AssetKind = "video" | "image" | "audio";
type Scope = "assets" | "pieces";
type TypeFilter = "all" | AssetKind;
type ViewStyle = "cards" | "compact" | "more";
type Shift = "fade" | "in" | "out";

type AssetItem = {
  id: string;
  scope: "assets";
  name: string;
  kind: AssetKind;
  previewUrl?: string;
};

type PieceItem = {
  id: string;
  scope: "pieces";
  name: string;
};

type ShelfItem = AssetItem | PieceItem;

type FolderItem = {
  id: string;
  name: string;
  assetIds: readonly string[];
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

const STARTER_ASSETS: AssetItem[] = [
  { id: "a1", scope: "assets", name: "A001_C004_1024_RAW.mov", kind: "video" },
  { id: "a2", scope: "assets", name: "interview_sync_take1.mov", kind: "video" },
  { id: "a3", scope: "assets", name: "b_roll_desk_overhead.mp4", kind: "video" },
  { id: "a4", scope: "assets", name: "hero_frame_graded.png", kind: "image" },
  { id: "a5", scope: "assets", name: "title_card_clean.png", kind: "image" },
  { id: "a6", scope: "assets", name: "dialogue_clean_stem.wav", kind: "audio" },
  { id: "a7", scope: "assets", name: "score_temp_v3.mp3", kind: "audio" },
];

const FOLDERS: readonly FolderItem[] = [
  { id: "interview", name: "Interview", assetIds: ["a2", "a6"] },
  { id: "broll", name: "B-roll", assetIds: ["a3", "a4", "a5"] },
];

const FILED_IDS = new Set(FOLDERS.flatMap((folder) => folder.assetIds));

const PIECES: PieceItem[] = [
  { id: "p1", scope: "pieces", name: "Lower third" },
  { id: "p2", scope: "pieces", name: "Caption lockup" },
  { id: "p3", scope: "pieces", name: "Hook card" },
  { id: "p4", scope: "pieces", name: "Face hold" },
  { id: "p5", scope: "pieces", name: "Room grade" },
];

const CHAIR_REF = "application/x-chair-ref";

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

const GHOST_INK: Record<AssetKind | "folder", string> = {
  video: "#60a5fa",
  image: "#fbbf24",
  audio: "#34d399",
  folder: "#d4d4d4",
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

function setChairRefs(transfer: DataTransfer, refs: { id: string; label: string }[]) {
  const payload = refs.map((ref) => ({ kind: "asset" as const, id: ref.id, label: ref.label }));
  transfer.setData(CHAIR_REF, JSON.stringify(payload.length === 1 ? payload[0] : payload));
  transfer.effectAllowed = "copy";
}

type AssetShelfProps = {
  className?: string;
  /** Freeze item motion to the opacity-only variant while the board morphs. */
  frozen?: boolean;
  /** Lock indicator transitions so highlights track 1:1 mid-morph. */
  transitionLock?: boolean;
};

export function AssetShelf({ className, frozen = false, transitionLock = false }: AssetShelfProps) {
  const reduce = useReducedMotion();
  const [assets, setAssets] = useState(STARTER_ASSETS);
  const [scope, setScope] = useState<Scope>("assets");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  // One sizing shared by assets and pieces, compact unless the user picked
  // otherwise. Persisted across sessions.
  const [view, setView] = useState<ViewStyle>(loadShelfView);
  useEffect(() => {
    localStorage.setItem(SHELF_VIEW_KEY, view);
  }, [view]);
  const [query, setQuery] = useState("");
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [shift, setShift] = useState<Shift>("fade");
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    STARTER_ASSETS[0] ? [STARTER_ASSETS[0].id] : [],
  );
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
    wasDraggable: boolean;
    frame: number;
    at: { x: number; y: number } | null;
  } | null>(null);
  selectedIdsRef.current = selectedIds;
  const variants = useMemo(() => paneVariants(reduce), [reduce]);
  const itemMotion = reduce || frozen ? ITEM_STILL : ITEM_MOVE;
  const listMode = reduce || frozen ? "sync" : "popLayout";

  const needle = query.trim().toLowerCase();
  const folder = FOLDERS.find((item) => item.id === openFolder) ?? null;
  const paneKey = `${scope}:${view}:${openFolder ?? "root"}`;

  const folderRows = useMemo(() => {
    if (scope !== "assets" || folder) return [];
    return FOLDERS.filter((item) => !removedIds.has(item.id)).filter((item) => {
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
  }, [assets, folder, needle, removedIds, scope, typeFilter]);

  const visible = useMemo(() => {
    if (scope === "pieces") {
      return PIECES.filter(
        (item) => !removedIds.has(item.id) && item.name.toLowerCase().includes(needle),
      );
    }
    const pool = folder
      ? folder.assetIds.flatMap((id) => {
          if (removedIds.has(id)) return [];
          const asset = assets.find((entry) => entry.id === id);
          return asset ? [asset] : [];
        })
      : assets.filter((item) => !FILED_IDS.has(item.id) && !removedIds.has(item.id));
    return pool.filter((item) => {
      if (typeFilter !== "all" && item.kind !== typeFilter) return false;
      return item.name.toLowerCase().includes(needle);
    });
  }, [assets, folder, needle, removedIds, scope, typeFilter]);

  const importFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const next: AssetItem[] = [];
    for (const file of list) {
      const kind = kindFor(file.name);
      next.push({
        id: `import-${file.name}-${file.size}-${file.lastModified}`,
        scope: "assets",
        name: file.name,
        kind,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
      });
    }
    setShift(openFolder ? "out" : "fade");
    setAssets((current) => [...next, ...current]);
    setScope("assets");
    setOpenFolder(null);
    setTypeFilter("all");
    setQuery("");
    const first = next[0];
    if (first) setSelectedIds([first.id]);
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
    if (
      held?.dataset.shelfId &&
      held.draggable &&
      selectedIdsRef.current.includes(held.dataset.shelfId)
    ) {
      return;
    }
    if (!held && target.closest("button")) return;
    const wasDraggable = held?.draggable ?? false;
    if (held) held.draggable = false;
    const drag = {
      pointerId: event.pointerId,
      origin: contentPoint(event.clientX, event.clientY),
      originClient: { x: event.clientX, y: event.clientY },
      base: event.shiftKey ? [...selectedIdsRef.current] : [],
      moved: false,
      held,
      wasDraggable,
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
      if (drag.held) drag.held.draggable = drag.wasDraggable;
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

  const dragItemsFor = (id: string, label: string, tone: AssetKind | "folder") => {
    const chosen = selectedIdsRef.current;
    if (!chosen.includes(id) || chosen.length < 2) return [{ id, label, tone }];
    const group: { id: string; label: string; tone: AssetKind | "folder" }[] = [];
    for (const sid of chosen) {
      const asset = assets.find((item) => item.id === sid);
      if (asset) {
        group.push({ id: sid, label: asset.name, tone: asset.kind });
        continue;
      }
      const folderItem = FOLDERS.find((item) => item.id === sid);
      if (folderItem) group.push({ id: sid, label: folderItem.name, tone: "folder" });
    }
    return group.length > 0 ? group : [{ id, label, tone }];
  };

  const beginDrag = (
    event: DragEvent,
    id: string,
    label: string,
    tone: AssetKind | "folder",
  ) => {
    suppressClick.current = true;
    const group = dragItemsFor(id, label, tone);
    setChairRefs(event.dataTransfer, group);
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
  const viewChoice = VIEWS.find((item) => item.id === view) ?? {
    id: "cards" as const,
    label: "Cards",
    icon: LayoutGrid,
  };
  const ViewIcon = viewChoice.icon;
  const empty = folderRows.length === 0 && visible.length === 0;
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
      data-transition-lock={transitionLock ? "true" : undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-[28px] bg-[#1a1a1a] p-5 text-neutral-100 shadow-raised ring-1 ring-white/8",
        className,
      )}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <Film className="size-4 shrink-0 text-neutral-400" />
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-wide text-neutral-100">Search</h2>
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
      <Tabs
        value={scope}
        onValueChange={(value) => {
          setShift("fade");
          setScope(value as Scope);
        }}
      >
        <TabsList size="sm" className="grid w-full grid-cols-2">
          <TabsTab value="assets">Assets</TabsTab>
          <TabsTab value="pieces">Pieces</TabsTab>
        </TabsList>
      </Tabs>

      <div className="relative z-20 flex min-w-0 shrink-0 flex-wrap items-center gap-1.5">
        {scope === "assets" ? (
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
        ) : null}
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
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-500" />
          <Input
            type="search"
            size="sm"
            value={query}
            placeholder={scope === "assets" ? "Search assets" : "Search pieces"}
            aria-label={scope === "assets" ? "Search assets" : "Search pieces"}
            className="**:data-[slot=input]:pl-8"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
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
              {scope === "assets" && folder ? (
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
                {view === "cards" ? (
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
                              onDragStart={(event) => {
                                if (item.scope !== "assets") return;
                                beginDrag(event, item.id, item.name, item.kind);
                              }}
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
                      {folderRows.map((item) => (
                        <motion.li key={item.id} className="min-w-0" {...itemMotion}>
                          <div className="group relative min-w-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-shelf-id={item.id}
                            aria-pressed={selectedIds.includes(item.id)}
                            data-pressed={selectedIds.includes(item.id) ? "" : undefined}
                            className={cn(
                              SHELF_BUTTON,
                              hiddenIds.has(item.id) && "opacity-60",
                              selectedIds.includes(item.id) && "cursor-grab active:cursor-grabbing",
                              view === "compact" && "h-8 justify-start! gap-3! px-2.5 text-left sm:h-8",
                              view === "more" && "h-8 px-2 text-xs sm:h-8",
                            )}
                            onClick={(event) =>
                              activate(() => {
                                if (event.shiftKey) selectClick(item.id, true);
                                else showFolder(item.id);
                              })
                            }
                          >
                            {selectedIds.includes(item.id) ? (
                              <DragHandle
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
                      ))}
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
                              onDragStart={(event) => {
                                if (item.scope !== "assets") return;
                                beginDrag(event, item.id, item.name, item.kind);
                              }}
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
                  {empty ? (
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
}: {
  className?: string;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
  children: ReactNode;
}) {
  return (
    <span
      data-drag-handle=""
      draggable
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
  const pinned = hidden || selected;
  return (
    <div
      className={
        pinned
          ? "absolute top-1 right-1 z-10 flex gap-0.5"
          : "absolute top-1 right-1 z-10 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      }
    >
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
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-shelf-id={id}
      aria-pressed={selected}
      data-pressed={selected ? "" : undefined}
      onClick={onOpen}
      className={cn(SHELF_BUTTON, dimmed && "opacity-60", "h-auto flex-col gap-1.5 px-1.5 pt-1.5 pb-2 sm:h-auto")}
    >
      <DragHandle
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
  const draggable = item.scope === "assets";
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-shelf-id={item.id}
      aria-pressed={selected}
      data-pressed={selected ? "" : undefined}
      onClick={onSelect}
      className={cn(SHELF_BUTTON, dimmed && "opacity-60", "h-auto flex-col gap-1.5 px-1.5 pt-1.5 pb-2 sm:h-auto")}
    >
      {draggable ? (
      <DragHandle
        className={cn(
          "flex aspect-video w-full cursor-grab items-center justify-center overflow-hidden rounded-lg active:cursor-grabbing",
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
      </DragHandle>
      ) : (
      <span
        className={cn(
          "flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg",
          "bg-white/8",
          PLACEHOLDER,
        )}
      >
        <Icon className="size-6 text-neutral-300" aria-hidden="true" />
      </span>
      )}
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
  const draggable = item.scope === "assets";
  const dragRow = draggable && selected;
  const name = <span className="min-w-0 flex-1 truncate text-left font-medium">{item.name}</span>;
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
      onClick={onSelect}
      className={cn(
        SHELF_BUTTON,
        dimmed && "opacity-60",
        dragRow && "cursor-grab active:cursor-grabbing",
        dense ? "h-8 px-2 text-xs sm:h-8" : "h-8 justify-start! gap-3! px-2.5 text-left sm:h-8",
      )}
    >
      {dragRow ? (
        <DragHandle
          className={cn("flex min-w-0 w-full items-center", dense ? "gap-1.5" : "gap-3")}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <KindMark kind={kind} dense={dense} />
          {name}
          {meta}
        </DragHandle>
      ) : (
        <>
          {draggable ? (
            <DragHandle
              className="shrink-0 cursor-grab active:cursor-grabbing"
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            >
              <KindMark kind={kind} dense={dense} />
            </DragHandle>
          ) : (
            <KindMark kind={kind} dense={dense} />
          )}
          {name}
          {meta}
        </>
      )}
    </Button>
  );
}
