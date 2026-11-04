import { MoreHorizontal } from "lucide-react";
import type { Ref } from "react";
import {
  ContextMenu,
  ContextMenuPopup,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { ditherMaskStyle, matrixForSeed } from "@/lib/dither";
import { cn } from "@/lib/utils";
import { EditorLogo } from "./EditorLogo";
import { editorShort, formatEditedAt, type Project } from "./data";

export type ProjectCardProps = {
  project: Project;
  /** True while this card is the hover/focus target in the grid. */
  emphasized?: boolean;
  onOpen?: () => void;
  cardRef?: Ref<HTMLDivElement>;
};

export function ProjectCardActions({
  onOpen,
}: {
  onOpen?: () => void;
}) {
  return (
    <>
      <MenuItem onClick={onOpen}>Open</MenuItem>
      <MenuItem disabled>Rename</MenuItem>
      <MenuItem onClick={() => {}}>Remove from recents</MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => {}}>Reveal in editor</MenuItem>
    </>
  );
}

/** Visual project tile with quiet overflow menu and context menu. */
export function ProjectCard({
  project,
  emphasized = false,
  onOpen,
  cardRef,
}: ProjectCardProps) {
  const editorId = project.editorId;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={cardRef}
            className={cn(
              "group flex w-full flex-col gap-2 text-left",
              "rounded-xl",
            )}
            data-emphasized={emphasized || undefined}
          />
        }
      >
        <div className="relative aspect-[16/10] overflow-hidden rounded-xl bg-card">
          <div className="absolute inset-0 grid place-items-center">
            <EditorLogo
              id={editorId}
              title={editorShort(editorId)}
              className="h-10 w-10 opacity-70 drop-shadow-[0_2px_8px_rgb(0_0_0/0.5)]"
            />
          </div>
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_0%,rgb(255_255_255/0.06),transparent_55%)]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 opacity-50"
            style={{
              backgroundImage:
                "linear-gradient(to bottom, transparent 55%, rgb(0 0 0 / 0.55))",
            }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-white/[0.10]"
            style={ditherMaskStyle(0.35, { matrix: matrixForSeed(project.name) })}
          />

          {/* Quiet overflow control */}
          <div className="absolute top-2 right-2 z-20 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto group-data-[emphasized]:pointer-events-auto">
            <Menu>
              <MenuTrigger
                type="button"
                aria-label={`Actions for ${project.name}`}
                className={cn(
                  "flex size-7 items-center justify-center rounded-lg text-neutral-400 outline-none transition-colors",
                  "bg-card/80 shadow-rim backdrop-blur-md",
                  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[emphasized]:opacity-100",
                  "hover:bg-card hover:text-neutral-100",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  "data-[popup-open]:bg-card data-[popup-open]:text-neutral-100",
                  "data-[popup-open]:opacity-100 data-[popup-open]:pointer-events-auto",
                )}
              >
                <MoreHorizontal className="size-4" />
              </MenuTrigger>
              <MenuPopup
                align="end"
                sideOffset={4}
                className="min-w-44 rounded-xl border border-white/10 bg-popover/95 p-1 text-neutral-100 ring-1 ring-white/[0.08] backdrop-blur-md"
              >
                <ProjectCardActions onOpen={onOpen} />
              </MenuPopup>
            </Menu>
          </div>
        </div>

        <div className="min-w-0 px-0.5">
          <p className="truncate text-sm font-medium text-neutral-100">{project.name}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <EditorLogo id={editorId} className="size-3.5" />
            <span className="sr-only">{editorShort(editorId)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={project.editedAt}>{formatEditedAt(project.editedAt)}</time>
          </p>
        </div>
      </ContextMenuTrigger>
      <ContextMenuPopup
        align="start"
        className="min-w-44 rounded-xl border border-white/10 bg-popover/95 p-1 text-neutral-100 ring-1 ring-white/[0.08] backdrop-blur-md"
      >
        <ProjectCardActions onOpen={onOpen} />
      </ContextMenuPopup>
    </ContextMenu>
  );
}
