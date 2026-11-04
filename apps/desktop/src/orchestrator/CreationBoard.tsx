import { BlocksIcon, FilmIcon, LayersIcon, WandSparklesIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { EffectMaker, type ClipChoice } from "../effects/EffectMaker";
import type { ChangesetItem } from "@chair/timeline-ir";

const CARD = "rounded-[28px] bg-[#1a1a1a] text-neutral-100 shadow-raised ring-1 ring-white/8";

const EASE = [0.22, 1, 0.36, 1] as const;

type Shape = "16:9" | "9:16" | "1:1";

const SHAPES: Shape[] = ["16:9", "9:16", "1:1"];

/** Stand-in parts. Nothing here is read from or written to the timeline. */
const PIECE_PARTS = [
  {
    id: "p1",
    title: "Hook, desk pull-in",
    seconds: 4,
    duration: "0:04",
    track: "V1",
    ink: "bg-neutral-400",
  },
  {
    id: "p2",
    title: "Interview sync",
    seconds: 18,
    duration: "0:18",
    track: "V1",
    ink: "bg-sky-400/70",
  },
  {
    id: "p3",
    title: "Lower third",
    seconds: 5,
    duration: "0:05",
    track: "V2",
    ink: "bg-amber-400/70",
  },
  {
    id: "p4",
    title: "Room tone bed",
    seconds: 27,
    duration: "0:27",
    track: "A1",
    ink: "bg-emerald-400/70",
  },
] as const;

const TOTAL_SECONDS = PIECE_PARTS.reduce((sum, part) => sum + part.seconds, 0);

function clock(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = `${total % 60}`.padStart(2, "0");
  return `${minutes}:${seconds}`;
}

const TOTAL = clock(TOTAL_SECONDS);

type Proposal = { name: string; shape: Shape };

export type CreationBoardProps = {
  /** Clips the Effect Maker can land an effect on. */
  clips: ClipChoice[];
  onApplyEffect: (item: ChangesetItem) => string | null;
  onUndoEffect: (itemId: string) => void;
  onOpenHistory: () => void;
  refusal: string | null;
};

type Mode = "effect" | "piece";

/** Creation: the Effect Maker, plus the stand-in piece creator beside it. */
export function CreationBoard(props: CreationBoardProps) {
  const [mode, setMode] = useState<Mode>("effect");
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-4 pb-[9.5rem]">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10">
          <BlocksIcon className="size-4 text-neutral-300" aria-hidden="true" />
        </span>
        <h2 className="text-sm font-semibold tracking-wide text-neutral-100">Creation</h2>
        <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
          <TabsList size="sm">
            <TabsTab value="effect">Effect Maker</TabsTab>
            <TabsTab value="piece">Piece</TabsTab>
          </TabsList>
        </Tabs>
        <p className="ml-auto text-xs text-neutral-500">
          {mode === "effect"
            ? "Applies land on a copy and show in History."
            : "Nothing here is written to the cut."}
        </p>
      </div>
      {mode === "effect" ? (
        <EffectMaker
          clips={props.clips}
          onApply={props.onApplyEffect}
          onUndo={props.onUndoEffect}
          onOpenHistory={props.onOpenHistory}
          refusal={props.refusal}
        />
      ) : (
        <PieceCreator />
      )}
    </div>
  );
}

/** Stand-in of the piece creator. Layout only: it makes nothing yet. */
function PieceCreator() {
  const reduceMotion = useReducedMotion();
  const [name, setName] = useState("");
  const [shape, setShape] = useState<Shape>("16:9");
  const [proposal, setProposal] = useState<Proposal | null>(null);

  const trimmed = name.trim();

  const propose = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmed) return;
    setProposal({ name: trimmed, shape });
  };

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1fr)] gap-3 overflow-hidden lg:grid-cols-12 lg:grid-rows-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section
          aria-label="Piece canvas"
          className={cn(CARD, "flex min-h-0 flex-col gap-3 p-5 lg:col-span-8 lg:row-span-2")}
        >
          <div className="flex shrink-0 items-center gap-2">
            <FilmIcon className="size-4 text-neutral-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold tracking-wide text-neutral-100">Piece canvas</h3>
            <Badge variant="outline" size="sm" className="ml-auto tabular-nums">
              {shape}
            </Badge>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-[#101010] ring-1 ring-white/10">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(120% 90% at 50% 0%, rgba(255,255,255,0.06), transparent 60%)",
              }}
            />
            <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-white/[0.05] ring-1 ring-white/10">
                <BlocksIcon className="size-5 text-neutral-300" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium text-neutral-200">A piece of the cut</p>
              <p className="max-w-64 text-xs leading-5 text-neutral-500">
                The canvas stands in for the preview, the frame around one piece.
              </p>
            </div>

            <div className="relative shrink-0 px-4 pb-4">
              <div
                aria-hidden="true"
                className="flex h-2 gap-1 overflow-hidden rounded-full bg-white/[0.04]"
              >
                {PIECE_PARTS.map((part) => (
                  <span
                    key={part.id}
                    className={cn("basis-0 rounded-full", part.ink)}
                    style={{ flexGrow: part.seconds }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-neutral-500">
            <span>No footage loaded</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {TOTAL} across {PIECE_PARTS.length} parts
            </span>
            <span className="ml-auto tabular-nums">3 tracks</span>
          </div>
        </section>

        <section
          aria-label="Piece parts"
          className={cn(CARD, "flex min-h-0 flex-col gap-2 overflow-hidden p-4 lg:col-span-4")}
        >
          <div className="flex shrink-0 items-center gap-2 px-1">
            <LayersIcon className="size-4 text-neutral-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold tracking-wide text-neutral-100">Piece parts</h3>
            <span className="ml-auto text-xs tabular-nums text-neutral-500">
              {PIECE_PARTS.length} parts
            </span>
          </div>

          <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            {PIECE_PARTS.map((part, index) => (
              <motion.li
                key={part.id}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.38,
                  ease: EASE,
                  delay: reduceMotion ? 0 : index * 0.04,
                }}
                className="flex items-center gap-2.5 rounded-xl px-2.5 py-1.5"
              >
                <span
                  aria-hidden="true"
                  className={cn("h-6 w-1 shrink-0 rounded-full", part.ink)}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                  {part.title}
                </span>
                <Badge
                  variant="outline"
                  size="sm"
                  className="border-white/10 bg-white/[0.06] text-neutral-300"
                >
                  {part.track}
                </Badge>
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-neutral-500">
                  {part.duration}
                </span>
              </motion.li>
            ))}
          </ul>
        </section>

        <section
          aria-label="Make piece"
          className={cn(CARD, "flex min-h-0 flex-col gap-2 overflow-hidden p-4 lg:col-span-4")}
        >
          <div className="flex shrink-0 items-center gap-2 px-1">
            <WandSparklesIcon className="size-4 text-neutral-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold tracking-wide text-neutral-100">Make piece</h3>
            {proposal ? (
              <Badge variant="outline" size="sm" className="ml-auto">
                Proposed
              </Badge>
            ) : null}
          </div>

          <div className="shrink-0 px-1" aria-live="polite">
            {proposal ? (
              <motion.p
                key={`${proposal.name}-${proposal.shape}`}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.38, ease: EASE }}
                className="line-clamp-2 text-xs leading-5 text-neutral-400"
              >
                <span className="text-neutral-200">{proposal.name}</span> · {proposal.shape}. Held
                for review — nothing is written to the cut.
              </motion.p>
            ) : (
              <p className="line-clamp-2 text-xs leading-5 text-neutral-500">
                Assemble the parts into one piece. It is proposed, and waits for a person before the
                cut changes.
              </p>
            )}
          </div>

          <form onSubmit={propose} className="mt-auto flex min-h-0 flex-col gap-2">
            <Input
              type="text"
              size="sm"
              value={name}
              placeholder="Name this piece"
              aria-label="Piece name"
              onChange={(event) => setName(event.target.value)}
            />
            <Tabs value={shape} onValueChange={(value) => setShape(value as Shape)}>
              <TabsList size="sm" className="grid w-full grid-cols-3">
                {SHAPES.map((item) => (
                  <TabsTab key={item} value={item}>
                    {item}
                  </TabsTab>
                ))}
              </TabsList>
            </Tabs>
            <Button type="submit" size="sm" className="w-full" disabled={!trimmed}>
              <WandSparklesIcon />
              Make piece
            </Button>
          </form>
        </section>
      </div>
    </>
  );
}
