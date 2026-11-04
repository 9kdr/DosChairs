import { ArrowUp, AudioLines, ChevronDown, Film, ImageIcon, KeyRound, Mic, Paperclip, Puzzle, Slash, Square, Waypoints, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { acceptsChairRef, readChairRefs, type ChairRef } from "@/lib/chair-ref";
import { cn } from "@/lib/utils";
import { filterActions, type Action } from "@/orchestrator/actions";
import { enabledModels, PROVIDERS, type ProviderId } from "@/settings/providers";
import { useSettings } from "@/settings/useSettings";

const CLOSED_WIDTH = 452;
const OPEN_WIDTH = 520;
const CLOSED_RADIUS = 24;
const OPEN_RADIUS = 22;
const MORPH = "380ms cubic-bezier(0.22, 1, 0.36, 1)";
const LINE = 22;
const MAX_ROWS = 4;
const ZWSP = "\u200B";

/**
 * Orchestrator picker options: enabled models from saved keys of enabled providers.
 * Providers with no key or switched off add nothing.
 * Invented presets are removed.
 */
export function orchestratorOptions(
  keys: Record<ProviderId, string | null>,
  opts?: {
    enabled?: Record<ProviderId, boolean>;
    customModels?: Record<ProviderId, string[]>;
    disabledModels?: Record<ProviderId, string[]>;
  },
): string[] {
  return PROVIDERS.filter(
    (provider) =>
      keys[provider.id] != null && opts?.enabled?.[provider.id] !== false,
  ).flatMap((provider) =>
    enabledModels({
      provider: provider.id,
      custom: opts?.customModels?.[provider.id],
      disabled: opts?.disabledModels?.[provider.id],
    }).map((name) => `${name} (${provider.label})`),
  );
}

/** The stored pick when it is still offered, else the first available model, or null. */
export function resolveOrchestrator(
  stored: string | null,
  options: readonly string[],
): string | null {
  if (stored != null && options.includes(stored)) return stored;
  const firstSupported = options.find((opt) => !opt.endsWith("(Anthropic)"));
  return firstSupported ?? options[0] ?? null;
}

export type ChatDraft = {
  text: string;
  files: readonly string[];
  model: string;
};

type ChatPromptProps = {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSend: (draft: ChatDraft) => void;
  /** Full parent width with room to grow, for inline thread composers. */
  wide?: boolean;
  placeholder?: string;
  /** A picked suggestion fills the composer once, by id. */
  suggestion?: { id: number; text: string } | null;
  /** Where "Add a model key" goes: the project screen's Settings. */
  onOpenSettings?: () => void;
};

type TextPiece = { type: "text"; id: string; value: string };
type RefPiece = { type: "ref"; id: string; kind: ChairRef["kind"]; label: string };
type Piece = TextPiece | RefPiece;

let pieceSeq = 0;

function nextPieceId() {
  pieceSeq += 1;
  return `piece-${pieceSeq}`;
}

function textPiece(value: string, id = nextPieceId()): TextPiece {
  return { type: "text", id, value };
}

function sizeOf(piece: Piece) {
  return piece.type === "text" ? piece.value.length : 1;
}

function totalSize(parts: readonly Piece[]) {
  return parts.reduce((sum, piece) => sum + sizeOf(piece), 0);
}

function clonePiece(piece: Piece): Piece {
  return piece.type === "text"
    ? { type: "text", id: piece.id, value: piece.value }
    : { type: "ref", id: piece.id, kind: piece.kind, label: piece.label };
}

function normalize(parts: readonly Piece[]): Piece[] {
  const merged: Piece[] = [];
  for (const piece of parts) {
    if (piece.type === "text" && piece.value.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (piece.type === "text" && prev?.type === "text") {
      prev.value += piece.value;
      continue;
    }
    merged.push(clonePiece(piece));
  }
  const padded: Piece[] = [];
  for (const piece of merged) {
    const prev = padded[padded.length - 1];
    if (piece.type === "ref" && prev?.type !== "text") {
      padded.push(textPiece(""));
    }
    padded.push(piece);
  }
  if (padded.length === 0 || padded[0]?.type === "ref") padded.unshift(textPiece(""));
  if (padded[padded.length - 1]?.type !== "text") padded.push(textPiece(""));
  return padded;
}

function takeUntil(parts: readonly Piece[], offset: number): Piece[] {
  let left = offset;
  const out: Piece[] = [];
  for (const piece of parts) {
    if (left <= 0) break;
    const size = sizeOf(piece);
    if (size === 0) continue;
    if (left >= size) {
      out.push(clonePiece(piece));
      left -= size;
      continue;
    }
    if (piece.type === "text") {
      out.push(textPiece(piece.value.slice(0, left), piece.id));
    }
    break;
  }
  return out;
}

function dropUntil(parts: readonly Piece[], offset: number): Piece[] {
  let left = offset;
  for (let index = 0; index < parts.length; index += 1) {
    const piece = parts[index];
    if (!piece) continue;
    const size = sizeOf(piece);
    if (left >= size) {
      left -= size;
      continue;
    }
    const out: Piece[] = [];
    if (piece.type === "text") {
      const value = piece.value.slice(left);
      if (value.length > 0) out.push(textPiece(value));
    } else if (left === 0) {
      out.push(clonePiece(piece));
    }
    for (let rest = index + 1; rest < parts.length; rest += 1) {
      const next = parts[rest];
      if (next) out.push(clonePiece(next));
    }
    return out;
  }
  return [];
}

function edit(
  parts: readonly Piece[],
  start: number,
  end: number,
  insert: readonly Piece[],
): { parts: Piece[]; caret: number } {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(0, Math.max(start, end));
  const next = normalize([...takeUntil(parts, from), ...insert.map(clonePiece), ...dropUntil(parts, to)]);
  return { parts: next, caret: from + insert.reduce((sum, piece) => sum + sizeOf(piece), 0) };
}

function serialize(parts: readonly Piece[]) {
  return parts
    .map((piece) => (piece.type === "text" ? piece.value : `[${piece.kind}:${piece.label}]`))
    .join("");
}

function plainText(parts: readonly Piece[]) {
  return parts
    .filter((piece): piece is TextPiece => piece.type === "text")
    .map((piece) => piece.value)
    .join("");
}

function sliceParts(parts: readonly Piece[], start: number, end: number) {
  return dropUntil(takeUntil(parts, Math.max(start, end)), Math.min(start, end));
}

function shortName(name: string, max = 28) {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const tail = Math.min(10, Math.floor(max / 2));
  const head = Math.max(1, max - tail - 1);
  return `${chars.slice(0, head).join("")}…${chars.slice(-tail).join("")}`;
}

type ChipTone = "video" | "image" | "audio" | "task" | "piece";

const CHIP_TONE: Record<ChipTone, string> = {
  video: "bg-info/15 text-info-foreground ring-1 ring-info/40",
  image: "bg-warning/15 text-warning-foreground ring-1 ring-warning/40",
  audio: "bg-success/15 text-success-foreground ring-1 ring-success/40",
  task: "bg-violet-400/15 text-violet-300 ring-1 ring-violet-300/40",
  piece: "bg-white/10 text-neutral-100 ring-1 ring-white/15",
};

const VIDEO_EXT = new Set(["mov", "mp4", "mxf", "webm", "mkv", "avi"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"]);
const AUDIO_EXT = new Set(["wav", "mp3", "aac", "flac", "aiff", "aif", "m4a", "ogg"]);

function chipTone(kind: "asset" | "task" | "piece", label: string): ChipTone {
  if (kind === "task") return "task";
  if (kind === "piece") return "piece";
  const ext = label.split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "piece";
}

function ChipGlyph({ tone }: { tone: ChipTone }) {
  const className = "size-[1em] shrink-0";
  if (tone === "task") return <Waypoints className={className} aria-hidden="true" />;
  if (tone === "image") return <ImageIcon className={className} aria-hidden="true" />;
  if (tone === "audio") return <AudioLines className={className} aria-hidden="true" />;
  if (tone === "video") return <Film className={className} aria-hidden="true" />;
  return <Puzzle className={className} aria-hidden="true" />;
}

function inBarOverlay(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest("[data-slot=menu-popup], [data-slot=menu-positioner], [data-chair-menu]"))
  );
}

function boundaryOffset(
  root: HTMLElement,
  container: Node,
  offset: number,
  parts: readonly Piece[],
) {
  if (container !== root && !root.contains(container)) return totalSize(parts);
  if (container === root) {
    let count = 0;
    const children = Array.from(root.children);
    for (let index = 0; index < Math.min(offset, children.length); index += 1) {
      const child = children[index];
      if (!(child instanceof HTMLElement)) continue;
      const piece = parts.find((item) => item.id === child.dataset.partId);
      if (piece) count += sizeOf(piece);
    }
    return count;
  }
  const host =
    container instanceof HTMLElement
      ? container.closest("[data-part-id]")
      : container.parentElement?.closest("[data-part-id]");
  if (!(host instanceof HTMLElement) || !root.contains(host)) return totalSize(parts);
  const piece = parts.find((item) => item.id === host.dataset.partId);
  if (!piece) return totalSize(parts);
  let count = 0;
  for (const item of parts) {
    if (item.id === piece.id) break;
    count += sizeOf(item);
  }
  if (piece.type === "ref") return count + (host.contains(container) ? 1 : 0);
  if (container.nodeType === Node.TEXT_NODE) {
    const raw = container.textContent ?? "";
    const cleaned = raw.slice(0, offset).replaceAll(ZWSP, "").length;
    return count + Math.min(cleaned, piece.value.length);
  }
  return count;
}

function covers(root: HTMLElement, node: Node) {
  return node === root || root.contains(node);
}

function readRange(root: HTMLElement, parts: readonly Piece[]) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!covers(root, range.startContainer) || !covers(root, range.endContainer)) return null;
  const start = boundaryOffset(root, range.startContainer, range.startOffset, parts);
  const end = boundaryOffset(root, range.endContainer, range.endOffset, parts);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function placeCaret(root: HTMLElement, parts: readonly Piece[], caret: number) {
  const selection = window.getSelection();
  if (!selection) return;
  let left = Math.max(0, caret);
  const range = document.createRange();
  for (const piece of parts) {
    const el = root.querySelector<HTMLElement>(`[data-part-id="${CSS.escape(piece.id)}"]`);
    if (!el) continue;
    if (piece.type === "ref") {
      if (left <= 0) {
        range.setStartBefore(el);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      left -= 1;
      continue;
    }
    if (left <= piece.value.length) {
      const node = el.firstChild;
      if (node && node.nodeType === Node.TEXT_NODE) {
        const max = node.textContent?.length ?? 0;
        const at = piece.value.length === 0 ? max : Math.min(left, max);
        range.setStart(node, at);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
    }
    left -= piece.value.length;
  }
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function commandText(parts: readonly Piece[], key: string) {
  let replaced = false;
  const text = parts
    .map((piece) => {
      if (piece.type === "ref") return `[${piece.kind}:${piece.label}]`;
      if (replaced || !piece.value.includes("/")) return piece.value;
      replaced = true;
      return piece.value.replace(/\/\S*/, key);
    })
    .join("")
    .trim();
  if (replaced) return text;
  const rest = serialize(parts).trim();
  return rest.length > 0 ? `${key} ${rest}` : key;
}

/**
 * Command bar for the open project. A click expands the bar. The project
 * view behind it stays where it is.
 */
export function ChatPrompt({
  open,
  onOpen,
  onClose,
  onSend,
  wide = false,
  placeholder = "Ask Chair, or / for an action",
  suggestion = null,
  onOpenSettings,
}: ChatPromptProps) {
  const [parts, setParts] = useState<Piece[]>(() => normalize([]));
  const [model, setModel] = useState<string | null>(null);
  // Orchestrator pick: real models from saved keys of enabled providers.
  // The choice persists in app settings.
  const { settings, loaded, saveOrchestrator } = useSettings();
  const options = useMemo(
    () =>
      orchestratorOptions(settings.keys, {
        enabled: settings.enabled,
        customModels: settings.customModels,
        disabledModels: settings.disabledModels,
      }),
    [
      settings.keys,
      settings.enabled,
      settings.customModels,
      settings.disabledModels,
    ],
  );
  useEffect(() => {
    if (!loaded) return;
    setModel(resolveOrchestrator(settings.orchestrator, options));
  }, [loaded, settings.orchestrator, options]);
  const pickModel = (value: string | null) => {
    if (value == null || !options.includes(value)) return;
    setModel(value);
    void saveOrchestrator(value);
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsBox, setActionsBox] = useState<{ left: number; bottom: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Voice notes record in-browser and attach by name, like picked files.
  // Blobs are kept for a future upload step; sending still uses names.
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const blobsRef = useRef(new Map<string, Blob>());
  const [box, setBox] = useState({ width: CLOSED_WIDTH, height: 48 });
  // Dropping chips in lands a whole row of content at once: tweening the box
  // around it leaves the full-size content spilling out of a small rounded
  // box mid-flight, which reads as broken. Snap that one commit instead.
  const [snap, setSnap] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLSpanElement>(null);
  const partsRef = useRef(parts);
  const caretRef = useRef<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const handledKey = useRef(false);
  const listId = useId();
  const reduce = useReducedMotion();
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  partsRef.current = parts;

  const draft = serialize(parts);
  const plain = plainText(parts);

  // A picked suggestion fills the composer once, ready to send or edit.
  const filledSuggestion = useRef<number | null>(null);
  useEffect(() => {
    if (suggestion === null || filledSuggestion.current === suggestion.id) return;
    filledSuggestion.current = suggestion.id;
    const fresh = normalize([textPiece(suggestion.text)]);
    partsRef.current = fresh;
    caretRef.current = totalSize(fresh);
    pendingCaret.current = null;
    setParts(fresh);
    onOpen();
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      placeCaret(editor, fresh, totalSize(fresh));
    });
  }, [suggestion, onOpen]);

  const commit = (next: { parts: Piece[]; caret: number }, source: "type" | "drop") => {
    partsRef.current = next.parts;
    caretRef.current = next.caret;
    pendingCaret.current =
      document.activeElement === editorRef.current ? next.caret : null;
    setParts(next.parts);
    if (source === "type") {
      setHighlight(0);
      if (!wide && plainText(next.parts).startsWith("/")) {
        setActionsOpen(true);
        setMenuOpen(false);
      }
    }
  };

  const stopRecording = (cancel = false) => {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    if (cancel) chunksRef.current = [];
  };

  useEffect(
    () => () => {
      // Never leave the mic open if the composer unmounts mid-take.
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const toggleRecording = async () => {
    if (recording) {
      stopRecording();
      return;
    }
    setRecError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) return;
        const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "");
        const name = `voice-note-${stamp}.${blob.type.includes("mp4") ? "m4a" : "webm"}`;
        blobsRef.current.set(name, blob);
        setFiles((current) => [...current, name]);
      };
      recorder.start();
      setRecording(true);
    } catch {
      setRecError("Microphone unavailable. Check browser and OS permission.");
    }
  };

  const clearComposer = () => {
    if (recorderRef.current) stopRecording();
    const fresh = normalize([]);
    partsRef.current = fresh;
    caretRef.current = 0;
    pendingCaret.current = document.activeElement === editorRef.current ? 0 : null;
    setParts(fresh);
    setFiles([]);
    setMenuOpen(false);
    setActionsOpen(false);
    setHighlight(0);
  };

  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el || document.activeElement !== el) return;
    const pending = pendingCaret.current;
    pendingCaret.current = null;
    const saved = pending ?? caretRef.current;
    if (saved == null) return;
    const live = readRange(el, parts);
    const jumped = live == null || (live.start === 0 && live.end === 0 && saved !== 0);
    if (pending == null && !jumped) return;
    placeCaret(el, parts, pending ?? saved);
  }, [parts, open]);

  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (!open) {
      el.style.height = "";
      el.style.overflowY = "hidden";
      return;
    }
    el.style.height = "0px";
    const max = LINE * (wide ? 6 : MAX_ROWS);
    const next = Math.min(Math.max(el.scrollHeight, LINE + 16), max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft, open, wide]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const content = contentRef.current;
    if (!bar || !content) return;

    const measure = () => {
      const available = bar.parentElement?.clientWidth ?? OPEN_WIDTH;
      const cap = open ? (wide ? available : OPEN_WIDTH) : CLOSED_WIDTH;
      const preferred = Math.min(cap, available);
      const previousContentWidth = content.style.width;
      content.style.width = "max-content";
      const needed = Math.ceil(content.getBoundingClientRect().width);
      const width = open ? preferred : Math.min(Math.max(preferred, needed), available);
      content.style.width = `${width}px`;
      const height = Math.ceil(content.getBoundingClientRect().height);
      content.style.width = previousContentWidth;
      setBox((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };

    measure();
    const parent = bar.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [draft, files, open, wide]);

  useLayoutEffect(() => {
    if (!actionsOpen) return;
    const place = () => {
      const trigger = actionsRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setActionsBox({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
    };
    place();
    const bar = barRef.current;
    const observer = new ResizeObserver(place);
    if (bar) observer.observe(bar);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [actionsOpen, box.width, box.height]);

  useEffect(() => {
    const onSelect = () => {
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
      if (document.activeElement !== editor) return;
      const node = selection.anchorNode;
      if (!node || !editor.contains(node)) return;
      caretRef.current = boundaryOffset(
        editor,
        selection.getRangeAt(0).startContainer,
        selection.getRangeAt(0).startOffset,
        partsRef.current,
      );
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, []);

  useEffect(() => {
    const release = () => {
      const bar = barRef.current;
      if (bar) bar.style.transform = "";
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setMenuOpen(false);
      setActionsOpen(false);
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const bar = barRef.current;
      if (!bar) return;
      if (event.target instanceof Node && bar.contains(event.target)) return;
      if (inBarOverlay(event.target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (actionsOpen) {
          setActionsOpen(false);
          return;
        }
        if (menuOpen) {
          setMenuOpen(false);
          return;
        }
        onClose();
      }
    };
    const keepCaret = (event: PointerEvent) => {
      const editor = editorRef.current;
      if (!editor || document.activeElement !== editor) return;
      if (event.target instanceof Node && editor.contains(event.target)) return;
      const range = readRange(editor, partsRef.current);
      if (range && range.start === range.end) caretRef.current = range.start;
    };
    window.addEventListener("pointerdown", keepCaret, true);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", keepCaret, true);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [actionsOpen, menuOpen, onClose, open]);

  const sendText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;
    onSend({ text: trimmed, files, model: model ?? "" });
    clearComposer();
  };

  const send = () => sendText(serialize(partsRef.current));

  const actions = actionsOpen ? filterActions(plain.startsWith("/") ? plain : "") : [];
  const picked = actions[Math.min(highlight, Math.max(actions.length - 1, 0))];

  const take = (action: Action) => {
    setActionsOpen(false);
    setHighlight(0);
    if (!action.slot) {
      sendText(commandText(partsRef.current, action.key));
      return;
    }
    const current = partsRef.current;
    let replaced = false;
    const rewritten = current.map((piece) => {
      if (piece.type !== "text" || replaced || !piece.value.includes("/")) return clonePiece(piece);
      replaced = true;
      return textPiece(piece.value.replace(/\/\S*/, `${action.key} `), piece.id);
    });
    const next = normalize(replaced ? rewritten : [textPiece(`${action.key} `), ...current]);
    const caret = next[0]?.type === "text" ? next[0].value.length : 0;
    commit({ parts: next, caret }, "type");
    editorRef.current?.focus();
  };

  const editSelection = (start: number, end: number, insert: Piece[]) => {
    commit(edit(partsRef.current, start, end, insert), "type");
  };

  const deleteUnits = (direction: "back" | "forward") => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = readRange(editor, partsRef.current);
    if (!range) return;
    if (range.start !== range.end) {
      editSelection(range.start, range.end, []);
      return;
    }
    if (direction === "back") {
      if (range.start <= 0) return;
      editSelection(range.start - 1, range.start, []);
      return;
    }
    if (range.start >= totalSize(partsRef.current)) return;
    editSelection(range.start, range.start + 1, []);
  };

  const insertPlain = (text: string) => {
    if (text.length === 0) return;
    const editor = editorRef.current;
    const current = partsRef.current;
    const range = editor ? readRange(editor, current) : null;
    const start = range?.start ?? caretRef.current ?? totalSize(current);
    const end = range?.end ?? start;
    editSelection(start, end, [textPiece(text)]);
  };

  const typeInRef = useRef<(text: string) => void>(() => {});
  typeInRef.current = (text: string) => {
    onOpen();
    const editor = editorRef.current;
    const saved = caretRef.current ?? (editor ? totalSize(partsRef.current) : 0);
    editor?.focus();
    if (editor) placeCaret(editor, partsRef.current, saved);
    insertPlain(text);
  };
  const editRef = useRef({
    insertPlain: (_text: string) => {},
    deleteUnits: (_direction: "back" | "forward") => {},
  });
  editRef.current.insertPlain = insertPlain;
  editRef.current.deleteUnits = deleteUnits;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const onNativeBeforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
        event.preventDefault();
        return;
      }
      if (event.inputType === "insertText" || event.inputType === "insertReplacementText") {
        event.preventDefault();
        editRef.current.insertPlain(event.data ?? "");
        return;
      }
      if (
        event.inputType === "deleteContentBackward" ||
        event.inputType === "deleteContentForward"
      ) {
        event.preventDefault();
        if (handledKey.current) return;
        editRef.current.deleteUnits(
          event.inputType === "deleteContentBackward" ? "back" : "forward",
        );
      }
    };
    editor.addEventListener("beforeinput", onNativeBeforeInput);
    return () => editor.removeEventListener("beforeinput", onNativeBeforeInput);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      const target = event.target;
      if (target instanceof Element) {
        const field = target.closest("input, textarea, select, [contenteditable='true']");
        if (field) return;
        if (target.closest("[data-slot=menu-popup], [data-slot=menu-positioner], [data-chair-menu]")) {
          return;
        }
      }
      if (document.querySelector("[data-slot=menu-popup], [data-chair-menu]")) return;
      event.preventDefault();
      typeInRef.current(event.key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const insertRefs = (refs: ChairRef[]) => {
    if (refs.length === 0) return;
    const editor = editorRef.current;
    const current = partsRef.current;
    const focused = editor != null && document.activeElement === editor;
    const live = editor && focused ? readRange(editor, current) : null;
    const caret = live ? live.start : (caretRef.current ?? totalSize(current));
    const end = live && live.start !== live.end ? live.end : caret;
    commit(
      edit(
        current,
        Math.min(caret, end),
        Math.max(caret, end),
        refs.map((ref) => ({ type: "ref" as const, id: nextPieceId(), kind: ref.kind, label: ref.label })),
      ),
      "drop",
    );
  };

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      handledKey.current = true;
      queueMicrotask(() => {
        handledKey.current = false;
      });
      deleteUnits(event.key === "Backspace" ? "back" : "forward");
      return;
    }
    if (!open && event.key === "Enter") {
      event.preventDefault();
      return;
    }
    if (!open) return;
    if (actionsOpen && actions.length > 0 && event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (index + 1) % actions.length);
      return;
    }
    if (actionsOpen && actions.length > 0 && event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => (index - 1 + actions.length) % actions.length);
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      insertPlain("\n");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (actionsOpen && picked) {
        take(picked);
        return;
      }
      send();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    insertPlain(event.clipboardData.getData("text/plain"));
  };

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = readRange(editor, partsRef.current);
    if (!range || range.start === range.end) return;
    event.preventDefault();
    event.clipboardData.setData(
      "text/plain",
      serialize(sliceParts(partsRef.current, range.start, range.end)),
    );
  };

  const onCut = (event: ClipboardEvent<HTMLDivElement>) => {
    onCopy(event);
    const editor = editorRef.current;
    if (!editor) return;
    const range = readRange(editor, partsRef.current);
    if (!range || range.start === range.end) return;
    event.preventDefault();
    editSelection(range.start, range.end, []);
  };

  const radius = open ? OPEN_RADIUS : CLOSED_RADIUS;
  const morph =
    reduce || snap ? "none" : `width ${MORPH}, height ${MORPH}, border-radius ${MORPH}`;

  return (
    <div
      ref={barRef}
      className="relative max-w-full"
      style={{ width: box.width, height: box.height, transition: morph }}
      onPointerDown={(event) => {
        if (open || event.button !== 0 || reduceRef.current) return;
        const bar = barRef.current;
        if (bar) bar.style.transform = "scale(0.98)";
      }}
      onBlur={(event) => {
        if (!open) return;
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        if (inBarOverlay(next)) return;
        onClose();
      }}
      onDragEnter={(event) => {
        if (!acceptsChairRef(event.dataTransfer)) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(event) => {
        if (!acceptsChairRef(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setDragOver(false);
      }}
      onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
        const refs = readChairRefs(event.dataTransfer);
        if (refs.length === 0) return;
        event.preventDefault();
        setDragOver(false);
        // Snap this commit: the box lands at its final size instantly instead
        // of tweening around full-size content. Re-enable the morph after.
        setSnap(true);
        insertRefs(refs);
        // Dropping an asset opens the bar ready to type, starting right
        // after what was dragged in. `insertRefs` already leaves the caret
        // there; focus plus one placement makes it live.
        onOpen();
        requestAnimationFrame(() => {
          setSnap(false);
          const editor = editorRef.current;
          if (!editor) return;
          editor.focus();
          const at = caretRef.current ?? totalSize(partsRef.current);
          placeCaret(editor, partsRef.current, at);
        });
      }}
    >
      <div
        className={cn(
          "absolute inset-0 overflow-hidden",
          "bg-[#1a1a1a]/95 shadow-raised ring-1 ring-white/[0.08] backdrop-blur-md",
          "supports-[backdrop-filter]:bg-[#1a1a1a]/88",
          "focus-within:ring-white/15",
          dragOver && "bg-[#222]! ring-2 ring-white/20",
        )}
        style={{ borderRadius: radius, transition: morph }}
      >
        <div ref={contentRef} className="min-w-0 max-w-full overflow-hidden">
          {files.length > 0 ? (
            <div className="flex max-h-24 min-w-0 flex-wrap gap-1 overflow-y-auto px-3 pt-2 pb-1 [scrollbar-gutter:stable]">
              {files.map((name) => (
                <span
                  key={name}
                  className={cn(
                    "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs",
                    CHIP_TONE[chipTone("asset", name)],
                  )}
                >
                  <ChipGlyph tone={chipTone("asset", name)} />
                  <span className="truncate">{name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => setFiles((current) => current.filter((item) => item !== name))}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {recError ? (
            <p className="px-3 pt-2 pb-1 text-xs text-red-400">{recError}</p>
          ) : null}

          <form
            className="flex w-full flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (open) send();
            }}
          >
            <div className={cn("relative flex w-full min-w-0", open ? "flex-col" : "h-12 items-center")}>
              {draft.length === 0 ? (
                <span
                  className={cn(
                    "pointer-events-none absolute max-w-[calc(100%-2rem)] truncate text-sm text-neutral-500",
                    open ? "top-3 left-4" : "top-1/2 left-4 -translate-y-1/2",
                  )}
                >
                  {placeholder}
                </span>
              ) : null}
              <div
                ref={editorRef}
                role="textbox"
                aria-label="Ask Chair for a cut"
                aria-multiline={open}
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                className={cn(
                  "block min-h-[22px] border-0 bg-transparent text-sm leading-[22px] text-neutral-200 outline-none",
                    open
                    ? "w-full min-w-0 px-4 pt-3 pr-5 pb-1 whitespace-pre-wrap break-words"
                    : "min-w-0 flex-1 overflow-x-clip overflow-y-hidden py-3 pr-10 pl-4 whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]",
                )}
                onFocus={() => {
                  onOpen();
                  const editor = editorRef.current;
                  if (!editor) return;
                  const saved = caretRef.current;
                  if (saved == null || saved <= 0) return;
                  const live = readRange(editor, partsRef.current);
                  if (live && (live.start !== 0 || live.end !== 0)) return;
                  placeCaret(editor, partsRef.current, saved);
                }}
                onKeyDown={onEditorKeyDown}
                onPaste={onPaste}
                onCopy={onCopy}
                onCut={onCut}
              >
                {parts.map((piece) =>
                  piece.type === "text" ? (
                    <span key={piece.id} data-part-id={piece.id}>
                      {piece.value.length === 0 ? ZWSP : piece.value}
                    </span>
                  ) : (
                    <span
                      key={piece.id}
                      data-part-id={piece.id}
                      data-chair-kind={piece.kind}
                      data-chair-label={piece.label}
                      contentEditable={false}
                      draggable={false}
                      className={cn(
                        "mx-[0.15em] inline-flex max-w-[14em] min-w-0 items-center gap-[0.25em] rounded-sm px-[0.35em] align-middle select-none",
                        CHIP_TONE[chipTone(piece.kind, piece.label)],
                      )}
                    >
                      <ChipGlyph tone={chipTone(piece.kind, piece.label)} />
                      <span className="min-w-0 truncate">{shortName(piece.label)}</span>
                    </span>
                  ),
                )}
              </div>
            </div>
            <div className={cn("grid", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
              <div className="min-h-0 overflow-hidden">
                <div className="flex items-center justify-between gap-1 px-2 pt-1 pb-2">
                  <div className="flex min-w-0 items-center gap-0.5">
                    <input
                      ref={fileRef}
                      type="file"
                      className="sr-only"
                      accept="video/*,image/*,audio/*"
                      onChange={(event) => {
                        const next = Array.from(event.target.files ?? [], (file) => file.name);
                        if (next.length > 0) setFiles(next);
                        event.target.value = "";
                      }}
                    />
                    {wide ? null : (
                      <span ref={actionsRef} className="inline-flex">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-haspopup="listbox"
                          aria-expanded={actionsOpen}
                          aria-controls={listId}
                          onClick={() => {
                            setMenuOpen(false);
                            setActionsOpen((current) => !current);
                            setHighlight(0);
                            editorRef.current?.focus();
                          }}
                        >
                          <Slash />
                          Actions
                        </Button>
                      </span>
                    )}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Attach a file"
                      onClick={() => fileRef.current?.click()}
                    >
                      <Paperclip />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={recording ? "Stop voice note" : "Record a voice note"}
                      aria-pressed={recording}
                      data-pressed={recording ? "" : undefined}
                      className={recording ? "text-red-400" : undefined}
                      onClick={() => {
                        void toggleRecording();
                      }}
                    >
                      {recording ? <Square className="animate-pulse" /> : <Mic />}
                    </Button>
                    {options.length === 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="max-w-44"
                        onClick={() => onOpenSettings?.()}
                      >
                        <KeyRound />
                        <span className="truncate">Add a model key</span>
                      </Button>
                    ) : (
                      <Menu
                        open={menuOpen}
                        onOpenChange={(next) => {
                          setMenuOpen(next);
                          if (next) setActionsOpen(false);
                        }}
                      >
                        <MenuTrigger
                          render={
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="max-w-44"
                            />
                          }
                        >
                          <span className="truncate">{model ?? "Select model"}</span>
                          <ChevronDown />
                        </MenuTrigger>
                        <MenuPopup
                          side="top"
                          align="start"
                          className="rounded-2xl border-white/10 bg-[#1a1a1a] text-neutral-100 shadow-raised ring-1 ring-white/10 before:hidden"
                        >
                          <MenuRadioGroup
                            value={model ?? undefined}
                            onValueChange={(value) => {
                              pickModel(value);
                              editorRef.current?.focus();
                            }}
                          >
                            {options.map((item) => {
                              const isUnsupported = item.endsWith("(Anthropic)");
                              return (
                                <MenuRadioItem
                                  key={item}
                                  value={item}
                                  disabled={isUnsupported}
                                  closeOnClick={!isUnsupported}
                                >
                                  <span>{item}</span>
                                  {isUnsupported ? (
                                    <span className="ml-1 text-xs text-neutral-500">
                                      (unsupported)
                                    </span>
                                  ) : null}
                                </MenuRadioItem>
                              );
                            })}
                          </MenuRadioGroup>
                        </MenuPopup>
                      </Menu>
                    )}
                  </div>
                  <span
                    title={
                      options.length === 0
                        ? "Add a model key in Settings to send"
                        : undefined
                    }
                    className="inline-flex shrink-0"
                  >
                    <Button
                      type="submit"
                      size="icon-sm"
                      className="rounded-full"
                      aria-label="Send"
                      disabled={(!draft.trim() && files.length === 0) || options.length === 0}
                    >
                      <ArrowUp />
                    </Button>
                  </span>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
      {actionsBox
        ? createPortal(
            <AnimatePresence>
              {actionsOpen && actions.length > 0 ? (
                <motion.ul
                  key="actions"
                  id={listId}
                  role="listbox"
                  aria-label="Actions"
                  data-chair-menu=""
                  initial={reduce ? false : { opacity: 0, y: 6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduce ? undefined : { opacity: 0, y: 4, scale: 0.98 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  style={{ position: "fixed", left: actionsBox.left, bottom: actionsBox.bottom }}
                  className="z-50 w-72 origin-bottom-left rounded-2xl bg-[#1a1a1a] p-1 shadow-raised ring-1 ring-white/10"
                >
                  {actions.map((action, index) => (
                    <li key={action.key}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === Math.min(highlight, actions.length - 1)}
                        className={cn(
                          "flex w-full items-baseline gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/10",
                          index === Math.min(highlight, actions.length - 1) && "bg-white/8",
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => take(action)}
                      >
                        <span className="text-sm text-neutral-100">{action.key}</span>
                        <span className="truncate text-xs text-neutral-500">{action.hint}</span>
                      </button>
                    </li>
                  ))}
                </motion.ul>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  );
}
