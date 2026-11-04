import type { EffectSpec, Rig } from "@chair/effects";
import type { ChangesetItem } from "@chair/timeline-ir";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  HistoryIcon,
  PackageIcon,
  SparklesIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatPrompt, type ChatDraft } from "@/components/chat-prompt";
import { InfoHint } from "@/components/info-hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ServiceError } from "@/lib/services/client";
import { cn } from "@/lib/utils";
import {
  PIECE_TYPES,
  bakedPayload,
  bakeRig,
  briefWithType,
  defaultControls,
  effectItem,
  exportInfo,
  rigOf,
  rigTargetId,
  typeOfSpec,
  updateControl,
  type ControlValue,
  type ControlValues,
  type PieceLanding,
  type PieceType,
} from "./effect-model";
import {
  applyPiece,
  fetchEffect,
  generateEffect,
  isClipGoneError,
  isPieceFallback,
  pieceUndoErrorMessage,
  readPieceBrief,
  revertPiece,
  sampleEffect,
  verifyEffect,
  writePieceBrief,
} from "./effects-api";
import { PreviewStage, type PreviewHandle } from "./PreviewStage";
import { CARD, RigPanel, VariablesPanel } from "./TweakPanels";

export type ClipChoice = {
  id: string;
  name: string;
  track: string;
  /** Position in Resolve: 1-based video track, 0-based clip. Absent on Home. */
  trackIndex?: number;
  clipIndex?: number;
  trackType?: "video" | "audio";
};

/**
 * A piece the maker opens in edit mode. A fully-loaded opener passes
 * the spec (preview and variables at once); otherwise the maker reads
 * the stored draft by id and falls back to the brief alone. Type and
 * brief default from the spec and the remembered brief when absent.
 * (Integration note for the shelf: pass `piece` and `onBack`; the
 * shelf's own back row above the maker then goes away.)
 */
export type MakerPiece = {
  id: string;
  name: string;
  brief?: string;
  type?: PieceType;
  spec?: EffectSpec;
};

const CANVAS = { width: 1920, height: 1080 };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Agent down, throttled, erroring, or no usable model key: the sample keeps the screen usable. */
function agentMissing(error: unknown): boolean {
  return (
    error instanceof ServiceError &&
    (error.status === undefined ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599))
  );
}

/**
 * Piece Maker: describe a look in the bar, watch Muse Spark draft and
 * check it, set the variables Resolve will show, then apply it to
 * Resolve as a new comp version, undoable back to the previous one. The
 * history entry is recorded only after Resolve answers. An applied
 * piece remembers its clip: re-prompts and tweaks re-apply to the same
 * clip on their own. The preview, variables and rig run in the
 * browser; generate, verify and apply call the agent. New mode starts
 * empty; edit mode opens with the piece's brief, type and variables.
 */
export function EffectMaker({
  clips,
  onApply,
  onUndo,
  onOpenHistory,
  refusal,
  landings,
  onRecordLanding,
  piece = null,
  onBack,
}: {
  clips: ClipChoice[];
  onApply: (item: ChangesetItem) => string | null;
  onUndo: (itemId: string) => void;
  onOpenHistory: () => void;
  refusal: string | null;
  landings?: Record<string, PieceLanding>;
  onRecordLanding?: (specId: string, landing: PieceLanding) => void;
  piece?: MakerPiece | null;
  onBack?: () => void;
}) {
  const editId = piece && piece.id !== "new" ? piece.id : null;
  const [pieceType, setPieceType] = useState<PieceType>(() => {
    if (piece?.type) return piece.type;
    if (piece?.spec) return typeOfSpec(piece.spec);
    return "effect";
  });
  const [spec, setSpec] = useState<EffectSpec | null>(null);
  const [rig, setRig] = useState<Rig | null>(null);
  const [controls, setControls] = useState<ControlValues>({});
  const [seed, setSeed] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [clipId, setClipId] = useState<string | null>(null);
  const [applied, setApplied] = useState<{
    itemId: string;
    clip: string;
    comp: string | null;
    prevComp: string | null;
    updated: boolean;
  } | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyFallback, setApplyFallback] = useState<string | null>(null);
  const [staleClip, setStaleClip] = useState(false);
  const [landing, setLanding] = useState<PieceLanding | null>(null);
  const [autoSeq, setAutoSeq] = useState(0);
  const previewRef = useRef<PreviewHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const typeGroupRef = useRef<HTMLDivElement>(null);
  const landingRef = useRef<PieceLanding | null>(null);
  landingRef.current = landing;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const applyingRef = useRef(false);
  const autoDirtyRef = useRef(false);

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
  const targetId = live ? rigTargetId(live) : null;
  const name = live?.name ?? piece?.name ?? "New piece";

  const load = (next: EffectSpec) => {
    setSpec(next);
    setRig(rigOf(next));
    setControls(defaultControls(next));
    setApplied(null);
    setApplyError(null);
    setApplyFallback(null);
    setStaleClip(false);
    // A piece applied in an earlier session starts on its remembered clip.
    const remembered = landings?.[next.id] ?? null;
    if (remembered && !landingRef.current) {
      setLanding(remembered);
      const match = clips.find(
        (entry) => entry.trackIndex === remembered.trackIndex && entry.clipIndex === remembered.clipIndex,
      );
      if (match) setClipId(match.id);
    }
  };

  // Edit mode: a passed spec loads at once; otherwise read the stored
  // draft by id. A piece with no stored draft (a catalogue macro) keeps
  // its brief and drafts on send; only a bare id that loads nothing
  // says so out loud.
  useEffect(() => {
    if (!editId || !piece) return;
    const brief = piece.brief ?? readPieceBrief(piece.id) ?? "";
    if (brief) setSeed({ id: Date.now(), text: brief });
    if (piece.spec) {
      load(piece.spec);
      setPieceType(piece.type ?? typeOfSpec(piece.spec));
      return;
    }
    setPieceType(piece.type ?? "effect");
    setEditLoading(true);
    setFailed(null);
    const controller = new AbortController();
    fetchEffect(piece.id, { signal: controller.signal })
      .then((record) => {
        load(record.spec);
        if (!piece.type) setPieceType(typeOfSpec(record.spec));
        setEditLoading(false);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setEditLoading(false);
        if (!brief) setFailed(error instanceof Error ? error.message : "That piece would not load.");
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const useSample = (why?: string) => {
    load(sampleEffect());
    setNote(why ?? "Sample piece loaded.");
  };

  /** Draft, then up to two vision checks; a failed check swaps in the revised spec. */
  const generate = async (brief: string, refs: { id: string; label: string }[]) => {
    const clean = brief.trim();
    if (!clean || busyRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setBusy(true);
    setFailed(null);
    setNote(null);
    setStatus("Muse Spark is drafting");
    try {
      const made = await generateEffect(
        {
          prompt: briefWithType(pieceType, clean),
          canvas: CANVAS,
          fps: 30,
          durationSec: 3,
          references: refs,
        },
        { signal },
      );
      writePieceBrief(made.id, clean);
      load(made.spec);
      let verdictNote = made.notes || "Draft written.";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        setStatus(`Vision check ${attempt}`);
        await wait(250);
        try {
          const frame = previewRef.current?.capture(made.spec.durationSec * 0.55);
          if (!frame) throw new Error("the preview could not capture a frame");
          const verdict = await verifyEffect(made.id, { previewPng: frame }, { signal });
          if (verdict.pass || !verdict.revisedSpec) {
            verdictNote = verdict.notes || (verdict.pass ? "The preview matches the brief." : "The preview differs from the brief.");
            break;
          }
          load(verdict.revisedSpec);
          made.spec = verdict.revisedSpec;
          verdictNote = verdict.notes || "Draft revised after the vision check.";
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          verdictNote = error instanceof Error ? error.message : "The vision check failed.";
          break;
        }
      }
      setNote(verdictNote);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setNote("Stopped.");
      } else {
        const message = error instanceof Error ? error.message : "Generation failed.";
        setFailed(message);
        if (agentMissing(error) && !spec) useSample("Muse Spark is not connected or the key was refused, so the sample stands in.");
      }
    } finally {
      setStatus(null);
      setBusy(false);
      abortRef.current = null;
    }
  };

  /** The bar's send: a send mid-draft puts the words back instead of dropping them. */
  const send = (draft: ChatDraft) => {
    if (busyRef.current) {
      setSeed({ id: Date.now(), text: draft.text });
      setNote("Still drafting — your words are back in the bar.");
      return;
    }
    void generate(
      draft.text,
      draft.refs.map(({ id, label }) => ({ id, label })),
    );
  };

  const moveType = (direction: 1 | -1) => {
    const at = PIECE_TYPES.findIndex((entry) => entry.id === pieceType);
    const next = PIECE_TYPES[(at + direction + PIECE_TYPES.length) % PIECE_TYPES.length]!;
    setPieceType(next.id);
    requestAnimationFrame(() => {
      typeGroupRef.current?.querySelector<HTMLButtonElement>(`[data-type="${next.id}"]`)?.focus();
    });
  };

  /**
   * Apply the live piece to one Resolve clip as a new comp version. The
   * history entry is recorded only after Resolve answers, and only the
   * first apply records one: re-applies are new comp versions of the
   * same piece, tracked in the landing.
   */
  const doApply = async (at: { trackIndex: number; clipIndex: number; trackType: "video" | "audio" }) => {
    if (!live || !bake || applyingRef.current) {
      autoDirtyRef.current = true;
      return;
    }
    applyingRef.current = true;
    setApplyBusy(true);
    setApplyError(null);
    setApplyFallback(null);
    setStaleClip(false);
    try {
      const result = await applyPiece(
        {
          spec: live,
          ...(bake.keys > 0 ? { baked: bakedPayload(live, targetId) ?? undefined } : {}),
          trackIndex: at.trackIndex,
          clipIndex: at.clipIndex,
          trackType: at.trackType,
        },
      );
      if (isPieceFallback(result)) {
        setApplyFallback(result.fallback.reason);
        return;
      }
      const next: PieceLanding = {
        project: result.project,
        timeline: result.timeline,
        trackIndex: at.trackIndex,
        clipIndex: at.clipIndex,
        trackType: at.trackType,
        compName: result.compName,
        prevCompName: result.prevCompName,
      };
      const first = !landingRef.current;
      setLanding(next);
      onRecordLanding?.(live.id, next);
      if (first && clip) {
        const itemId = onApply(
          effectItem({
            spec: live,
            controls,
            targetId: clip.id,
            bakedKeys: bake.keys,
            resolve: { compName: result.compName, prevCompName: result.prevCompName },
          }),
        );
        if (itemId) {
          setApplied({ itemId, clip: clip.name, comp: result.compName, prevComp: result.prevCompName, updated: false });
        }
      } else {
        setApplied((current) =>
          current ? { ...current, comp: result.compName, prevComp: result.prevCompName, updated: true } : current,
        );
      }
    } catch (error) {
      if (isClipGoneError(error)) setStaleClip(true);
      setApplyError(error instanceof Error ? error.message : "The apply failed.");
    } finally {
      applyingRef.current = false;
      setApplyBusy(false);
      if (autoDirtyRef.current) {
        autoDirtyRef.current = false;
        setAutoSeq((seq) => seq + 1);
      }
    }
  };

  /** The button: the picked clip, defaulting to the first clip on track 1. */
  const apply = () => {
    if (!live || !bake) return;
    void doApply({
      trackIndex: clip?.trackIndex ?? 1,
      clipIndex: clip?.clipIndex ?? 0,
      trackType: clip?.trackType ?? "video",
    });
  };

  /** Undo back to the previous comp version, then rewind the mirror entry. */
  const undoApplied = async () => {
    if (!applied || !landing) return;
    if (applied.prevComp) {
      try {
        await revertPiece({
          project: landing.project || undefined,
          timeline: landing.timeline || undefined,
          trackIndex: landing.trackIndex,
          clipIndex: landing.clipIndex,
          trackType: landing.trackType,
          toComp: applied.prevComp,
        });
        const back: PieceLanding = { ...landing, compName: applied.prevComp, prevCompName: null };
        setLanding(back);
        if (live) onRecordLanding?.(live.id, back);
      } catch (error) {
        setApplyError(pieceUndoErrorMessage(error));
        return;
      }
    }
    onUndo(applied.itemId);
    setApplied(null);
  };

  // Re-prompts and tweaks re-apply to the remembered clip on their own.
  useEffect(() => {
    if (autoSeq === 0) return;
    const remembered = landingRef.current;
    if (!remembered || !live || !bake) return;
    void doApply({ trackIndex: remembered.trackIndex, clipIndex: remembered.clipIndex, trackType: remembered.trackType });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSeq]);

  useEffect(() => {
    if (!landing || !live) return;
    const timer = window.setTimeout(() => setAutoSeq((seq) => seq + 1), 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, rig]);

  const patchControl = (id: string, patch: { label?: string; default?: ControlValue }) => {
    setSpec((current) => (current ? updateControl(current, id, patch) : current));
    if (patch.default !== undefined) {
      const value = patch.default;
      setControls((current) => ({ ...current, [id]: value }));
    }
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3 overflow-y-auto overscroll-contain">
      {onBack ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onBack} aria-label="Back">
            <ChevronLeftIcon />
            Back
          </Button>
          <h2 className="min-w-0 truncate text-title text-neutral-100">{name}</h2>
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-3">
        <span className="text-meta text-neutral-400">Type</span>
        <div ref={typeGroupRef} className="contents">
        <SegmentedControl
          role="radiogroup"
          aria-label="Piece type"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              moveType(1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              moveType(-1);
            }
          }}
        >
          {PIECE_TYPES.map((entry) => {
            const checked = pieceType === entry.id;
            return (
              <SegmentedControlItem
                key={entry.id}
                data-type={entry.id}
                role="radio"
                aria-checked={checked}
                data-checked={checked || undefined}
                tabIndex={checked ? 0 : -1}
                onClick={() => setPieceType(entry.id)}
              >
                {entry.label}
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>
        </div>
      </div>

      <section aria-label="Preview" className={cn(CARD, "flex shrink-0 flex-col gap-3 p-4")}>
        {live ? (
          <PreviewStage ref={previewRef} spec={live} controls={controls} className="w-full flex-none" />
        ) : (
          <div className="flex aspect-video min-h-56 w-full flex-none flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-dashed border-white/12 px-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-white/[0.05] ring-1 ring-white/10">
              {busy || editLoading ? (
                <Spinner className="size-5 text-amber-300" />
              ) : (
                <SparklesIcon className="size-5 text-neutral-300" aria-hidden="true" />
              )}
            </span>
            <p className="text-sm font-medium text-neutral-200">
              {editLoading ? `Loading ${name}…` : busy ? `Muse Spark is drafting… ${elapsed}s` : "Describe the piece below to draft it"}
            </p>
            {!busy && !editLoading ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => useSample()}>
                Sample
              </Button>
            ) : null}
          </div>
        )}

        <div className="flex shrink-0 flex-wrap items-center gap-2 px-1">
          {clips.length > 0 && clip ? (
            <Select
              items={clips.map((entry) => ({ label: `${entry.name} · ${entry.track}`, value: entry.id }))}
              value={clip.id}
              onValueChange={(value) => setClipId(value as string)}
            >
              <SelectTrigger size="sm" className="w-48 min-w-0" aria-label="Clip to apply onto">
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
            <span className="text-xs text-neutral-500">No clip to land on yet</span>
          )}
          <Button type="button" size="sm" className="ml-auto" disabled={!live || !clip || busy || applyBusy} onClick={apply}>
            {applyBusy ? <Spinner /> : <PackageIcon />}
            {applyBusy ? "Applying…" : "Apply to Resolve"}
          </Button>
        </div>

        <div className="flex shrink-0 flex-col gap-2.5 px-1">
          {info ? (
            <div className="flex items-start gap-2.5 text-xs leading-5">
              <Badge variant={info.fallback ? "warning" : "success"} size="sm" className="mt-0.5">
                {info.label}
              </Badge>
              {info.fallback ? (
                <p className="min-w-0 flex-1 text-neutral-400">
                  <span className="text-neutral-300">Fallback: </span>
                  {info.reason}
                </p>
              ) : (
                <InfoHint>Why this target: {info.reason}</InfoHint>
              )}
            </div>
          ) : null}
          <div aria-live="polite" className="flex flex-col gap-2">
            {applied ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-emerald-400/[0.07] px-3 py-2 text-xs text-emerald-200/90 ring-1 ring-emerald-400/20 ring-inset">
                <CheckCircle2Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {applied.updated ? "Updated in Resolve" : `Added to ${applied.clip}`}
                  {applied.comp ? ` as ${applied.comp}` : " as a new comp version"}.
                </span>
                <Button type="button" size="xs" variant="ghost" onClick={() => void undoApplied()}>
                  <Undo2Icon />
                  Undo
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={onOpenHistory}>
                  <HistoryIcon />
                  History
                </Button>
              </p>
            ) : null}
            {applyFallback ? (
              <p className="rounded-xl bg-amber-300/[0.07] px-3 py-2 text-xs text-amber-200/90 ring-1 ring-amber-300/20 ring-inset">
                <span className="font-medium">Fallback: </span>
                {applyFallback}
              </p>
            ) : null}
            {applyError ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-red-400/[0.07] px-3 py-2 text-xs text-red-200/90 ring-1 ring-red-400/20 ring-inset">
                <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {staleClip
                    ? "That clip is gone from Resolve — the cut changed under this piece."
                    : applyError}
                </span>
                {staleClip && clip ? (
                  <Button type="button" size="xs" variant="ghost" onClick={apply}>
                    <PackageIcon />
                    Apply to current clip
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!applied && !applyError && refusal ? (
              <p className="rounded-xl bg-red-400/[0.07] px-3 py-2 text-xs text-red-200/90 ring-1 ring-red-400/20 ring-inset">
                Not applied: {refusal}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <VariablesPanel spec={spec} onPatch={patchControl} />
      {rig ? (
        <RigPanel
          rig={rig}
          bake={bake ?? { spec: spec as EffectSpec, keys: 0, frames: 0 }}
          onChange={(patch) => setRig((current) => (current ? { ...current, ...patch } : current))}
          onReset={() => spec && setRig(rigOf(spec))}
        />
      ) : null}

      {failed || status || note ? (
        <div aria-live="polite" className="flex shrink-0 items-start gap-2 px-1 text-xs leading-5">
          {failed ? (
            <>
              <AlertCircleIcon className="size-3.5 shrink-0 translate-y-0.5 text-red-400" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-red-200/90">{failed}</p>
            </>
          ) : status ? (
            <>
              <Spinner className="size-3.5 shrink-0 translate-y-0.5 text-amber-300" />
              <p className="min-w-0 flex-1 text-neutral-300">
                {status}
                {busy ? `… ${elapsed}s` : "…"}
              </p>
              {busy ? (
                <Button type="button" size="xs" variant="ghost" onClick={() => abortRef.current?.abort()}>
                  Stop
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <SparklesIcon className="size-3.5 shrink-0 translate-y-0.5 text-neutral-500" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-neutral-500">{note}</p>
            </>
          )}
        </div>
      ) : null}

      <div className="sticky bottom-0 shrink-0">
        <ChatPrompt
          open
          wide
          hideModelPicker
          suggestion={seed}
          placeholder={editId ? `Change ${name}…` : "Describe the piece…"}
          onOpen={() => {}}
          onClose={() => {}}
          onSend={send}
        />
      </div>
    </div>
  );
}
