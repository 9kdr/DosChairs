import type { EffectSpec, Rig } from "@chair/effects";
import type { ChangesetItem } from "@chair/timeline-ir";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  HistoryIcon,
  ImagePlusIcon,
  PackageIcon,
  SparklesIcon,
  Undo2Icon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ServiceError } from "@/lib/services/client";
import { cn } from "@/lib/utils";
import {
  STARTER_PROMPTS,
  bakeRig,
  defaultControls,
  effectItem,
  exportInfo,
  rigOf,
  type ControlValue,
  type ControlValues,
} from "./effect-model";
import { generateEffect, sampleEffect, verifyEffect } from "./effects-api";
import { PreviewStage, type PreviewHandle } from "./PreviewStage";
import { CARD, ControlsPanel, PanelTitle, RigPanel } from "./TweakPanels";

export type ClipChoice = { id: string; name: string; track: string };

type Round = {
  id: number;
  kind: "draft" | "check" | "note";
  state: "running" | "pass" | "fail" | "error" | "info";
  title: string;
  notes: string;
};

const CANVAS = { width: 1920, height: 1080 };
const MAX_REFERENCE = 768;

/** Shrink a dropped reference so the request stays small. */
async function readReference(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, MAX_REFERENCE / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Agent down or no model key: the sample keeps the screen usable. */
function agentMissing(error: unknown): boolean {
  return error instanceof ServiceError && (error.status === undefined || error.status === 502);
}

function RoundIcon({ round }: { round: Round }) {
  if (round.state === "running") return <Spinner className="size-3.5 text-amber-300" />;
  if (round.state === "pass") return <CheckCircle2Icon className="size-3.5 text-emerald-400" aria-hidden="true" />;
  if (round.state === "fail") return <AlertCircleIcon className="size-3.5 text-amber-300" aria-hidden="true" />;
  if (round.state === "error") return <AlertCircleIcon className="size-3.5 text-red-400" aria-hidden="true" />;
  return <SparklesIcon className="size-3.5 text-neutral-400" aria-hidden="true" />;
}

/**
 * Effect Maker: describe a look, watch Muse Spark draft and check it, tweak
 * it live, then apply it as an undoable add_effect. The preview, controls
 * and rig run in the browser; only generate and verify call the agent.
 */
export function EffectMaker({
  clips,
  onApply,
  onUndo,
  onOpenHistory,
  refusal,
}: {
  clips: ClipChoice[];
  onApply: (item: ChangesetItem) => string | null;
  onUndo: (itemId: string) => void;
  onOpenHistory: () => void;
  refusal: string | null;
}) {
  const [prompt, setPrompt] = useState("");
  const [reference, setReference] = useState<{ name: string; url: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [spec, setSpec] = useState<EffectSpec | null>(null);
  const [effectId, setEffectId] = useState<string | null>(null);
  const [rig, setRig] = useState<Rig | null>(null);
  const [controls, setControls] = useState<ControlValues>({});
  const [rounds, setRounds] = useState<Round[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [clipId, setClipId] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ itemId: string; clip: string } | null>(null);
  const previewRef = useRef<PreviewHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const roundId = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy]);

  const bake = useMemo(() => (spec ? bakeRig(spec, rig) : null), [spec, rig]);
  const live = bake?.spec ?? null;
  const info = live ? exportInfo(live) : null;
  const clip = clips.find((entry) => entry.id === (clipId ?? clips[0]?.id)) ?? null;

  const load = (next: EffectSpec, id: string | null) => {
    setSpec(next);
    setEffectId(id);
    setRig(rigOf(next));
    setControls(defaultControls(next));
    setApplied(null);
  };

  const addRound = (round: Omit<Round, "id">): number => {
    const id = ++roundId.current;
    setRounds((current) => [...current, { ...round, id }]);
    return id;
  };
  const patchRound = (id: number, patch: Partial<Round>) =>
    setRounds((current) => current.map((round) => (round.id === id ? { ...round, ...patch } : round)));

  const useSample = (why?: string) => {
    load(sampleEffect(), null);
    addRound({
      kind: "note",
      state: "info",
      title: "Sample effect loaded",
      notes: why ?? "The bundled bouncing title, so the screen works without Muse Spark.",
    });
  };

  /** Draft, then up to two vision checks; a failed check swaps in the revised spec. */
  const generate = async () => {
    const brief = prompt.trim();
    if (!brief || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setBusy(true);
    const draft = addRound({ kind: "draft", state: "running", title: "Muse Spark is drafting", notes: brief });
    try {
      const made = await generateEffect(
        {
          prompt: brief,
          canvas: CANVAS,
          fps: 30,
          durationSec: 3,
          referenceImage: reference?.url,
        },
        { signal },
      );
      patchRound(draft, { state: "pass", title: "Draft written", notes: made.notes || "Muse Spark wrote the effect." });
      load(made.spec, made.id);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const check = addRound({ kind: "check", state: "running", title: `Vision check ${attempt}`, notes: "Comparing a preview frame with the brief." });
        await wait(250);
        try {
          const frame = previewRef.current?.capture(made.spec.durationSec * 0.55);
          if (!frame) throw new Error("the preview could not capture a frame");
          const verdict = await verifyEffect(
            made.id,
            { previewPng: frame, ...(reference ? { referencePng: reference.url } : {}) },
            { signal },
          );
          patchRound(check, {
            state: verdict.pass ? "pass" : "fail",
            title: verdict.pass ? `Check ${attempt} passed` : `Check ${attempt}: needs a fix`,
            notes: verdict.notes || (verdict.pass ? "The preview matches the brief." : "The preview differs from the brief."),
          });
          if (verdict.pass || !verdict.revisedSpec) break;
          load(verdict.revisedSpec, made.id);
          made.spec = verdict.revisedSpec;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          patchRound(check, {
            state: "error",
            title: `Check ${attempt} skipped`,
            notes: error instanceof Error ? error.message : "The vision check failed.",
          });
          break;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        patchRound(draft, { state: "info", title: "Stopped", notes: "You stopped the run." });
      } else {
        const message = error instanceof Error ? error.message : "Generation failed.";
        patchRound(draft, { state: "error", title: "Draft failed", notes: message });
        if (agentMissing(error) && !spec) useSample("Muse Spark is not connected, so the sample stands in.");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const attach = async (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      setReference({ name: file.name, url: await readReference(file) });
    } catch {
      addRound({ kind: "note", state: "error", title: "Reference unreadable", notes: `${file.name} is not an image the window can read.` });
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void attach(event.dataTransfer.files[0]);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void generate();
    }
  };

  const apply = () => {
    if (!live || !clip || !bake) return;
    const itemId = onApply(
      effectItem({ spec: live, controls, targetId: clip.id, bakedKeys: bake.keys }),
    );
    if (itemId) setApplied({ itemId, clip: clip.name });
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)_minmax(15rem,18rem)]">
      {/* Brief and Muse Spark's rounds */}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <section aria-label="Brief" className={cn(CARD, "flex shrink-0 flex-col gap-3 p-4")}>
          <PanelTitle icon={WandSparklesIcon} title="Brief" />
          <div className="flex flex-col gap-2 px-1">
            <Textarea
              size="sm"
              value={prompt}
              placeholder="Describe the look: a bouncy title, a dither over footage…"
              aria-label="Describe the effect"
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={onKey}
            />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Starting points">
              {STARTER_PROMPTS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  disabled={busy}
                  onClick={() => setPrompt(starter.prompt)}
                  className="rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-neutral-300 ring-1 ring-white/10 transition-colors hover:bg-white/[0.1] hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {starter.label}
                </button>
              ))}
            </div>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                "flex items-center gap-2.5 rounded-2xl border border-dashed px-3 py-2.5 text-xs transition-colors",
                dragging ? "border-amber-300/60 bg-amber-300/[0.06]" : "border-white/12 bg-white/[0.02]",
              )}
            >
              {reference ? (
                <>
                  <img src={reference.url} alt="" className="size-9 shrink-0 rounded-lg object-cover ring-1 ring-white/10" />
                  <span className="min-w-0 flex-1 truncate text-neutral-300">{reference.name}</span>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label="Remove reference image" onClick={() => setReference(null)}>
                    <XIcon />
                  </Button>
                </>
              ) : (
                <>
                  <ImagePlusIcon className="size-4 shrink-0 text-neutral-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-neutral-500">
                    Drop a reference image or{" "}
                    <button type="button" className="text-neutral-300 underline underline-offset-2" onClick={() => fileInput.current?.click()}>
                      browse
                    </button>
                  </span>
                </>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="Reference image"
                onChange={(event) => {
                  void attach(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" className="flex-1" disabled={!prompt.trim() || busy} onClick={() => void generate()}>
                {busy ? <Spinner /> : <WandSparklesIcon />}
                {busy ? `Drafting… ${elapsed}s` : "Generate"}
              </Button>
              {busy ? (
                <Button type="button" size="sm" variant="outline" onClick={() => abortRef.current?.abort()}>
                  Stop
                </Button>
              ) : (
                <Button type="button" size="sm" variant="outline" onClick={() => useSample()}>
                  Sample
                </Button>
              )}
            </div>
          </div>
        </section>

        <section aria-label="Muse Spark activity" className={cn(CARD, "flex min-h-40 flex-1 flex-col gap-2 p-4")}>
          <PanelTitle icon={SparklesIcon} title="Muse Spark">
            {busy ? <Badge variant="warning" size="sm">Working</Badge> : null}
          </PanelTitle>
          {rounds.length === 0 ? (
            <p className="px-1 text-xs leading-5 text-neutral-500">
              Each draft and vision check lands here with its notes, so you see why the look changed.
            </p>
          ) : (
            <ol className="flex min-h-0 flex-col gap-2.5 overflow-y-auto px-1" aria-live="polite">
              {rounds.map((round) => (
                <li key={round.id} className="flex gap-2.5">
                  <span className="mt-0.5 shrink-0"><RoundIcon round={round} /></span>
                  <span className="min-w-0 text-xs leading-5">
                    <span className="font-medium text-neutral-200">{round.title}</span>
                    <span className="block whitespace-pre-line text-neutral-500">{round.notes}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* Live preview, export target, apply */}
      <section aria-label="Live preview" className={cn(CARD, "flex min-h-0 flex-col gap-3 p-5")}>
        <PanelTitle icon={PackageIcon} title={live ? live.name : "Live preview"}>
          {live ? (
            <Badge variant="outline" size="sm" className="tabular-nums">
              {live.width}×{live.height} · {live.fps} fps
            </Badge>
          ) : null}
        </PanelTitle>
        {live ? (
          <PreviewStage ref={previewRef} spec={live} controls={controls} className="min-h-0 flex-1" />
        ) : (
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[20px] bg-[#101010] ring-1 ring-white/10">
            <div className="flex max-w-72 flex-col items-center gap-2 px-4 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-white/[0.05] ring-1 ring-white/10">
                {busy ? <Spinner className="size-5 text-amber-300" /> : <SparklesIcon className="size-5 text-neutral-300" aria-hidden="true" />}
              </span>
              <p className="text-sm font-medium text-neutral-200">
                {busy ? `Muse Spark is drafting… ${elapsed}s` : "Describe a look to start"}
              </p>
              <p className="text-xs leading-5 text-neutral-500">
                {busy
                  ? "A real draft takes about 40 seconds. The preview starts the moment the spec lands."
                  : "Pick a starting point or write your own. The preview plays here, live."}
              </p>
            </div>
          </div>
        )}

        <div className="flex shrink-0 flex-col gap-2.5 px-1">
          {info ? (
            <div className="flex items-start gap-2.5 text-xs leading-5">
              <Badge variant={info.fallback ? "warning" : "success"} size="sm" className="mt-0.5">
                {info.label}
              </Badge>
              <p className="min-w-0 flex-1 text-neutral-400">
                <span className="text-neutral-300">{info.fallback ? "Fallback — " : "Lands as — "}</span>
                {info.reason}
              </p>
            </div>
          ) : (
            <p className="text-xs leading-5 text-neutral-500">
              The export target and the reason for it show here once an effect exists.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {clips.length > 0 && clip ? (
              <Select
                items={clips.map((entry) => ({ label: `${entry.name} · ${entry.track}`, value: entry.id }))}
                value={clip.id}
                onValueChange={(value) => setClipId(value as string)}
              >
                <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Clip to apply onto">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {clips.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name} · {entry.track}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <p className="min-w-0 flex-1 text-xs text-neutral-500">
                No clip to land on yet. Open a project with a cut to apply.
              </p>
            )}
            <Button type="button" size="sm" disabled={!live || !clip || busy} onClick={apply}>
              <PackageIcon />
              Apply to Resolve
            </Button>
          </div>
          <div aria-live="polite">
            {applied ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-emerald-400/[0.07] px-3 py-2 text-xs text-emerald-200/90 ring-1 ring-emerald-400/20 ring-inset">
                <CheckCircle2Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">Added to {applied.clip} as a new effect — in History, undoable.</span>
                <Button type="button" size="xs" variant="ghost" onClick={() => { onUndo(applied.itemId); setApplied(null); }}>
                  <Undo2Icon />
                  Undo
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={onOpenHistory}>
                  <HistoryIcon />
                  History
                </Button>
              </p>
            ) : refusal ? (
              <p className="rounded-xl bg-red-400/[0.07] px-3 py-2 text-xs text-red-200/90 ring-1 ring-red-400/20 ring-inset">
                Not applied: {refusal}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/* Controls and rig */}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <ControlsPanel
          spec={spec}
          values={controls}
          onChange={(id: string, value: ControlValue) => setControls((current) => ({ ...current, [id]: value }))}
        />
        <RigPanel
          rig={rig}
          bake={bake ?? { spec: spec as EffectSpec, keys: 0, frames: 0 }}
          onChange={(patch) => setRig((current) => (current ? { ...current, ...patch } : current))}
          onReset={() => spec && setRig(rigOf(spec))}
        />
      </div>
    </div>
  );
}
