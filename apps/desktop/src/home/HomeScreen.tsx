import { PlusIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SmoothScrollTarget } from "@/components/chat/smooth-scroll";
import { Badge } from "@/components/ui/badge";
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
  EDITORS,
  PROJECTS,
  type EditorInfo,
  type EditorStatus,
} from "./data";
import { HomeDock, type HomeTab } from "./HomeDock";
import { ProjectCard } from "./ProjectCard";
import { useElementWidth } from "./use-element-width";

/** Halfway between Tailwind neutral-900 (#171717) and 950 (#0a0a0a). */
const HOME_BG = "#111111";

type HomeScreenProps = {
  onOpenProject: (projectId: string) => void;
};

const STATUS_LABEL: Record<EditorStatus, string> = {
  running: "Running",
  idle: "Idle",
  stopped: "Stopped",
};

const STATUS_VARIANT: Record<
  EditorStatus,
  "success" | "warning" | "secondary"
> = {
  running: "success",
  idle: "warning",
  stopped: "secondary",
};

const STATUS_DOT: Record<EditorStatus, string> = {
  running: "bg-success",
  idle: "bg-warning",
  stopped: "bg-neutral-500",
};

export function HomeScreen({ onOpenProject }: HomeScreenProps) {
  const [tab, setTab] = useState<HomeTab>("projects");
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
          {tab === "projects" ? (
            <ProjectsPane
              onOpenProject={onOpenProject}
              onOpenEditors={() => setTab("editors")}
            />
          ) : null}
          {tab === "editors" ? <EditorsPane /> : null}
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

      <HomeDock
        tab={tab}
        editors={EDITORS}
        onTab={setTab}
        onAccount={() => setTab("projects")}
        onSettings={() => setTab("projects")}
      />
    </section>
  );
}

function ProjectsPane({
  onOpenProject,
  onOpenEditors,
}: {
  onOpenProject: (projectId: string) => void;
  onOpenEditors: () => void;
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
  const hoverEase = {
    type: "tween" as const,
    duration: 0.4,
    ease: [0.33, 1, 0.32, 1] as const,
  };

  return (
    <motion.div
      className="mx-auto flex w-full max-w-5xl flex-col gap-8"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <EditorsStrip
        onSelect={() => onOpenEditors()}
        onAdd={onOpenEditors}
      />
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
            const hoverScale = emphasized ? 1.015 : diminished ? 0.99 : 1;

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
                  aria-hidden="true"
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
                  className="pointer-events-none will-change-transform"
                >
                  <ProjectCard project={project} emphasized={emphasized} />
                </motion.div>

                {/*
                  Unscaled hit target. While hovered, inset on X so the grow
                  does not make the card sticky to leave.
                */}
                <button
                  type="button"
                  aria-label={`Open ${project.name}`}
                  onClick={() => onOpenProject(project.id)}
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

function EditorsStrip({
  onSelect,
  onAdd,
}: {
  onSelect: (editor: EditorInfo) => void;
  onAdd: () => void;
}) {
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
        <Button
          key={editor.id}
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`${editor.name}, ${STATUS_LABEL[editor.status]}`}
          onClick={() => onSelect(editor)}
          className={cn(
            "relative size-7 rounded-full text-neutral-200",
            "hover:bg-white/[0.06]",
          )}
        >
          <EditorLogo id={editor.id} className="size-3.5" />
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-[#1a1a1a]",
              STATUS_DOT[editor.status],
            )}
          />
        </Button>
      ))}
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-white/[0.1]" />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Add editor"
        onClick={onAdd}
        className="size-7 rounded-full text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100"
      >
        <PlusIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function EditorsPane() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <ul className="space-y-2">
        {EDITORS.map((editor) => (
          <li
            key={editor.id}
            className="flex items-center gap-3 rounded-2xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/[0.06]"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.06]">
              <EditorLogo id={editor.id} title={editor.name} className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{editor.name}</p>
              <p className="text-xs text-neutral-500">
                {editor.status === "running"
                  ? "Adapter reachable — open a project to chat against this cut."
                  : editor.status === "idle"
                    ? "Installed, not talking to Chair yet."
                    : "Editor stopped — start it to chat against this cut."}
              </p>
            </div>
            <Badge variant={STATUS_VARIANT[editor.status]} size="sm">
              {STATUS_LABEL[editor.status]}
            </Badge>
          </li>
        ))}
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
