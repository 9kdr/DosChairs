/**
 * The plan's Beats tab: beats read as content (a time range plus text) and
 * edit inline on click. Paste import reads `# Script` / `## Beat n` markdown.
 */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

function formatSec(value: number): string {
  const total = Math.max(0, Math.floor(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "0:00–0:06", with a lone bound shown open-ended ("0:00–"). */
function timeRange(beat: PlanBeat): string | null {
  if (beat.startSec === undefined && beat.endSec === undefined) return null;
  const start = beat.startSec === undefined ? "" : formatSec(beat.startSec);
  const end = beat.endSec === undefined ? "" : formatSec(beat.endSec);
  return `${start}–${end}`;
}

export function PlanBeats({ beats, onChange, onImport }: PlanBeatsProps) {
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

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
        <p className="rounded-3xl bg-white/[0.04] p-5 text-sm leading-6 text-neutral-400">
          No beats yet. Add the first one, or paste markdown to import them.
        </p>
      ) : (
        <ol className="flex min-h-0 flex-col">
          {beats.map((beat, index) => {
            const range = timeRange(beat);
            const label = `Beat ${index + 1}`;
            if (editingId !== beat.id) {
              return (
                <li key={beat.id} className="border-b border-white/5 py-3 last:border-0">
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingId(beat.id)}
                      aria-label={`Edit ${label.toLowerCase()}`}
                      className="min-w-0 flex-1 cursor-text text-left"
                    >
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-xs tabular-nums text-neutral-500">{index + 1}</span>
                        {range ? (
                          <span className="text-[13px] tabular-nums text-neutral-500">{range}</span>
                        ) : null}
                        {beat.role ? (
                          <span className="text-[13px] text-neutral-400">{beat.role}</span>
                        ) : (
                          <span className="text-[13px] text-neutral-500">{label}</span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-sm leading-6 text-neutral-100">
                        {beat.text || <span className="text-neutral-500">Empty beat — click to write.</span>}
                      </span>
                    </button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${label.toLowerCase()}`}
                      className="shrink-0 rounded-full"
                      onClick={() => dropBeat(beat.id)}
                    >
                      <X />
                    </Button>
                  </div>
                </li>
              );
            }
            return (
              <li key={beat.id} className="border-b border-white/5 py-3 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500">{index + 1}</span>
                  <Input
                    size="sm"
                    value={beat.role}
                    placeholder="Role"
                    aria-label={`Role for ${label.toLowerCase()}`}
                    className="h-7 min-w-0 flex-1 border-transparent bg-transparent text-[13px]"
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
                      className={cn("h-7 w-16 border-transparent bg-transparent text-[13px]", beat.startSec === undefined && "text-neutral-500")}
                      onChange={(event) =>
                        setBeat(beat.id, {
                          startSec: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)),
                        })
                      }
                    />
                    <span className="text-xs text-neutral-600">–</span>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      value={beat.endSec ?? ""}
                      placeholder="End"
                      aria-label={`End second for ${label.toLowerCase()}`}
                      className={cn("h-7 w-16 border-transparent bg-transparent text-[13px]", beat.endSec === undefined && "text-neutral-500")}
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
                  className="mt-1 min-h-14 border-transparent bg-transparent text-sm leading-6"
                  onChange={(event) => setBeat(beat.id, { text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setEditingId(null);
                  }}
                />
                <div className="mt-1 flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="rounded-full"
                    onClick={() => dropBeat(beat.id)}
                  >
                    Remove
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="rounded-full"
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
          className="rounded-full"
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
          className="rounded-full"
          aria-expanded={importOpen}
          onClick={() => setImportOpen((open) => !open)}
        >
          Paste markdown
        </Button>
      </div>
      {importOpen ? (
        <div className="flex shrink-0 flex-col gap-2 rounded-3xl bg-white/[0.04] p-4">
          <Textarea
            value={importText}
            placeholder={"# Script\n\nOne room, one argument.\n\n## Beat 1 hook\n\nOpen on the oven door."}
            aria-label="Markdown to import"
            className="min-h-24 border-transparent bg-transparent text-sm leading-6"
            onChange={(event) => setImportText(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="rounded-full"
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
              className="rounded-full"
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
