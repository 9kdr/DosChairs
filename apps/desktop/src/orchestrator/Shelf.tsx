import {
  AudioLines,
  BlocksIcon,
  ChevronLeftIcon,
  Film,
  Folder,
  Image,
  ListFilter,
  Palette,
  PlusIcon,
  Sparkles,
  Upload,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InfoHint } from "@/components/info-hint";
import { Input } from "@/components/ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import { EffectMaker, type ClipChoice } from "@/effects/EffectMaker";
import {
  PIECE_KIND_LABEL,
  fetchPieces,
  type PieceInfo,
  type PieceKind,
} from "@/effects/pieces-api";
import { cn } from "@/lib/utils";
import { writeChairRefs } from "@/lib/chair-ref";
import { setPillDragImage } from "@/lib/drag-pill";
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
  return false; // Pieces tab: files stay out.
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
 * The one Shelf: a kind filter next to one search, one Add menu, and ONE list of
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
        <EffectMaker
          clips={clips}
          onApply={onApplyPiece ?? (() => null)}
          onUndo={onUndoPiece ?? (() => undefined)}
          onOpenHistory={onOpenHistory ?? (() => undefined)}
          refusal={pieceRefusal}
          landings={landings}
          onRecordLanding={onRecordLanding}
          piece={{ id: editing.id, name: editing.name }}
          onBack={() => setEditing(null)}
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
  const showFolders = !folder && kind !== "pieces" && kind !== "sounds";
  const folders = showFolders
    ? listing.folders.filter((item) => needle === "" || item.name.toLowerCase().includes(needle))
    : [];
  // Sound pieces live under Sounds too, next to the audio files.
  const showPieces = !folder && kind !== "media";
  const catalog = (pieces ?? []).filter(
    (piece) =>
      (kind !== "sounds" || piece.kind === "sound") &&
      (needle === "" ||
        piece.name.toLowerCase().includes(needle) ||
        piece.summary.toLowerCase().includes(needle)),
  );

  const openPiece = (piece: PieceInfo) => {
    if (piece.kind === "effect") setEditing({ id: piece.id, name: piece.name });
    else setExpandedId(piece.id);
  };
  const importHere = () => fileRef.current?.click();
  const nothing = folders.length === 0 && assets.length === 0 && (!showPieces || catalog.length === 0);
  const emptyCopy: Record<ShelfKind, { title: string; body: string }> = {
    all: { title: "The shelf is empty", body: "Import footage, stills and audio, or make a piece." },
    media: { title: "No media yet", body: "Import footage or stills to drag into the bar." },
    pieces: { title: "No pieces yet", body: "A piece is a reusable look, effect or motion." },
    sounds: { title: "No sounds yet", body: "Import audio, or ask Chair for a sting in the bar." },
  };

  return (
    <div className={cn("flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-3", className)}>
      <div className="flex shrink-0 items-center gap-1">
        <h2 className="text-title font-medium text-neutral-100">Shelf</h2>
        <InfoHint>
          Drag a row into the command bar, or type @ in it, to point Chair at it. Double-click
          an effect to open it in the maker.
        </InfoHint>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto shrink-0 text-muted-foreground hover:text-neutral-100"
                aria-label="Add to shelf"
              />
            }
          >
            <PlusIcon />
            Add
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem closeOnClick onClick={importHere}>
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
        <Input
          type="search"
          size="sm"
          value={query}
          placeholder="Search the shelf"
          aria-label="Search the shelf"
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 border-transparent bg-white/[0.04] dark:bg-white/[0.04]"
        />
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                aria-label={`Filter the shelf, showing ${KINDS.find((item) => item.id === kind)?.label ?? "All"}`}
              />
            }
          >
            <ListFilter />
            {kind === "all" ? null : (
              <>
                <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                {KINDS.find((item) => item.id === kind)?.label}
              </>
            )}
          </MenuTrigger>
          <MenuPopup align="end" aria-label="Shelf filter">
            <MenuGroup>
              <MenuGroupLabel>Show</MenuGroupLabel>
              <MenuRadioGroup
                value={kind}
                onValueChange={(value) => setKind(value as ShelfKind)}
              >
                {KINDS.map((item) => (
                  <MenuRadioItem key={item.id} value={item.id} closeOnClick>
                    {item.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </div>
      <div className="-mr-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2">
        {listing.phase === "loading" ? (
          <p className="px-1 py-2 text-meta text-neutral-400">Loading the shelf…</p>
        ) : listing.phase === "error" ? (
          <ShelfNotice
            title="Couldn't load the shelf"
            body={listing.error ?? ""}
            action="Check again"
            onAction={listing.retry}
          />
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Shelf">
            {folder ? (
              <li>
                <button
                  type="button"
                  onClick={() => setOpenFolder(null)}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-left text-body text-neutral-300 outline-none transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="grid size-8 shrink-0 place-items-center">
                    <ChevronLeftIcon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">All files</span>
                </button>
              </li>
            ) : null}
            {folders.map((item) => (
              <ShelfRow
                key={item.id}
                icon={Folder}
                name={item.name}
                tag="Folder"
                hint="Open folder"
                onActivate={() => setOpenFolder(item.id)}
                refs={[{ kind: "asset", id: item.id, label: item.name }]}
              />
            ))}
            {assets.map((item) => (
              <ShelfRow
                key={item.id}
                icon={ASSET_ICON[item.kind]}
                name={item.name}
                tag={ASSET_TAG[item.kind]}
                selected={selectedId === item.id}
                onActivate={() => setSelectedId((current) => (current === item.id ? null : item.id))}
                refs={[{ kind: "asset", id: item.id, label: item.name }]}
              />
            ))}
            {showPieces && pieces === null && piecesFailure ? (
              <li>
                <ShelfNotice
                  title="Couldn't load pieces"
                  body={piecesFailure}
                  action="Check again"
                  onAction={reloadPieces}
                />
              </li>
            ) : null}
            {showPieces
              ? catalog.map((piece) => {
                  const expanded = expandedPiece === piece.id;
                  return (
                    <ShelfRow
                      key={piece.id}
                      icon={PIECE_ICON[piece.kind]}
                      name={piece.name}
                      tag={PIECE_KIND_LABEL[piece.kind]}
                      hint={piece.summary || piece.name}
                      expanded={expanded}
                      onActivate={() =>
                        setExpandedId((current) => (current === piece.id ? null : piece.id))
                      }
                      onOpen={() => openPiece(piece)}
                      refs={[{ kind: "piece", id: piece.id, label: piece.name }]}
                      action={
                        piece.kind === "effect" ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-label={`Open ${piece.name} in the maker`}
                            onClick={(event) => {
                              event.stopPropagation();
                              openPiece(piece);
                            }}
                            className="shrink-0 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-neutral-100 focus-visible:opacity-100"
                          >
                            Open
                          </Button>
                        ) : null
                      }
                      detail={
                        expanded ? (
                          <div className="px-[3.25rem] pb-2.5">
                            <p className="text-meta leading-5 text-neutral-300">
                              {piece.summary || "No description yet."}
                            </p>
                            <p className="mt-1 text-meta text-muted-foreground">
                              {piece.source === "user" ? "Made by you" : "Built in"}
                              {" · "}
                              {piece.controls.length === 0
                                ? "drag it into the bar to use it"
                                : `${piece.controls.length} control${piece.controls.length === 1 ? "" : "s"}: ${piece.controls
                                    .slice(0, 4)
                                    .map((control) => control.name)
                                    .join(", ")}${piece.controls.length > 4 ? "…" : ""}`}
                            </p>
                          </div>
                        ) : null
                      }
                    />
                  );
                })
              : null}
            {nothing ? (
              <li>
                {needle !== "" ? (
                  <ShelfNotice
                    title="Nothing matches"
                    body={`No ${kind === "all" ? "item" : KINDS.find((item) => item.id === kind)?.label.toLowerCase()} named “${query.trim()}”.`}
                    action="Clear search"
                    onAction={() => setQuery("")}
                  />
                ) : (
                  <ShelfNotice
                    title={emptyCopy[kind].title}
                    body={emptyCopy[kind].body}
                    action={kind === "pieces" ? "New piece" : "Import file…"}
                    onAction={kind === "pieces" ? onCreate : importHere}
                    secondary={kind === "all" ? { label: "New piece", run: onCreate } : undefined}
                  />
                )}
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The one icon per piece kind, so pieces get the same leading slot as media. */
const PIECE_ICON: Record<PieceKind, LucideIcon> = {
  macro: BlocksIcon,
  effect: Sparkles,
  motion: Waypoints,
  sound: AudioLines,
  look: Palette,
};

/**
 * One shelf row: the same leading slot (icon), name, and a right-aligned
 * kind tag for media, folders and pieces. Draggable into the bar.
 */
function ShelfRow({
  icon: Icon,
  name,
  tag,
  hint,
  selected = false,
  expanded,
  refs,
  action,
  detail,
  onActivate,
  onOpen,
}: {
  icon: LucideIcon;
  name: string;
  tag: string;
  hint?: string;
  selected?: boolean;
  /** Set on rows that expand; drives aria-expanded. */
  expanded?: boolean;
  refs: Parameters<typeof writeChairRefs>[1];
  action?: ReactNode;
  detail?: ReactNode;
  onActivate: () => void;
  /** Enter and double-click open the row (pieces only). */
  onOpen?: () => void;
}) {
  return (
    <li
      className={cn(
        "group rounded-xl transition-colors hover:bg-white/[0.05]",
        (selected || expanded) && "bg-white/[0.06]",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        draggable
        title={hint ?? "Drag into the command bar"}
        aria-expanded={expanded}
        aria-pressed={expanded === undefined && !onOpen ? selected : undefined}
        onClick={onActivate}
        onDoubleClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            (onOpen ?? onActivate)();
          } else if (event.key === " ") {
            event.preventDefault();
            onActivate();
          }
        }}
        onDragStart={(event) => {
          writeChairRefs(event.dataTransfer, refs);
          setPillDragImage(event.dataTransfer, refs[0]?.label ?? name, "#a3a3a3");
        }}
        className="flex w-full cursor-grab items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-neutral-400">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate text-body text-neutral-100">{name}</span>
        {action}
        <span className="w-16 shrink-0 text-right text-meta text-muted-foreground">{tag}</span>
      </div>
      {detail}
    </li>
  );
}

function ShelfNotice({
  title,
  body,
  action,
  onAction,
  secondary,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  secondary?: { label: string; run: () => void };
}) {
  return (
    <Empty className="items-start gap-3 px-1 py-4 text-left md:py-4">
      <EmptyHeader className="items-start text-left">
        <EmptyTitle className="text-body font-medium text-neutral-200">{title}</EmptyTitle>
        <EmptyDescription className="text-meta">{body}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onAction}>
          {action}
        </Button>
        {secondary ? (
          <Button type="button" size="sm" variant="ghost" onClick={secondary.run}>
            {secondary.label}
          </Button>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}
