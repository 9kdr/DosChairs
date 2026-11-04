import {
  AudioLines,
  BlocksIcon,
  ChevronLeftIcon,
  Film,
  Folder,
  Image,
  PlusIcon,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { EffectMaker, type ClipChoice } from "@/effects/EffectMaker";
import {
  PIECE_KIND_LABEL,
  fetchPieces,
  type PieceInfo,
} from "@/effects/pieces-api";
import { cn } from "@/lib/utils";
import { writeChairRefs } from "@/lib/chair-ref";
import type { PieceLanding } from "@/effects/effect-model";
import {
  fileToBase64,
  importProjectAsset,
  useProjectAssets,
  type ShelfAsset,
  type ShelfAssetKind,
} from "@/project/assets";
import type { ChangesetItem } from "@chair/timeline-ir";

export type ShelfKind = "all" | "media" | "pieces" | "sounds";

const KINDS: { id: ShelfKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "media", label: "Media" },
  { id: "pieces", label: "Pieces" },
  { id: "sounds", label: "Sounds" },
];

const ASSET_ICON: Record<ShelfAssetKind, LucideIcon> = {
  video: Film,
  image: Image,
  audio: AudioLines,
};

const ASSET_TAG: Record<ShelfAssetKind, string> = {
  video: "Video",
  image: "Still",
  audio: "Audio",
};

function kindFor(name: string): ShelfAssetKind {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"].includes(ext)) return "image";
  if (["wav", "mp3", "aif", "aiff", "flac", "m4a"].includes(ext)) return "audio";
  return "video";
}

function inKind(kind: ShelfKind, asset: ShelfAssetKind): boolean {
  if (kind === "all") return true;
  if (kind === "media") return asset !== "audio";
  if (kind === "sounds") return asset === "audio";
  return false;
}

type ShelfProps = {
  className?: string;
  projectId: string;
  clips?: ClipChoice[];
  onApplyPiece?: (item: ChangesetItem) => string | null;
  onUndoPiece?: (itemId: string) => void;
  onOpenHistory?: () => void;
  pieceRefusal?: string | null;
  landings?: Record<string, PieceLanding>;
  onRecordLanding?: (specId: string, landing: PieceLanding) => void;
  /** Open the Effect Maker as a full page (the Add menu's New piece). */
  onCreate: () => void;
};

/**
 * The one Shelf: kind tabs, one search, one Add menu, and ONE list of
 * rows (icon, name, kind tag) combining folders, assets, and pieces.
 * Effect pieces still open the inline editor; anything can be dragged
 * into the brief with the shared chair-ref contract.
 */
export function Shelf({
  className,
  projectId,
  clips = [],
  onApplyPiece,
  onUndoPiece,
  onOpenHistory,
  pieceRefusal = null,
  landings,
  onRecordLanding,
  onCreate,
}: ShelfProps) {
  const [kind, setKind] = useState<ShelfKind>("all");
  const [query, setQuery] = useState("");
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedPiece, setExpandedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [imports, setImports] = useState<ShelfAsset[]>([]);
  const [pieces, setPieces] = useState<PieceInfo[] | null>(null);
  const [piecesFailure, setPiecesFailure] = useState<string | null>(null);
  const listing = useProjectAssets(projectId);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setPieces(null);
    setPiecesFailure(null);
    void (async () => {
      try {
        const found = await fetchPieces("");
        if (live) setPieces(found);
      } catch (error) {
        if (live) setPiecesFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const reloadPieces = () => {
    setPiecesFailure(null);
    void (async () => {
      try {
        setPieces(await fetchPieces(""));
      } catch (error) {
        setPiecesFailure(error instanceof Error ? error.message : String(error));
      }
    })();
  };

  const importFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setOpenFolder(null);
    setQuery("");
    void (async () => {
      const staged: ShelfAsset[] = [];
      let landed = 0;
      for (const file of [...list]) {
        try {
          await importProjectAsset(projectId, file.name, await fileToBase64(file));
          landed += 1;
        } catch {
          staged.push({
            id: `import-${file.name}-${file.size}-${file.lastModified}`,
            name: file.name,
            kind: kindFor(file.name),
            proxy: "missing",
          });
        }
      }
      if (landed > 0) listing.refresh();
      if (staged.length > 0) setImports((current) => [...staged, ...current]);
    })();
  };

  if (editing) {
    return (
      <div className={cn("flex h-full min-h-0 min-w-0 flex-col gap-3", className)}>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Back to pieces"
            onClick={() => setEditing(null)}
          >
            <ChevronLeftIcon />
            Pieces
          </Button>
          <h2 className="min-w-0 truncate text-sm font-medium text-neutral-100">
            {editing.name}
          </h2>
          <span className="shrink-0 text-xs text-muted-foreground">Effect</span>
        </div>
        <EffectMaker
          clips={clips}
          onApply={onApplyPiece ?? (() => null)}
          onUndo={onUndoPiece ?? (() => undefined)}
          onOpenHistory={onOpenHistory ?? (() => undefined)}
          refusal={pieceRefusal}
          landings={landings}
          onRecordLanding={onRecordLanding}
        />
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const folder = listing.folders.find((item) => item.id === openFolder) ?? null;
  const filedIds = new Set(listing.folders.flatMap((item) => item.assetIds));
  const pool = folder
    ? listing.assets.filter((asset) => folder.assetIds.includes(asset.id))
    : listing.assets.filter((asset) => !filedIds.has(asset.id));
  const assets = [...imports, ...pool].filter(
    (asset) =>
      inKind(kind, asset.kind) &&
      (needle === "" || asset.name.toLowerCase().includes(needle)),
  );
  const showFolders = !folder && kind !== "pieces";
  const folders = showFolders
    ? listing.folders.filter((item) => needle === "" || item.name.toLowerCase().includes(needle))
    : [];
  const showPieces = !folder && (kind === "all" || kind === "pieces");
  const catalog = (pieces ?? []).filter(
    (piece) =>
      needle === "" ||
      piece.name.toLowerCase().includes(needle) ||
      piece.summary.toLowerCase().includes(needle),
  );

  const openPiece = (piece: PieceInfo) => {
    if (piece.kind === "effect") setEditing({ id: piece.id, name: piece.name });
    else setExpandedId(piece.id);
  };

  return (
    <div className={cn("flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-3", className)}>
      <div className="flex shrink-0 items-center gap-2">
        <h2 className="text-sm font-medium text-neutral-200">Shelf</h2>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto shrink-0"
                aria-label="Add to shelf"
              />
            }
          >
            <PlusIcon />
            Add
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              closeOnClick
              onClick={() => fileRef.current?.click()}
            >
              <Upload />
              Import file…
            </MenuItem>
            <MenuItem closeOnClick onClick={onCreate}>
              <BlocksIcon />
              New piece
            </MenuItem>
          </MenuPopup>
        </Menu>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            importFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Tabs
          value={kind}
          onValueChange={(value) => setKind(value as ShelfKind)}
          className="min-w-0 flex-1"
        >
          <TabsList size="sm" aria-label="Shelf filter" className="flex w-full justify-start">
            {KINDS.map((item) => (
              <TabsTab key={item.id} value={item.id} className="min-w-0 flex-1 px-2">
                {item.label}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="shrink-0">
        <Input
          type="search"
          size="sm"
          value={query}
          placeholder="Search the shelf"
          aria-label="Search the shelf"
          onChange={(event) => setQuery(event.target.value)}
          className="border-transparent bg-white/[0.04] dark:bg-white/[0.04]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {listing.phase === "loading" ? (
          <p className="px-1 py-2 text-sm text-neutral-400">Loading the shelf…</p>
        ) : listing.phase === "error" ? (
          <div className="flex flex-col items-start gap-2 rounded-2xl bg-white/[0.03] px-5 py-6">
            <h3 className="text-sm font-medium text-neutral-200">Couldn&apos;t load the shelf</h3>
            <p className="text-sm leading-6 text-neutral-400">{listing.error}</p>
            <Button type="button" size="sm" variant="outline" onClick={listing.retry}>
              Check again
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label="Shelf">
            {folder ? (
              <li>
                <button
                  type="button"
                  onClick={() => setOpenFolder(null)}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-2xl px-3 py-2 text-left text-sm text-neutral-300 outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronLeftIcon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">All files</span>
                </button>
              </li>
            ) : null}
            {folders.map((item) => (
              <li key={item.id}>
                <div
                  role="button"
                  tabIndex={0}
                  draggable
                  onClick={() => setOpenFolder(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setOpenFolder(item.id);
                  }}
                  onDragStart={(event) =>
                    writeChairRefs(event.dataTransfer, [
                      { kind: "asset", id: item.id, label: item.name },
                    ])
                  }
                  className="flex w-full cursor-grab items-center gap-2.5 rounded-2xl bg-white/[0.03] px-3 py-2 text-left outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Folder className="size-4 shrink-0 text-neutral-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                    {item.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">Folder</span>
                </div>
              </li>
            ))}
            {assets.map((item) => {
              const Icon = ASSET_ICON[item.kind];
              const selected = selectedId === item.id;
              return (
                <li key={item.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    draggable
                    aria-pressed={selected}
                    onClick={() => setSelectedId((current) => (current === item.id ? null : item.id))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId((current) => (current === item.id ? null : item.id));
                      }
                    }}
                    onDragStart={(event) =>
                      writeChairRefs(event.dataTransfer, [
                        { kind: "asset", id: item.id, label: item.name },
                      ])
                    }
                    className={cn(
                      "flex w-full cursor-grab items-center gap-2.5 rounded-2xl bg-white/[0.03] px-3 py-2 text-left outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "bg-white/[0.06]",
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-neutral-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                      {item.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {ASSET_TAG[item.kind]}
                    </span>
                  </div>
                </li>
              );
            })}
            {showPieces ? (
              <>
                {pieces === null && piecesFailure ? (
                  <li>
                    <div className="flex flex-col items-start gap-2 rounded-2xl bg-white/[0.03] px-5 py-6">
                      <h3 className="text-sm font-medium text-neutral-200">
                        Couldn&apos;t load pieces
                      </h3>
                      <p className="text-sm leading-6 text-neutral-400">{piecesFailure}</p>
                      <Button type="button" size="sm" variant="outline" onClick={reloadPieces}>
                        Check again
                      </Button>
                    </div>
                  </li>
                ) : null}
                {catalog.map((piece) => {
                  const expanded = expandedPiece === piece.id;
                  return (
                    <li
                      key={piece.id}
                      className={cn(
                        "group rounded-2xl bg-white/[0.03]",
                        expanded && "bg-white/[0.06]",
                      )}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={expanded}
                        draggable
                        title={piece.summary || piece.name}
                        onClick={() =>
                          setExpandedId((current) => (current === piece.id ? null : piece.id))
                        }
                        onDoubleClick={() => openPiece(piece)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") openPiece(piece);
                          else if (event.key === " ") {
                            event.preventDefault();
                            setExpandedId((current) =>
                              current === piece.id ? null : piece.id,
                            );
                          }
                        }}
                        onDragStart={(event) =>
                          writeChairRefs(event.dataTransfer, [
                            { kind: "piece", id: piece.id, label: piece.name },
                          ])
                        }
                        className="flex w-full cursor-grab items-center gap-2.5 rounded-2xl px-3 py-2 text-left outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            piece.source === "user" ? "bg-amber-300" : "bg-neutral-500",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                          {piece.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {PIECE_KIND_LABEL[piece.kind]}
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          aria-label={`Open ${piece.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openPiece(piece);
                          }}
                          className="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          Open
                        </Button>
                      </div>
                      {expanded ? (
                        <div className="px-3 pb-3">
                          <p className="text-xs leading-5 text-neutral-400">
                            {piece.summary || "No description yet."}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {piece.controls.length === 0
                              ? "No published controls — drag it into the brief to use it."
                              : `${piece.controls.length} control${piece.controls.length === 1 ? "" : "s"}: ${piece.controls
                                  .slice(0, 4)
                                  .map((control) => control.name)
                                  .join(", ")}${piece.controls.length > 4 ? "…" : ""}`}
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </>
            ) : null}
            {folders.length === 0 && assets.length === 0 && (!showPieces || catalog.length === 0) ? (
              <li>
                <p className="px-1 py-2 text-sm text-muted-foreground">
                  {needle === "" ? "Nothing here yet." : "Nothing matches."}
                </p>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
}
