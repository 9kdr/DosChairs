import { RefreshCwIcon } from "lucide-react";
import packageJson from "../../package.json";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChairMark } from "./ChairMark";
import { EditorLogo } from "./EditorLogo";
import {
  GRID_SIZE_LAYOUT,
  GridSizeSlider,
  columnsForWidth,
  maxGridSizeForWidth,
  readStoredGridSize,
  writeStoredGridSize,
  type GridApproach,
  type GridSize,
} from "./GridSizeSlider";
import {
  editorName,
  type EditorInfo,
  type EditorStatus,
  type Project,
} from "./data";
import { HomeDock, type HomeTab } from "./HomeDock";
import { ProjectCard } from "./ProjectCard";
import { PiecesShelf } from "../effects/PiecesShelf";
import { SettingsScreen } from "../settings/SettingsScreen";
import { useElementWidth } from "./use-element-width";
import { useProjects } from "./useProjects";

/** Halfway between Tailwind neutral-900 (#171717) and 950 (#0a0a0a). */
const HOME_BG = "#111111";

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
      className="relative flex h-full min-h-0 flex-col overflow-hidden text-neutral-100"
      style={{ backgroundColor: HOME_BG }}
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
              {tab === "marketplace" ? (
                <PlaceholderPane
                  title="Marketplace"
                  body="Download pieces other people publish. Wired later — the dock slot is here so the home layout stays honest."
                />
              ) : null}
            </>
          )}
        </div>
      </div>
      <SmoothScrollTarget target={scrollRef} lerp={0.075} />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24"
        style={{
          background: `linear-gradient(to top, ${HOME_BG} 0%, color-mix(in srgb, ${HOME_BG} 85%, transparent) 55%, transparent 100%)`,
        }}
      />

      <div className="pointer-events-none absolute bottom-5 left-5 z-20 flex items-center gap-2.5 text-neutral-400">
        <ChairMark className="h-8 w-auto text-neutral-200" />
        <span className="text-base font-medium tracking-wide text-neutral-200">
          Chair
        </span>
      </div>

      <div className="pointer-events-none absolute bottom-5 right-5 z-20 flex h-8 items-center text-xs text-neutral-500">
        v{packageJson.version}
      </div>

      <HomeDock
        tab={tab}
        onTab={(next) => {
          setTab(next);
          setSettingsOpen(false);
        }}
        onAccount={() => {
          setTab("projects");
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
  const gridRef = useRef<HTMLUListElement>(null);
  const gridWidth = useElementWidth(gridRef);
  const maxSize = maxGridSizeForWidth(gridWidth);
  // Preferred snap (persisted). Display may clamp below this on a narrow shell.
  const [preferredSize, setPreferredSize] = useState<GridSize>(() =>
    readStoredGridSize(1),
  );
  const [approach, setApproach] = useState<GridApproach>({
    committed: preferredSize,
    toward: null,
    heading: 0,
    intensity: 0,
    dragging: false,
  });
  // Keep `layout` measuring always. Only spring when the *slider* moves —
  // width-driven column changes stay instant so window resize does not flicker.
  const springFromSlider = useRef(false);
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  const size = Math.min(preferredSize, maxSize) as GridSize;
  const layout = GRID_SIZE_LAYOUT[size];
  const columns = columnsForWidth(gridWidth, size);

  const onGridSize = (next: GridSize) => {
    springFromSlider.current = true;
    setPreferredSize(next);
    writeStoredGridSize(next);
    setLayoutEpoch((n) => n + 1);
  };

  useEffect(() => {
    if (!springFromSlider.current) return;
    // Hold the spring through the rearrange; clear after it settles so a
    // later window resize does not re-trigger FLIP.
    const timer = window.setTimeout(() => {
      springFromSlider.current = false;
    }, 480);
    return () => window.clearTimeout(timer);
  }, [layoutEpoch]);

  // One-way gather toward the stop ahead — never a counter-push behind.
  // Applied on an inner wrapper so it does not break layout projection.
  const embraceScale =
    approach.toward == null || approach.heading === 0
      ? 1
      : 1 - approach.intensity * 0.03;

  const layoutTransition =
    springFromSlider.current && !reduceMotion
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

  return (
    <motion.div
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
            <GridSizeSlider
              value={size}
              max={maxSize}
              onChange={onGridSize}
              onApproach={setApproach}
            />
          </div>
        </div>
        {detected.phase === "loading" ? (
          <ProjectsSkeleton columns={columns} gapClass={layout.gapClass} />
        ) : detected.phase === "error" ? (
          <ProjectsNotice
            title="Couldn't reach the agent"
            body="Chair looks for projects through its agent, and the agent didn't answer. Start it and try again."
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
            body={
              detected.editors.every((editor) => editor.status === "stopped")
                ? "Open a project in your editor, then press Rescan and it will show up here."
                : "Nothing to show yet. Open a project in your editor and press Rescan."
            }
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
              gridRef={gridRef}
              projects={detected.projects}
              columns={columns}
              gapClass={layout.gapClass}
              hoveredId={hoveredId}
              onHover={setHoveredId}
              layoutEpoch={layoutEpoch}
              layoutTransition={layoutTransition}
              hoverEase={hoverEase}
              embraceScale={embraceScale}
              reduceMotion={reduceMotion}
              onOpenProject={onOpenProject}
              cardRefs={cardRefs}
            />
          </>
        )}
      </div>
    </motion.div>
  );
}

function ProjectsGrid({
  gridRef,
  projects,
  columns,
  gapClass,
  hoveredId,
  onHover,
  layoutEpoch,
  layoutTransition,
  hoverEase,
  embraceScale,
  reduceMotion,
  onOpenProject,
  cardRefs,
}: {
  gridRef: React.RefObject<HTMLUListElement | null>;
  projects: Project[];
  columns: number;
  gapClass: string;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  layoutEpoch: number;
  layoutTransition: { duration: number } | { type: "spring"; stiffness: number; damping: number; mass: number };
  hoverEase: { type: "tween"; duration: number; ease: readonly [number, number, number, number] };
  embraceScale: number;
  reduceMotion: boolean | null;
  onOpenProject: (projectId: string) => void;
  cardRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
}) {
  return (
        <ul
          ref={gridRef}
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
                          scale: hoverScale * embraceScale,
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
                    onOpen={() => onOpenProject(project.id)}
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
                  onClick={() => onOpenProject(project.id)}
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
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[#111111]",
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
          <div className="aspect-[16/10] rounded-xl bg-neutral-800/80 ring-1 ring-white/[0.06]" />
          <div className="flex flex-col gap-1.5 px-0.5 py-0.5">
            <div className="h-3.5 w-3/4 rounded bg-neutral-800" />
            <div className="h-3 w-1/3 rounded bg-neutral-800/70" />
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
        "bg-[#1a1a1a]/95 shadow-raised ring-1 ring-white/[0.08] backdrop-blur-md",
        "supports-[backdrop-filter]:bg-[#1a1a1a]/88",
      )}
    >
      {editors.map((editor) => (
        <span
          key={editor.id}
          role="img"
          aria-label={`${editorName(editor.id)}, ${STATUS_LABEL[editor.status]}`}
          className="relative grid size-7 place-items-center rounded-full text-neutral-200"
        >
          <EditorLogo id={editor.id} className="size-3.5" />
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-[#1a1a1a]",
              STATUS_DOT[editor.status],
            )}
          />
        </span>
      ))}
    </div>
  );
}

function PlaceholderPane({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-start gap-2 rounded-2xl bg-white/[0.03] px-5 py-6 ring-1 ring-white/[0.06]">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="text-sm leading-6 text-neutral-400">{body}</p>
    </div>
  );
}
