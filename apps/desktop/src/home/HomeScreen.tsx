import {
  AudioWaveformIcon,
  FilmIcon,
  ImageIcon,
  MusicIcon,
} from "lucide-react";
import packageJson from "../../package.json";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { Badge } from "@/components/ui/badge";
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
  EDITORS,
  LIBRARY_ASSETS,
  PROJECTS,
  type EditorStatus,
  type LibraryAssetKind,
} from "./data";
import { HomeDock, type HomeTab } from "./HomeDock";
import { ProjectCard } from "./ProjectCard";
import { SettingsScreen } from "../settings/SettingsScreen";
import { useElementWidth } from "./use-element-width";

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

const ASSET_KIND_LABEL: Record<LibraryAssetKind, string> = {
  music: "Music",
  image: "Image",
  video: "Video",
  sfx: "SFX",
};

const ASSET_KIND_ICON = {
  music: MusicIcon,
  image: ImageIcon,
  video: FilmIcon,
  sfx: AudioWaveformIcon,
} as const;

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
              {tab === "library" ? <LibraryPane /> : null}
              {tab === "pieces" ? (
                <PlaceholderPane
                  title="Pieces"
                  body="Named presets and templates the agent can call — captions, motion, grade looks. Empty for now; this is the shelf."
                />
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

  return (
    <motion.div
      className="mx-auto flex w-full max-w-5xl flex-col gap-8"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <EditorsStrip />
      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-neutral-400">Recent projects</h2>
          <GridSizeSlider
            value={size}
            max={maxSize}
            onChange={onGridSize}
            onApproach={setApproach}
          />
        </div>
        <ul
          ref={gridRef}
          className={cn("grid", layout.gapClass)}
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          }}
          onPointerLeave={() => setHoveredId(null)}
        >
          {PROJECTS.map((project) => {
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
                  onPointerEnter={() => setHoveredId(project.id)}
                  onPointerLeave={() =>
                    setHoveredId((current) =>
                      current === project.id ? null : current,
                    )
                  }
                  onFocus={() => setHoveredId(project.id)}
                  onBlur={() =>
                    setHoveredId((current) =>
                      current === project.id ? null : current,
                    )
                  }
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
      </div>
    </motion.div>
  );
}

/** Host status, not a library — which editors are around, nothing to open. */
function EditorsStrip() {
  return (
    <div
      className={cn(
        // self-start: flex-col parent would otherwise stretch this full width
        "inline-flex h-9 w-fit shrink-0 items-center gap-0.5 self-start rounded-full p-1",
        "bg-[#1a1a1a]/95 shadow-raised ring-1 ring-white/[0.08] backdrop-blur-md",
        "supports-[backdrop-filter]:bg-[#1a1a1a]/88",
      )}
    >
      {EDITORS.map((editor) => (
        <span
          key={editor.id}
          role="img"
          aria-label={`${editor.name}, ${STATUS_LABEL[editor.status]}`}
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

function LibraryPane() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <ul className="space-y-2">
        {LIBRARY_ASSETS.map((asset) => {
          const KindIcon = ASSET_KIND_ICON[asset.kind];
          return (
            <li
              key={asset.id}
              className="flex items-center gap-3 rounded-2xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/[0.06]"
            >
              <span className="grid size-9 place-items-center rounded-xl bg-white/[0.04] text-neutral-300 ring-1 ring-white/[0.06]">
                <KindIcon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{asset.name}</p>
                <p className="text-xs text-neutral-500">{asset.detail}</p>
              </div>
              <Badge variant="secondary" size="sm">
                {ASSET_KIND_LABEL[asset.kind]}
              </Badge>
            </li>
          );
        })}
      </ul>
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
