/**
 * The plan's Beats tab: beats read as a tidy list (a time range on the
 * left, text beside it) and edit inline on click. Paste import reads
 * `# Script` / `## Beat n` markdown.
 */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { DitherArt } from "@/components/dither-art";
import { Button } from "@/components/ui/button";
import { Empty, EmptyArt } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCutDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PlanBeat } from "./plan-api";

type PlanBeatsProps = {
  beats: PlanBeat[];
  onChange: (beats: PlanBeat[]) => void;
  onImport: (text: string) => void;
};

function newBeat(index: number): PlanBeat {
  return { id: `beat-${Date.now()}-${index}`, role: "", text: "" };
}

/** "0:00–0:06", with a lone bound shown open-ended ("0:00–"). */
function timeRange(beat: PlanBeat): string | null {
  if (beat.startSec === undefined && beat.endSec === undefined) return null;
  const start = beat.startSec === undefined ? "" : formatCutDuration(beat.startSec);
  const end = beat.endSec === undefined ? "" : formatCutDuration(beat.endSec);
  return `${start}–${end}`;
}

export function PlanBeats({ beats, onChange, onImport }: PlanBeatsProps) {
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const reduce = useReducedMotion();

  const setBeat = (id: string, patch: Partial<PlanBeat>) => {
    onChange(beats.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat)));
  };

  const dropBeat = (id: string) => {
    if (editingId === id) setEditingId(null);
    onChange(beats.filter((beat) => beat.id !== id));
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {beats.length === 0 ? (
        <Empty className="gap-4 py-6 md:py-6">
          <EmptyArt>
            <DitherArt seed={7} />
          </EmptyArt>
          <p className="text-meta text-muted-foreground">No beats yet. Add the first one below.</p>
        </Empty>
      ) : (
        <ol className="flex min-h-0 flex-col">
          {beats.map((beat, index) => {
            const range = timeRange(beat);
            const label = `Beat ${index + 1}`;
            if (editingId !== beat.id) {
              return (
                <motion.li
                  key={beat.id}
                  initial={reduce ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.18,
                    ease: [0.22, 1, 0.36, 1],
                    delay: Math.min(index * 0.03, 0.24),
                  }}
                  className="group border-b border-line py-3 last:border-0"
                >
                  <div className="flex items-start gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setEditingId(beat.id)}
                      aria-label={`Edit ${label.toLowerCase()}`}
                      className="h-auto min-w-0 flex-1 flex-row items-baseline justify-start gap-3 p-0 text-left font-normal hover:bg-transparent data-pressed:bg-transparent sm:h-auto"
                    >
                      <span className="w-16 shrink-0 text-meta whitespace-nowrap tabular-nums text-muted-foreground">
                        {range ?? "–"}
                      </span>
                      <span className="min-w-0 flex-1">
                        {beat.role ? (
                          <span className="block text-meta text-muted-foreground">{beat.role}</span>
                        ) : null}
                        <span className="block text-body leading-6 text-neutral-100">
                          {beat.text || (
                            <span className="text-muted-foreground">Empty beat — click to write.</span>
                          )}
                        </span>
                      </span>
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${label.toLowerCase()}`}
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                      onClick={() => dropBeat(beat.id)}
                    >
                      <X />
                    </Button>
                  </div>
                </motion.li>
              );
            }
            return (
              <li key={beat.id} className="border-b border-line py-3 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-meta tabular-nums text-neutral-500">{index + 1}</span>
                  <Input
                    size="sm"
                    value={beat.role}
                    placeholder="Role"
                    aria-label={`Role for ${label.toLowerCase()}`}
                    className="min-w-0 flex-1 text-meta sm:text-meta"
                    onChange={(event) => setBeat(beat.id, { role: event.target.value })}
                  />
                  <div className="flex shrink-0 items-center gap-1" aria-label="Time range in seconds">
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      value={beat.startSec ?? ""}
                      placeholder="Start"
                      aria-label={`Start second for ${label.toLowerCase()}`}
                      className={cn("w-16 text-meta sm:text-meta", beat.startSec === undefined && "text-neutral-500")}
                      onChange={(event) =>
                        setBeat(beat.id, {
                          startSec: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)),
                        })
                      }
                    />
                    <span className="text-meta text-neutral-500">–</span>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      value={beat.endSec ?? ""}
                      placeholder="End"
                      aria-label={`End second for ${label.toLowerCase()}`}
                      className={cn("w-16 text-meta sm:text-meta", beat.endSec === undefined && "text-neutral-500")}
                      onChange={(event) =>
                        setBeat(beat.id, {
                          endSec: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)),
                        })
                      }
                    />
                  </div>
                </div>
                <Textarea
                  value={beat.text}
                  placeholder="What happens in this beat."
                  aria-label={`Text for ${label.toLowerCase()}`}
                  className="mt-1 min-h-14 text-body leading-6 sm:text-body"
                  onChange={(event) => setBeat(beat.id, { text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setEditingId(null);
                    }
                  }}
                />
                <div className="mt-1 flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => dropBeat(beat.id)}
                  >
                    Remove
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setEditingId(null)}
                  >
                    Done
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            const beat = newBeat(beats.length);
            onChange([...beats, beat]);
            setEditingId(beat.id);
          }}
        >
          <Plus /> Beat
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={importOpen}
          onClick={() => setImportOpen((open) => !open)}
        >
          Paste markdown
        </Button>
      </div>
      {importOpen ? (
        <div className="flex shrink-0 flex-col gap-2 rounded-card bg-muted p-4">
          <Textarea
            value={importText}
            placeholder={"# Script\n\nOne room, one argument.\n\n## Beat 1 hook\n\nOpen on the oven door."}
            aria-label="Markdown to import"
            className="min-h-24 text-body leading-6 sm:text-body"
            onChange={(event) => setImportText(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setImportText("");
                setImportOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText("");
                setImportOpen(false);
              }}
            >
              Import
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
