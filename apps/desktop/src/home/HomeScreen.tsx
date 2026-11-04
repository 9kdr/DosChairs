import { RefreshCwIcon } from "lucide-react";
import packageJson from "../../package.json";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { DitherArt } from "@/components/dither-art";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { Button } from "@/components/ui/button";
import { Empty, EmptyArt } from "@/components/ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChairMark } from "./ChairMark";
import { EditorLogo } from "./EditorLogo";
import { GridSizeToggle } from "./GridSizeToggle";
import {
  DEFAULT_GRID_SIZE,
  GRID_SIZE_LAYOUT,
  columnsForWidth,
  maxGridSizeForWidth,
  readStoredGridSize,
  writeStoredGridSize,
  type GridSize,
} from "./grid-size";
import {
  editorName,
  editorShort,
  type EditorInfo,
  type EditorStatus,
  type Project,
} from "./data";
import { HomeDock, type HomeTab } from "./HomeDock";
import { openProjectInEditor } from "./projects";
import { ProjectCard } from "./ProjectCard";
import { PiecesShelf } from "../effects/PiecesShelf";
import { SettingsScreen } from "../settings/SettingsScreen";
import { useElementWidth } from "./use-element-width";
import { useProjects } from "./useProjects";

type HomeScreenProps = {
  onOpenProject: (projectId: string) => void;
};

const STATUS_LABEL: Record<EditorStatus, string> = {
  inProject: "In project",
  idle: "Idle",
  stopped: "Stopped",
};

const STATUS_DOT: Record<EditorStatus, string> = {
  inProject: "bg-success",
  idle: "bg-warning",
  stopped: "bg-neutral-500",
};

export function HomeScreen({ onOpenProject }: HomeScreenProps) {
  const [tab, setTab] = useState<HomeTab>("projects");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <section
      aria-label="Home"
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-neutral-100"
    >
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="px-6 pt-6 pb-28">
          {settingsOpen ? (
            <SettingsScreen onBack={() => setSettingsOpen(false)} />
          ) : (
            <>
              {tab === "projects" ? (
                <ProjectsPane onOpenProject={onOpenProject} />
              ) : null}
              {tab === "pieces" ? (
                <div className="mx-auto flex h-[calc(100dvh-12rem)] min-h-96 w-full max-w-5xl flex-col">
                  <PiecesShelf />
                </div>
              ) : null}
              {tab === "marketplace" ? <PlaceholderPane title="Marketplace" /> : null}
            </>
          )}
        </div>
      </div>
      <SmoothScrollTarget target={scrollRef} lerp={0.075} />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24"
        style={{
          background: `linear-gradient(to top, var(--background) 0%, color-mix(in srgb, var(--background) 85%, transparent) 55%, transparent 100%)`, // taste-skill-ignore: scrim so scrolled cards never collide with the floating dock.
        }}
      />

      <div className="pointer-events-none absolute bottom-5 left-5 z-20 flex items-center text-neutral-400">
        <ChairMark className="h-8 w-auto text-neutral-200" />
      </div>

      <div className="pointer-events-none absolute bottom-5 right-5 z-20 flex h-8 items-center text-xs text-neutral-500">
        v{packageJson.version}
      </div>

      <HomeDock
        tab={tab}
        settingsOpen={settingsOpen}
        onTab={(next) => {
          setTab(next);
          setSettingsOpen(false);
        }}
        onSettings={() => setSettingsOpen(true)}
      />
    </section>
  );
}

function ProjectsPane({
  onOpenProject,
}: {
  onOpenProject: (projectId: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  // Measured on the pane, which mounts with the skeleton: the grid itself
  // mounts only once projects arrive, after the observer would attach.
  const paneRef = useRef<HTMLDivElement>(null);
  const gridWidth = useElementWidth(paneRef);
  const maxSize = maxGridSizeForWidth(gridWidth);
  // Preferred snap (persisted). Display may clamp below this on a narrow shell.
  const [preferredSize, setPreferredSize] = useState<GridSize>(() =>
    readStoredGridSize(DEFAULT_GRID_SIZE),
  );
  // Keep `layout` measuring always. Only spring when the *toggle* moves —
  // width-driven column changes stay instant so window resize does not flicker.
  const springFromToggle = useRef(false);
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  const size = Math.min(preferredSize, maxSize) as GridSize;
  const layout = GRID_SIZE_LAYOUT[size];
  const columns = columnsForWidth(gridWidth, size);

  const onGridSize = (next: GridSize) => {
    springFromToggle.current = true;
    setPreferredSize(next);
    writeStoredGridSize(next);
    setLayoutEpoch((n) => n + 1);
  };

  useEffect(() => {
    if (!springFromToggle.current) return;
    // Hold the spring through the rearrange; clear after it settles so a
    // later window resize does not re-trigger FLIP.
    const timer = window.setTimeout(() => {
      springFromToggle.current = false;
    }, 480);
    return () => window.clearTimeout(timer);
  }, [layoutEpoch]);

  const layoutTransition =
    springFromToggle.current && !reduceMotion
      ? { type: "spring" as const, stiffness: 280, damping: 26, mass: 0.65 }
      : { duration: 0 };

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Long ease-out so emphasis and neighbor dim settle as one glide.
  const hoverEase = {
    type: "tween" as const,
    duration: 0.65,
    ease: [0.22, 1, 0.36, 1] as const,
  };

  const detected = useProjects();

  // Issue #314: the card asks the editor to open the project first and
  // Home enters it only when the editor confirms. One open at a time;
  // a failure leaves a plain message on the card and stays on Home.
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const handleOpen = (project: Project) => {
    if (openingId !== null) return;
    if (project.editorId === "otio") {
      // Interchange has no editor app to confirm; enter directly.
      onOpenProject(project.id);
      return;
    }
    setOpeningId(project.id);
    setOpenError((current) =>
      current?.id === project.id ? null : current,
    );
    void openProjectInEditor(project).then(
      () => {
        setOpeningId(null);
        onOpenProject(project.id);
      },
      (error: unknown) => {
        setOpeningId(null);
        setOpenError({
          id: project.id,
          message:
            error instanceof Error ? error.message : "the editor did not answer",
        });
      },
    );
  };

  return (
    <motion.div
      ref={paneRef}
      className="mx-auto flex w-full max-w-5xl flex-col gap-8"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <EditorsStrip editors={detected.editors} />
      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-neutral-400">Recent projects</h2>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={detected.scanning}
              onClick={detected.rescan}
            >
              <RefreshCwIcon aria-hidden="true" />
              Rescan
            </Button>
            <GridSizeToggle value={size} max={maxSize} onChange={onGridSize} />
          </div>
        </div>
        {detected.phase === "loading" ? (
          <ProjectsSkeleton columns={columns} gapClass={layout.gapClass} />
        ) : detected.phase === "error" ? (
          <ProjectsNotice
            title="Couldn't reach the agent"
            body="The agent didn't answer. Start it and try again."
            actionLabel="Retry"
            onAction={detected.rescan}
          />
        ) : detected.projects.length === 0 ? (
          <ProjectsNotice
            title={
              detected.editors.every((editor) => editor.status === "stopped")
                ? "No editors connected"
                : "No projects found"
            }
            body="Open a project in your editor, then Rescan."
            actionLabel="Rescan"
            onAction={detected.rescan}
            loading={detected.scanning}
          />
        ) : (
          <>
            {detected.refreshError !== null ? (
              <p className="mb-3 flex items-center gap-2 text-xs text-neutral-500">
                Couldn't refresh just now — showing saved projects.
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs"
                  onClick={detected.rescan}
                >
                  Retry
                </Button>
              </p>
            ) : null}
            <ProjectsGrid
              projects={detected.projects}
              columns={columns}
              gapClass={layout.gapClass}
              hoveredId={hoveredId}
              onHover={setHoveredId}
              layoutEpoch={layoutEpoch}
              layoutTransition={layoutTransition}
              hoverEase={hoverEase}
              reduceMotion={reduceMotion}
              onOpenProject={handleOpen}
              openingId={openingId}
              openError={openError}
              cardRefs={cardRefs}
            />
          </>
        )}
      </div>
    </motion.div>
  );
}

function ProjectsGrid({
  projects,
  columns,
  gapClass,
  hoveredId,
  onHover,
  layoutEpoch,
  layoutTransition,
  hoverEase,
  reduceMotion,
  onOpenProject,
  openingId,
  openError,
  cardRefs,
}: {
  projects: Project[];
  columns: number;
  gapClass: string;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  layoutEpoch: number;
  layoutTransition: { duration: number } | { type: "spring"; stiffness: number; damping: number; mass: number };
  hoverEase: { type: "tween"; duration: number; ease: readonly [number, number, number, number] };
  reduceMotion: boolean | null;
  onOpenProject: (project: Project) => void;
  openingId: string | null;
  openError: { id: string; message: string } | null;
  cardRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
}) {
  return (
        <ul
          className={cn("grid", gapClass)}
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          }}
          onPointerLeave={() => onHover(null)}
        >
          {projects.map((project) => {
            const emphasized = hoveredId === project.id;
            const diminished = hoveredId != null && hoveredId !== project.id;
            const hoverScale = emphasized ? 1.012 : diminished ? 0.992 : 1;

            return (
              <motion.li
                key={project.id}
                layout={!reduceMotion}
                layoutDependency={layoutEpoch}
                transition={layoutTransition}
                className="relative min-w-0"
              >
                {/* Visual only — scale must not enlarge the hit target. */}
                <motion.div
                  animate={
                    reduceMotion
                      ? undefined
                      : {
                          scale: hoverScale,
                          filter: diminished
                            ? "brightness(0.9) saturate(0.92)"
                            : "brightness(1) saturate(1)",
                          transition: hoverEase,
                        }
                  }
                  style={{ transformOrigin: "50% 50%" }}
                  className="pointer-events-none will-change-transform relative z-20"
                >
                  <ProjectCard
                    project={project}
                    emphasized={emphasized}
                    opening={openingId === project.id}
                    openError={
                      openError?.id === project.id ? openError.message : null
                    }
                    onOpen={() => onOpenProject(project)}
                    cardRef={(node) => {
                      cardRefs.current[project.id] = node;
                    }}
                  />
                </motion.div>

                {/*
                  Unscaled hit target. While hovered, inset on X so the grow
                  does not make the card sticky to leave.
                */}
                <button
                  type="button"
                  aria-label={`Open ${project.name}`}
                  onClick={() => onOpenProject(project)}
                  onContextMenu={(e) => {
                    const card = cardRefs.current[project.id];
                    if (card) {
                      card.dispatchEvent(
                        new MouseEvent("contextmenu", {
                          bubbles: true,
                          cancelable: true,
                          clientX: e.clientX,
                          clientY: e.clientY,
                          button: 2,
                        }),
                      );
                    }
                  }}
                  onPointerEnter={() => onHover(project.id)}
                  onPointerLeave={() => onHover(null)}
                  onFocus={() => onHover(project.id)}
                  onBlur={() => onHover(null)}
                  className={cn(
                    "absolute top-0 bottom-0 z-10 rounded-xl outline-none",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    emphasized ? "inset-x-[9%]" : "inset-x-0",
                  )}
                />
              </motion.li>
            );
          })}
        </ul>
  );
}

/** Flat placeholder tiles at card size — no shimmer, no layout shift. */
function ProjectsSkeleton({ columns, gapClass }: { columns: number; gapClass: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("grid", gapClass)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: Math.max(columns * 2, 4) }, (_, index) => (
        <div key={index} className="flex w-full flex-col gap-2">
          <div className="aspect-[16/10] rounded-xl bg-card" />
          <div className="flex flex-col gap-1.5 px-0.5 py-0.5">
            <div className="h-3.5 w-3/4 rounded bg-card" />
            <div className="h-3 w-1/3 rounded bg-card" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Empty and error states keep the section frame with one plain sentence. */
function ProjectsNotice({
  title,
  body,
  actionLabel,
  onAction,
  loading = false,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  loading?: boolean;
}) {
  return (
    <div className="flex w-full flex-col items-start gap-2 rounded-xl border border-dashed border-white/15 px-5 py-6">
      <h3 className="text-sm font-medium text-neutral-200">{title}</h3>
      <p className="text-sm leading-6 text-neutral-400">{body}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={loading}
        onClick={onAction}
        className="mt-1"
      >
        {actionLabel}
      </Button>
    </div>
  );
}

/** Host status, not a library — which editors are around, nothing to open. */
function EditorsStrip({ editors }: { editors: EditorInfo[] }) {
  return (
    <div
      className={cn(
        // self-start: flex-col parent would otherwise stretch this full width
        "inline-flex h-9 w-fit shrink-0 items-center gap-0.5 self-start rounded-full p-1",
        "bg-card/95 shadow-rim backdrop-blur-md",
        "supports-[backdrop-filter]:bg-card/88",
      )}
    >
      {editors.map((editor) => (
        <Tooltip key={editor.id}>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={`${editorName(editor.id)}, ${STATUS_LABEL[editor.status]}`}
                className="relative grid size-7 place-items-center rounded-full text-neutral-200"
              />
            }
          >
            <EditorLogo id={editor.id} className="size-3.5" />
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-card",
                STATUS_DOT[editor.status],
              )}
            />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {editorShort(editor.id)} · {STATUS_LABEL[editor.status]}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}

function PlaceholderPane({ title }: { title: string }) {
  return (
    <div className="mx-auto w-full max-w-lg rounded-card bg-card p-5">
      <Empty className="gap-4 py-6">
        <EmptyArt>
          <DitherArt seed={3} />
        </EmptyArt>
        <p className="text-sm text-muted-foreground">{title}</p>
      </Empty>
    </div>
  );
}
