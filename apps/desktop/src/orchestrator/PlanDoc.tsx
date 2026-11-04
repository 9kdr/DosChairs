import {
  Bold,
  ChevronDown,
  Ellipsis,
  FoldVertical,
  Italic,
  List,
  ListOrdered,
  MessageSquare,
  PenLine,
  Plus,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
  Unlink,
  Link2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { parsePlanMarkdown, usePlan, type BoardItem } from "./plan-api";
import { PlanBeats } from "./PlanBeats";
import { AgentView, PlanBoard } from "./PlanBoard";
import { skeletonGroupsForText, splitMarkdownBlocks } from "./planSkeleton";

type PlanMode = "edit" | "talk";

type Line = {
  id: string;
  from: "you" | "expert";
  text: string;
};

type DocTab = {
  id: string;
  label: string;
};

const INITIAL_TABS: DocTab[] = [
  { id: "brief", label: "Brief" },
  { id: "b-roll", label: "B-roll shelf" },
  { id: "captions", label: "Caption pass" },
];

const INITIAL_TEXT: Record<string, string> = {
  brief:
    "One speaker, one room, cut so the argument lands before the viewer looks away. The story opens on a line you can repeat, spends the middle earning it, and ends on a pay-off that does not need a recap.\n\nLeave a rough cut Resolve can still grade. Keep the face on the A-roll, park extra shots on the B-roll shelf, and hold the words for the caption pass.",
  "b-roll":
    "Extra angles, cutaways, and a little room tone sit here until the rough cut asks for them. Nothing on this shelf is on the timeline yet. The face stays on the A-roll.",
  captions:
    "Lines for the trailer, timed to the hook and the pay-off. This pass only places words. The source audio stays as it was shot.",
};

const OPENING_LINE: Line = {
  id: "expert-1",
  from: "expert",
  text: "Hold the face through the question. The turn is the suspense.",
};

type PlanDocProps = {
  open: boolean;
  mode: PlanMode;
  onOpen: (mode: PlanMode) => void;
  onClose: () => void;
  notice?: string | null;
  className?: string;
  projectId?: string | null;
};

type PlanSection = "script" | "beats" | "board";

function PlanNotice({ loading, error }: { loading: boolean; error: string | null }) {
  return (
    <p className="rounded-card bg-muted p-4 text-body leading-6 text-muted-foreground">
      {loading ? "Loading the plan…" : (error ?? "The plan isn't available.")}
    </p>
  );
}

function wrapSelection(value: string, start: number, end: number, marker: string) {
  const selected = value.slice(start, end) || "text";
  const next = `${value.slice(0, start)}${marker}${selected}${marker}${value.slice(end)}`;
  const at = start + marker.length;
  return { next, caret: [at, at + selected.length] as const };
}

function wrappedRange(value: string, start: number, end: number, marker: string): boolean {
  const len = marker.length;
  if (start < len || end + len > value.length) return false;
  if (value.slice(start - len, start) !== marker) return false;
  if (value.slice(end, end + len) !== marker) return false;
  // A marker that is itself part of a longer run belongs to the outer
  // pair, not to this one: never split *** or ~~~ in half.
  const edge = marker[0] ?? "";
  const before = start - len - 1 >= 0 ? value[start - len - 1] : "";
  const after = end + len < value.length ? value[end + len] : "";
  return before !== edge && after !== edge;
}

/** Which inline marks cover the caret (or wrap the selection). */
function inlineMarksAt(
  draft: string,
  start: number,
  end: number,
): { bold: boolean; italic: boolean; strike: boolean } {
  const check = (marker: string, pattern: RegExp): boolean => {
    if (start < end) {
      // Selection between the markers (***bold*** selected as "bold").
      if (wrappedRange(draft, start, end, marker)) return true;
      // Selection including the markers themselves.
      const len = marker.length;
      const edge = marker[0] ?? "";
      if (draft.slice(start, start + len) === marker && draft.slice(end - len, end) === marker) {
        const before = start - 1 >= 0 ? draft[start - 1] : "";
        const after = end < draft.length ? draft[end] : "";
        if (before !== edge && after !== edge) return true;
      }
    }
    const caret = start;
    const lineStart = draft.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    let lineEnd = draft.indexOf("\n", caret);
    if (lineEnd < 0) lineEnd = draft.length;
    const line = draft.slice(lineStart, lineEnd);
    const at = caret - lineStart;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      if (match[0].length === 0) break;
      const inner = match[1] ?? "";
      const innerStart = (match.index ?? 0) + match[0].indexOf(inner);
      // Typing at either edge of the span stays inside the formatting (or
      // creates an empty one), so the indicator stays lit there too.
      if (at >= innerStart && at <= innerStart + inner.length) return true;
    }
    return false;
  };
  return {
    bold: check("**", /(?<!\*)\*\*(?!\*)([\s\S]*?)(?<!\*)\*\*(?!\*)/g),
    italic: check("*", /(?<!\*)\*(?!\*)([^*\n]*?)(?<!\*)\*(?!\*)/g),
    strike: check("~~", /(?<!~)~~(?!~)([\s\S]*?)(?<!~)~~(?!~)/g),
  };
}

/** Toggle inline marks: already-marked text unwraps instead of doubling.
 * Selections are trimmed first, so catching a trailing space (or the
 * markers themselves, e.g. via triple-click) still toggles instead of
 * stacking another pair.
 */
function toggleWrap(value: string, start: number, end: number, marker: string) {
  const len = marker.length;
  const selected = value.slice(start, end);
  const leading = /^\s*/.exec(selected)?.[0].length ?? 0;
  const trailing = /\s*$/.exec(selected)?.[0].length ?? 0;
  const coreStart = start + leading;
  const coreEnd = Math.max(coreStart, end - trailing);
  const edge = marker[0] ?? "";
  const bounded = (from: number, toExclusive: number) => {
    const before = from - 1 >= 0 ? value[from - 1] : "";
    const after = toExclusive < value.length ? value[toExclusive] : "";
    return before !== edge && after !== edge;
  };
  // Markers hugging the selection from the outside: *|foo|*.
  if (coreStart < coreEnd && wrappedRange(value, coreStart, coreEnd, marker)) {
    const inner = value.slice(coreStart, coreEnd);
    return {
      next: value.slice(0, coreStart - len) + inner + value.slice(coreEnd + len),
      caret: [coreStart - len, coreStart - len + inner.length] as const,
    };
  }
  // Markers included in the selection itself: |*foo*|.
  if (
    coreStart + len <= coreEnd &&
    value.slice(coreStart, coreStart + len) === marker &&
    value.slice(coreEnd - len, coreEnd) === marker &&
    bounded(coreStart, coreEnd)
  ) {
    const inner = value.slice(coreStart + len, coreEnd - len);
    return {
      next: value.slice(0, coreStart) + inner + value.slice(coreEnd),
      caret: [coreStart, coreStart + inner.length] as const,
    };
  }
  if (coreStart < coreEnd) {
    const inner = value.slice(coreStart, coreEnd);
    const at = coreStart + len;
    return {
      next: `${value.slice(0, coreStart)}${marker}${inner}${marker}${value.slice(coreEnd)}`,
      caret: [at, at + inner.length] as const,
    };
  }
  return wrapSelection(value, start, end, marker);
}

function prefixLines(value: string, start: number, end: number, prefix: (index: number) => string) {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = end < value.length ? value.indexOf("\n", end) : value.length;
  const head = value.slice(0, lineStart);
  const tail = value.slice(lineEnd < 0 ? value.length : lineEnd);
  const body = value.slice(lineStart, lineEnd < 0 ? value.length : lineEnd);
  const lines = body.split("\n");
  const prefixed = lines.map((line, index) => `${prefix(index)}${line}`).join("\n");
  return {
    next: `${head}${prefixed}${tail}`,
    caret: [lineStart, lineStart + prefixed.length] as const,
  };
}

const FORMAT_ACTIONS = [
  { id: "bold", label: "Bold", icon: Bold },
  { id: "italic", label: "Italic", icon: Italic },
  { id: "strike", label: "Strikethrough", icon: Strikethrough },
  { id: "bullet", label: "Bullet list", icon: List },
  { id: "number", label: "Numbered list", icon: ListOrdered },
  { id: "quote", label: "Quote", icon: Quote },
] as const;

/** Least-used formats: they move into the toolbar's ⋯ menu below 400px. */
const OVERFLOW_FORMATS: ReadonlySet<string> = new Set(["strike", "quote"]);

const BLOCK_STYLES = [
  { id: "normal", label: "Normal text" },
  { id: "h1", label: "Heading 1" },
  { id: "h2", label: "Heading 2" },
  { id: "h3", label: "Heading 3" },
] as const;

type BlockStyleId = (typeof BLOCK_STYLES)[number]["id"];

type FormatId = (typeof FORMAT_ACTIONS)[number]["id"];

/**
 * Renders exactly the markdown the toolbar can produce: headings, bold,
 * italic, strikethrough, inline code, bullets, numbered lists, quotes, and
 * paragraphs. React escapes text by construction, so no HTML passes through.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const runs = text.split(/(\*\*.+?\*\*|~~.+?~~|`[^`\n]+?`|\*[^*\n]+?\*)/g);
  return runs.map((run, index) => {
    const key = `${keyPrefix}-${index}`;
    if (run.startsWith("**") && run.endsWith("**") && run.length > 4) {
      return <strong key={key}>{run.slice(2, -2)}</strong>;
    }
    if (run.startsWith("~~") && run.endsWith("~~") && run.length > 4) {
      return (
        <span key={key} className="line-through">
          {run.slice(2, -2)}
        </span>
      );
    }
    if (run.startsWith("`") && run.endsWith("`") && run.length > 2) {
      return (
        <code key={key} className="rounded bg-white/10 px-1 font-mono text-meta">
          {run.slice(1, -1)}
        </code>
      );
    }
    if (run.startsWith("*") && run.endsWith("*") && run.length > 2) {
      return <em key={key}>{run.slice(1, -1)}</em>;
    }
    return <span key={key}>{run}</span>;
  });
}

function MarkdownText({
  text,
  editing,
  draft,
  onDraftChange,
  onOpenBlock,
  onCommitBlock,
  onCancelBlock,
  onBlurBlock,
  onUndoKey,
  onSelectChange,
  onInlineFormat,
  onSplitBlock,
  onJoinBackward,
  onJoinForward,
  onMoveOut,
  editorRef,
}: {
  text: string;
  editing: { start: number; end: number } | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onOpenBlock: (start: number, end: number) => void;
  onCommitBlock: () => void;
  onCancelBlock: () => void;
  onBlurBlock: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
  onUndoKey: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onSelectChange: (start: number, end: number) => void;
  onInlineFormat: (id: "bold" | "italic") => void;
  onSplitBlock: () => void;
  onJoinBackward: () => void;
  onJoinForward: () => void;
  onMoveOut: (direction: -1 | 1) => void;
  editorRef: (el: HTMLTextAreaElement | null) => void;
}) {
  if (!text.trim() && !editing) {
    return (
      <p
        className="cursor-text text-body leading-6 text-neutral-500"
        onClick={() => onOpenBlock(0, 0)}
      >
        Nothing to preview. Click to write.
      </p>
    );
  }
  const blocks: ReactNode[] = [];
  const renderEditor = (editorClassName: string) => (
    <textarea
      ref={(el) => {
        editorRef(el);
        // Size to content, not newline count: a wrapped paragraph must not
        // collapse to one row when editing starts.
        if (el) {
          el.style.height = "auto";
          el.style.height = `${el.scrollHeight}px`;
        }
      }}
      autoFocus
      rows={Math.max(1, Math.min(12, draft.split("\n").length))}
      value={draft}
      aria-label="Edit block"
      onChange={(event) => onDraftChange(event.target.value)}
      onSelect={(event) =>
        onSelectChange(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
      }
      onBlur={onBlurBlock}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const target = event.currentTarget;
        const mod = event.metaKey || event.ctrlKey;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancelBlock();
          return;
        }
        if (mod && !event.altKey && event.key.toLowerCase() === "b") {
          event.preventDefault();
          onInlineFormat("bold");
          return;
        }
        if (mod && !event.altKey && event.key.toLowerCase() === "i") {
          event.preventDefault();
          onInlineFormat("italic");
          return;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onCommitBlock();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onSplitBlock();
          return;
        }
        if (
          event.key === "Backspace" &&
          target.selectionStart === 0 &&
          target.selectionEnd === 0
        ) {
          event.preventDefault();
          onJoinBackward();
          return;
        }
        if (
          event.key === "Delete" &&
          target.selectionStart === target.value.length &&
          target.selectionEnd === target.value.length
        ) {
          event.preventDefault();
          onJoinForward();
          return;
        }
        if (event.key === "ArrowUp" && target.selectionStart === 0 && target.selectionEnd === 0) {
          event.preventDefault();
          onMoveOut(-1);
          return;
        }
        if (
          event.key === "ArrowDown" &&
          target.selectionStart === target.value.length &&
          target.selectionEnd === target.value.length
        ) {
          event.preventDefault();
          onMoveOut(1);
          return;
        }
        onUndoKey(event);
      }}
      className={`max-h-72 w-full resize-none overflow-y-auto bg-transparent text-neutral-100 outline-none placeholder:text-neutral-500 ${editorClassName}`}
    />
  );
  const wrapBlock = (
    key: string,
    start: number,
    end: number,
    content: ReactNode,
    editorClassName = "text-body leading-6",
  ) => {
    if (editing && editing.start === start && editing.end === end) {
      showEditor(key, editorClassName);
      return;
    }
    blocks.push(
      <div key={key} onClick={() => onOpenBlock(start, end)} className="cursor-text">
        {content}
      </div>,
    );
  };
  const lines = text.split("\n");
  let editorShown = false;
  const showEditor = (key: string, editorClassName = "text-body leading-6") => {
    blocks.push(<div key={key}>{renderEditor(editorClassName)}</div>);
    editorShown = true;
  };
  splitMarkdownBlocks(text).forEach((block, blockIndex) => {
    const key = `block-${blockIndex}`;
    if (editing && !editorShown && block.start >= editing.end) {
      // The open range sits in a gap (or at the end): plant the editor here
      // rather than dropping it because no parsed block matches exactly.
      showEditor(`block-editing`);
    }
    const first = lines[block.start] ?? "";
    const heading = first.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const body = heading[2] ?? "";
      const className =
        level === 1
          ? "text-title font-semibold text-neutral-100"
          : level === 2
            ? "text-title font-medium text-neutral-100"
            : "text-body font-medium text-muted-foreground";
      wrapBlock(
        key,
        block.start,
        block.end,
        <p className={className}>{renderInline(body, key)}</p>,
        className,
      );
      return;
    }
    if (/^\s*>\s?/.test(first)) {
      const quoted = lines
        .slice(block.start, block.end)
        .map((line) => line.replace(/^\s*>\s?/, ""));
      wrapBlock(
        key,
        block.start,
        block.end,
        <blockquote className="border-l-2 border-white/15 pl-3 text-body leading-6 text-neutral-100">
          {quoted.map((quote, quoteIndex) => (
            <span key={quoteIndex}>
              {quoteIndex > 0 ? <br /> : null}
              {renderInline(quote, `${key}-${quoteIndex}`)}
            </span>
          ))}
        </blockquote>,
      );
      return;
    }
    if (/^\s*([-*])\s+/.test(first)) {
      const items = lines
        .slice(block.start, block.end)
        .map((line) => line.replace(/^\s*([-*])\s+/, ""));
      wrapBlock(
        key,
        block.start,
        block.end,
        <ul className="list-disc space-y-1 pl-5 text-body leading-6 text-neutral-100 marker:text-neutral-500">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      return;
    }
    if (/^\s*\d+\.\s+/.test(first)) {
      const items = lines
        .slice(block.start, block.end)
        .map((line) => line.replace(/^\s*\d+\.\s+/, ""));
      wrapBlock(
        key,
        block.start,
        block.end,
        <ol className="list-decimal space-y-1 pl-5 text-body leading-6 text-neutral-100 marker:text-neutral-500">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      return;
    }
    const paragraph = lines.slice(block.start, block.end);
    wrapBlock(
      key,
      block.start,
      block.end,
      <p className="text-body leading-6 text-neutral-100">
        {paragraph.map((line, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex > 0 ? <br /> : null}
            {renderInline(line, `${key}-${lineIndex}`)}
          </span>
        ))}
      </p>,
    );
  });
  if (editing && !editorShown) {
    showEditor("block-editing-trailing");
  }
  return <div className="flex min-h-0 flex-col gap-3">{blocks}</div>;
}

export function PlanDoc({ open, mode, onOpen, onClose, notice, className, projectId }: PlanDocProps) {
  const [section, setSection] = useState<PlanSection>("script");
  const { plan, loading, error, saveState, updateFront, appendBoard, generate, digest } = usePlan(projectId ?? null);
  const [digesting, setDigesting] = useState<string | null>(null);
  const [tabs, setTabs] = useState<DocTab[]>(INITIAL_TABS);
  const [doc, setDoc] = useState<string>("brief");
  const [texts, setTexts] = useState<Record<string, string>>(INITIAL_TEXT);
  const [lines, setLines] = useState<Line[]>([OPENING_LINE]);
  const [draft, setDraft] = useState("");
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Opening the plan grows its card over ~380ms.
  // The edit view opens behind skeleton placeholders for that window, then
  // the real text fades in, so the words never reflow on screen. The
  // skeleton never shows under reduced motion.
  const reduce = useReducedMotion();
  const [skeleton, setSkeleton] = useState(false);
  const showingEdit = open && mode === "edit";
  const wasShowingEdit = useRef(showingEdit);
  useEffect(() => {
    const was = wasShowingEdit.current;
    wasShowingEdit.current = showingEdit;
    if (!showingEdit || was || reduce) {
      if (!showingEdit || reduce) setSkeleton(false);
      return;
    }
    setSkeleton(true);
    const timer = window.setTimeout(() => setSkeleton(false), 450);
    return () => window.clearTimeout(timer);
  }, [showingEdit, reduce]);

  // In preview, a block is edited in place: click it and its source lines
  // swap for a small textarea. Commit on blur or Cmd+Enter, cancel on
  // Escape. Opening an edit pushes history; committing does not.
  const [editingBlock, setEditingBlock] = useState<{ start: number; end: number } | null>(null);
  const [blockDraft, setBlockDraft] = useState("");
  // Mirrors blockDraft synchronously so commit paths that fire from stale
  // closures (blur after a menu pick, rapid open/commit sequences) always
  // write the latest text instead of silently dropping the edit.
  const blockDraftRef = useRef(blockDraft);
  const setDraftLive = (value: string) => {
    blockDraftRef.current = value;
    setBlockDraft(value);
  };
  const [blockSel, setBlockSel] = useState<{ start: number; end: number } | null>(null);
  const planScrollRef = useRef<HTMLDivElement | null>(null);
  // Blur commits the draft, EXCEPT when focus moves into the style menu:
  // opening it legitimately takes focus, and committing would unmount the
  // editor before the click lands. Menu items also preventDefault on
  // mousedown, so picking a style never steals focus in the first place.
  const handleBlockBlur = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Element && next.closest('[data-slot="menu-popup"]')) return;
    commitBlockEditor();
  };
  const marks = editingBlock
    ? inlineMarksAt(blockDraft, blockSel?.start ?? 0, blockSel?.end ?? 0)
    : { bold: false, italic: false, strike: false };

  // The style trigger mirrors the block at the caret: the open block
  // editor's first line in preview, the selected line in source.
  const caretStyle: BlockStyleId = (() => {
    if (!editingBlock) return "normal";
    const source = blockDraft;
    const offset = 0;
    const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
    let lineEnd = source.indexOf("\n", offset);
    if (lineEnd < 0) lineEnd = source.length;
    const match = source.slice(lineStart, lineEnd).match(/^\s*(#{1,3})\s+/);
    if (!match) return "normal";
    return (["h1", "h2", "h3"][(match[1]?.length ?? 1) - 1] ?? "normal") as BlockStyleId;
  })();
  const blockAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeEditor = () =>
    (blockAreaRef.current ?? areaRef.current) as HTMLTextAreaElement | null;

  // Undo covers programmatic edits (toolbar, headings), which the native
  // textarea stack does not see. Typing snapshots coalesce to one per
  // second so holding a key does not flood the stack.
  type TextSnapshot = {
    texts: Record<string, string>;
    doc: string;
    caret: readonly [number, number] | null;
  };
  const undoRef = useRef<TextSnapshot[]>([]);
  const redoRef = useRef<TextSnapshot[]>([]);
  const [histTick, setHistTick] = useState(0);
  const readCaret = (): readonly [number, number] | null => {
    const el = activeEditor();
    if (!el || document.activeElement !== el) return null;
    return [el.selectionStart, el.selectionEnd];
  };
  const pushHistory = (snapshot?: TextSnapshot) => {
    undoRef.current.push(snapshot ?? { texts, doc, caret: readCaret() });
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
    setHistTick((tick) => tick + 1);
  };
  const focusCaret = (caret: readonly [number, number] | null) => {
    requestAnimationFrame(() => {
      const target = activeEditor();
      if (!target) return;
      target.focus();
      if (caret) target.setSelectionRange(caret[0], caret[1]);
    });
  };
  const applyBlockToText = (
    value: string,
    range: { start: number; end: number } | null,
    draft: string,
  ) => {
    if (!range) return value;
    const lines = value.split("\n");
    return [...lines.slice(0, range.start), ...draft.split("\n"), ...lines.slice(range.end)].join("\n");
  };
  const openBlockEditor = (start: number, end: number) => {
    let base = texts[doc] ?? "";
    let resolved = { start, end };
    if (editingBlock) {
      base = applyBlockToText(base, editingBlock, blockDraft);
      const delta = blockDraft.split("\n").length - (editingBlock.end - editingBlock.start);
      if (start >= editingBlock.end) {
        resolved = { start: start + delta, end: end + delta };
      }
    }
    if (base !== (texts[doc] ?? "")) {
      setTexts((current) => ({ ...current, [doc]: base }));
    }
    // Skip the push when nothing changed since the last snapshot, so
    // re-opening a block does not cost an extra undo step.
    const snapshot = { texts: { ...texts, [doc]: base }, doc, caret: null };
    const top = undoRef.current[undoRef.current.length - 1];
    if (!top || JSON.stringify(top.texts) !== JSON.stringify(snapshot.texts)) {
      pushHistory(snapshot);
    }
    setDraftLive(base.split("\n").slice(resolved.start, resolved.end).join("\n"));
    setEditingBlock(resolved);
    requestAnimationFrame(() => {
      const editor = blockAreaRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      setBlockSel({ start: editor.value.length, end: editor.value.length });
    });
  };
  const commitBlockEditor = () => {
    if (!editingBlock) return;
    const next = applyBlockToText(texts[doc] ?? "", editingBlock, blockDraftRef.current);
    if (next !== (texts[doc] ?? "")) {
      setTexts((current) => ({ ...current, [doc]: next }));
    }
    setEditingBlock(null);
  };
  const cancelBlockEditor = () => {
    setEditingBlock(null);
  };
  /**
   * Replace a line range, then open whichever parsed block holds the caret
   * line. The open range always follows the parse, never the reverse, so the
   * editor can never point at lines that render as something else.
   */
  const commitLines = (
    start: number,
    end: number,
    nextLines: string[],
    caretLine: number,
    caretCol: number,
  ) => {
    const base = texts[doc] ?? "";
    const lines = base.split("\n");
    const next = [...lines.slice(0, start), ...nextLines, ...lines.slice(end)].join("\n");
    setTexts((current) => ({ ...current, [doc]: next }));
    const targetLine = start + caretLine;
    const target =
      splitMarkdownBlocks(next).find(
        (block) => block.start <= targetLine && targetLine < block.end,
      ) ?? null;
    if (!target) {
      // Blank gap (e.g. split at the very end): keep editing an empty block
      // there instead of dropping the editor.
      setDraftLive("");
      setEditingBlock({ start: targetLine, end: targetLine });
      setBlockSel({ start: 0, end: 0 });
      requestAnimationFrame(() => {
        const editor = blockAreaRef.current;
        if (!editor) return;
        editor.focus();
        editor.setSelectionRange(0, 0);
      });
      return;
    }
    const draft = next.split("\n").slice(target.start, target.end).join("\n");
    setDraftLive(draft);
    setEditingBlock({ start: target.start, end: target.end });
    const before = draft.split("\n").slice(0, targetLine - target.start + 1);
    const offset =
      before.slice(0, -1).join("\n").length +
      (before.length > 1 ? 1 : 0) +
      caretCol;
    requestAnimationFrame(() => {
      const editor = blockAreaRef.current;
      if (!editor) return;
      editor.focus();
      const at = Math.max(0, Math.min(offset, editor.value.length));
      editor.setSelectionRange(at, at);
      setBlockSel({ start: at, end: at });
    });
  };
  /** Commit silently, then open the neighbouring block, if there is one. */
  const moveOutOfBlock = (direction: -1 | 1) => {
    if (!editingBlock) return;
    const committed = applyBlockToText(texts[doc] ?? "", editingBlock, blockDraft);
    if (committed !== (texts[doc] ?? "")) {
      setTexts((current) => ({ ...current, [doc]: committed }));
    }
    const blocks = splitMarkdownBlocks(committed);
    const at = editingBlock.start;
    const neighbour =
      direction < 0
        ? [...blocks].reverse().find((block) => block.end <= at)
        : blocks.find((block) => block.start >= editingBlock.end);
    // The edited block may have merged with its surroundings; fall back to
    // whatever block now holds the caret line.
    const target =
      neighbour ??
      blocks.find((block) => block.start <= at && at < block.end) ??
      blocks[blocks.length - 1];
    if (!target) {
      setEditingBlock(null);
      return;
    }
    pushHistory({
      texts: { ...texts, [doc]: committed },
      doc,
      caret: null,
    });
    const targetLines = committed.split("\n").slice(target.start, target.end).join("\n");
    setDraftLive(targetLines);
    setEditingBlock({ start: target.start, end: target.end });
    requestAnimationFrame(() => {
      const editor = blockAreaRef.current;
      if (!editor) return;
      editor.focus();
      const at = direction < 0 ? editor.value.length : 0;
      editor.setSelectionRange(at, at);
      setBlockSel({ start: at, end: at });
    });
  };
  /** Enter splits the caret line; list items continue their marker. */
  const splitBlockAtCaret = () => {
    const editor = blockAreaRef.current;
    if (!editor || !editingBlock) return;
    if (!blockDraft.trim()) {
      // Nothing to split: drop the empty block and hand the caret onward.
      pushHistory();
      const committed = applyBlockToText(texts[doc] ?? "", editingBlock, "");
      setTexts((current) => ({ ...current, [doc]: committed }));
      const next = splitMarkdownBlocks(committed).find(
        (block) => block.start >= editingBlock.start,
      );
      if (!next) {
        setEditingBlock(null);
        return;
      }
      setDraftLive(committed.split("\n").slice(next.start, next.end).join("\n"));
      setEditingBlock({ start: next.start, end: next.end });
      requestAnimationFrame(() => {
        const target = blockAreaRef.current;
        if (!target) return;
        target.focus();
        target.setSelectionRange(0, 0);
        setBlockSel({ start: 0, end: 0 });
      });
      return;
    }
    pushHistory();
    const caret = editor.selectionStart ?? blockDraft.length;
    const draftLines = blockDraft.split("\n");
    let caretLine = 0;
    let count = 0;
    for (let index = 0; index < draftLines.length; index += 1) {
      const length = draftLines[index]?.length ?? 0;
      if (count + length >= caret) break;
      count += length + 1;
      caretLine += 1;
    }
    const lineStart = count;
    const line = draftLines[Math.min(caretLine, draftLines.length - 1)] ?? "";
    const beforeText = blockDraft.slice(lineStart, caret);
    const afterText = blockDraft.slice(caret, lineStart + line.length);
    const list = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (list) {
      const indent = list[1] ?? "";
      const marker = list[2] ?? "";
      const itemText = list[3] ?? "";
      if (itemText.trim() === "" && beforeText.trim() === "" && afterText.trim() === "") {
        // Empty item: outdent into a plain paragraph line instead.
        const nextLines = [...draftLines.slice(0, caretLine), "", ...draftLines.slice(caretLine + 1)];
        commitLines(editingBlock.start, editingBlock.end, nextLines, caretLine, 0);
        return;
      }
      const ordered = /^\d+\.$/.test(marker);
      const nextMarker = ordered
        ? `${draftLines.slice(0, caretLine + 1).filter((candidate) => /^\s*\d+\.\s+/.test(candidate)).length + 1}.`
        : marker;
      const headText = `${indent}${marker} ${beforeText}`;
      const tailText = `${indent}${nextMarker} ${afterText}`;
      let nextLines = [
        ...draftLines.slice(0, caretLine),
        headText,
        tailText,
        ...draftLines.slice(caretLine + 1),
      ];
      if (ordered) {
        let seen = 0;
        nextLines = nextLines.map((candidate) => {
          const match = candidate.match(/^(\s*)\d+\.\s+(.*)$/);
          if (!match) return candidate;
          seen += 1;
          return `${match[1]}${seen}. ${match[2]}`;
        });
      }
      commitLines(editingBlock.start, editingBlock.end, nextLines, caretLine + 1, 0);
      return;
    }
    const quote = line.match(/^(\s*>\s?)(.*)$/);
    if (quote) {
      const marker = quote[1] ?? "";
      const quoteLines = draftLines.slice();
      quoteLines[caretLine] = `${marker}${beforeText}`;
      const inserted = `${afterText ? marker : ""}${afterText}`;
      quoteLines.splice(caretLine + 1, 0, inserted);
      commitLines(
        editingBlock.start,
        editingBlock.end,
        quoteLines,
        caretLine + 1,
        afterText ? marker.length : 0,
      );
      return;
    }
    // Plain paragraph or heading line: a blank line separates the halves.
    const heading = line.match(/^(#{1,3}\s+)(.*)$/);
    const headLine = heading ? `${heading[1]}${beforeText}` : beforeText;
    const nextLines = [
      ...draftLines.slice(0, caretLine),
      headLine,
      "",
      afterText,
      ...draftLines.slice(caretLine + 1),
    ];
    commitLines(editingBlock.start, editingBlock.end, nextLines, caretLine + 2, 0);
  };
  /**
   * Open whichever parsed block holds the given line of freshly written
   * text, with the caret at an offset inside that line. Every structural
   * edit funnels through here so the open range always matches the parse.
   */
  const openBlockAtLine = (next: string, line: number, caretCol: number) => {
    setTexts((current) => ({ ...current, [doc]: next }));
    const target =
      splitMarkdownBlocks(next).find((block) => block.start <= line && line < block.end) ??
      null;
    if (!target) {
      setEditingBlock(null);
      return;
    }
    const targetLines = next.split("\n");
    setDraftLive(targetLines.slice(target.start, target.end).join("\n"));
    setEditingBlock({ start: target.start, end: target.end });
    const before = targetLines.slice(target.start, line).join("\n");
    const offset = before.length + (line > target.start ? 1 : 0) + caretCol;
    requestAnimationFrame(() => {
      const editor = blockAreaRef.current;
      if (!editor) return;
      editor.focus();
      const at = Math.max(0, Math.min(offset, editor.value.length));
      editor.setSelectionRange(at, at);
      setBlockSel({ start: at, end: at });
    });
  };
  /**
   * Backspace at the very start joins the previous block; Delete at the
   * very end joins the next one. Only the boundary lines fuse; every other
   * line of both blocks survives untouched.
   */
  const joinBlockAtCaret = (direction: -1 | 1) => {
    const editor = blockAreaRef.current;
    if (!editor || !editingBlock) return;
    const caret = editor.selectionStart ?? 0;
    if (direction < 0 ? caret !== 0 : caret !== blockDraft.length) return;
    const committed = applyBlockToText(texts[doc] ?? "", editingBlock, blockDraft);
    const lines = committed.split("\n");
    const blocks = splitMarkdownBlocks(committed);
    const at = editingBlock.start;
    const current = blocks.find((block) => block.start <= at && at < block.end) ?? {
      start: editingBlock.start,
      end: editingBlock.start + blockDraft.split("\n").length,
    };
    const sibling =
      direction < 0
        ? [...blocks].reverse().find((block) => block.end <= current.start)
        : blocks.find((block) => block.start >= current.end);
    if (!sibling) return;
    pushHistory();
    // Fuse the two boundary lines; blank lines between them vanish.
    const jointStart = direction < 0 ? sibling.start : current.start;
    const jointEnd = direction < 0 ? current.start + 1 : sibling.start + 1;
    const joint =
      direction < 0
        ? `${lines[sibling.end - 1] ?? ""}${lines[current.start] ?? ""}`
        : `${lines[current.end - 1] ?? ""}${lines[sibling.start] ?? ""}`;
    const next = [...lines.slice(0, jointStart), joint, ...lines.slice(jointEnd)];
    const caretCol =
      direction < 0
        ? (lines[sibling.end - 1] ?? "").length
        : (lines[current.end - 1] ?? "").length;
    openBlockAtLine(next.join("\n"), jointStart, caretCol);
  };
  const handleUndoKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return false;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      if (undoRef.current.length === 0) return false;
      event.preventDefault();
      undo();
      return true;
    }
    if (key === "z" && event.shiftKey) {
      if (redoRef.current.length === 0) return false;
      event.preventDefault();
      redo();
      return true;
    }
    if (key === "y") {
      if (redoRef.current.length === 0) return false;
      event.preventDefault();
      redo();
      return true;
    }
    return false;
  };
  const undo = () => {
    const snapshot = undoRef.current.pop();
    if (!snapshot) return;
    const current: TextSnapshot = { texts, doc, caret: readCaret() };
    redoRef.current.push(current);
    setEditingBlock(null);
    setDoc(snapshot.doc);
    setTexts(snapshot.texts);
    setHistTick((tick) => tick + 1);
    focusCaret(snapshot.caret);
  };
  const redo = () => {
    const snapshot = redoRef.current.pop();
    if (!snapshot) return;
    undoRef.current.push({ texts, doc, caret: readCaret() });
    setEditingBlock(null);
    setDoc(snapshot.doc);
    setTexts(snapshot.texts);
    setHistTick((tick) => tick + 1);
    focusCaret(snapshot.caret);
  };
  // histTick re-renders after every stack change so the buttons below
  // read fresh lengths.
  const canUndo = histTick >= 0 && undoRef.current.length > 0;
  const canRedo = histTick >= 0 && redoRef.current.length > 0;

  // Google Docs import: client-side OAuth (GIS) plus the Docs read API. The
  // token lives in memory for the session; the client ID persists locally.
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsPos, setDocsPos] = useState<{ top: number; right: number } | null>(null);
  const docsButtonRef = useRef<HTMLButtonElement | null>(null);
  const placeDocsPopout = () => {
    const rect = docsButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDocsPos({
      top: Math.min(rect.bottom + 8, window.innerHeight - 16),
      right: Math.max(8, window.innerWidth - rect.right),
    });
  };
  useEffect(() => {
    if (!docsOpen) return;
    placeDocsPopout();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDocsOpen(false);
    };
    window.addEventListener("resize", placeDocsPopout);
    window.addEventListener("scroll", placeDocsPopout, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", placeDocsPopout);
      window.removeEventListener("scroll", placeDocsPopout, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [docsOpen]);
  const [clientId, setClientId] = useState(
    () => localStorage.getItem("chair.googleClientId") ?? "",
  );
  const [docsToken, setDocsToken] = useState<string | null>(null);
  const [docsUrl, setDocsUrl] = useState("");
  const [docsBusy, setDocsBusy] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const tokenClientRef = useRef<{ requestAccessToken: (opts?: { prompt?: string }) => void } | null>(null);
  const loadGis = () => {
    if ((window as unknown as { google?: unknown }).google) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Could not load Google sign-in."));
      document.head.appendChild(script);
    });
  };
  const parseDocsId = (input: string): string | null => {
    const trimmed = input.trim();
    const fromUrl = trimmed.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
    if (fromUrl?.[1]) return fromUrl[1];
    if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
    return null;
  };
  const docsBodyText = (node: any): string => {
    const out: string[] = [];
    const walk = (elements: any[] | undefined) => {
      for (const element of elements ?? []) {
        for (const part of element.paragraph?.elements ?? []) {
          if (typeof part.textRun?.content === "string") out.push(part.textRun.content);
        }
        for (const row of element.table?.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) walk(cell.content);
        }
        walk(element.tableOfContents?.content);
      }
    };
    walk(node?.body?.content);
    return out.join("").replace(/\n{3,}/g, "\n\n").trim();
  };
  const connectDocs = async () => {
    const id = clientId.trim();
    if (!id) {
      setDocsError("Paste an OAuth client ID first.");
      return;
    }
    setDocsError(null);
    setDocsBusy(true);
    try {
      localStorage.setItem("chair.googleClientId", id);
      await loadGis();
      const google = (window as unknown as { google: any }).google;
      const callback = (response: { access_token?: string; error?: string }) => {
        setDocsBusy(false);
        if (response.access_token) setDocsToken(response.access_token);
        else setDocsError(response.error ?? "Google sign-in was declined.");
      };
      const client = google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: "https://www.googleapis.com/auth/documents.readonly",
        callback,
      });
      tokenClientRef.current = client;
      client.requestAccessToken({ prompt: docsToken ? "" : "consent" });
    } catch (error) {
      setDocsBusy(false);
      setDocsError(error instanceof Error ? error.message : "Could not reach Google.");
    }
  };
  const importDocs = async () => {
    if (!docsToken) {
      setDocsError("Connect Google first.");
      return;
    }
    const docId = parseDocsId(docsUrl);
    if (!docId) {
      setDocsError("That does not look like a Google Docs link or ID.");
      return;
    }
    setDocsError(null);
    setDocsBusy(true);
    try {
      const response = await fetch(
        `https://docs.googleapis.com/v1/documents/${docId}?fields=title,body`,
        { headers: { Authorization: `Bearer ${docsToken}` } },
      );
      if (response.status === 401 || response.status === 403) {
        setDocsToken(null);
        throw new Error("Google refused access. Connect again and check sharing.");
      }
      if (!response.ok) throw new Error(`Google returned ${response.status}.`);
      const payload = await response.json();
      const body = docsBodyText(payload);
      const title = typeof payload.title === "string" && payload.title ? payload.title : "Imported doc";
      const id = `doc-${docId.slice(0, 8)}-${Date.now()}`;
      setTabs((current) => {
        if (current.some((tab) => tab.id === id)) return current;
        return [...current, { id, label: title.slice(0, 28) }];
      });
      setTexts((current) => ({ ...current, [id]: body }));
      setDoc(id);
      setDocsUrl("");
      setDocsOpen(false);
    } catch (error) {
      setDocsError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setDocsBusy(false);
    }
  };

  const excerpt = (texts.brief ?? "").split("\n")[0] ?? "";
  const activeDocLabel = tabs.find((tab) => tab.id === doc)?.label ?? "Brief";

  // Markdown import fills the plan front (beats and board) and mirrors the
  // script into the Brief doc so the Script tab shows what was pasted.
  const importPlanMarkdown = (text: string) => {
    const front = parsePlanMarkdown(text);
    const base = plan?.front ?? { script_md: "", beats: [], board: [] };
    updateFront({
      script_md: front.script_md || base.script_md,
      beats: front.beats.length > 0 ? front.beats : base.beats,
      board: [...base.board, ...front.board],
    });
    if (front.script_md) {
      setTexts((current) => ({ ...current, brief: front.script_md }));
      setDoc("brief");
    }
  };

  const addBoardFiles = (files: File[]) => {
    if (!plan || files.length === 0) return;
    const reads = files.map(
      (file) =>
        new Promise<BoardItem | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(
              typeof reader.result === "string"
                ? {
                    id: `board-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                    kind: "reference",
                    title: file.name.replace(/\.[^.]+$/, "") || "Image",
                    images: [reader.result],
                    notes: "",
                    tags: [],
                  }
                : null,
            );
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        }),
    );
    void Promise.all(reads).then((items) => {
      appendBoard(items.filter((item): item is BoardItem => item !== null));
    });
  };

  const runDigest = (itemId: string) => {
    setDigesting(itemId);
    digest(itemId).finally(() => setDigesting(null));
  };

  const applyFormat = (id: FormatId) => {
    const el = activeEditor();
    if (!el || !editingBlock) return;
    pushHistory();
    const value = blockDraft;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    let result: { next: string; caret: readonly [number, number] };
    switch (id) {
      case "bold":
        result = toggleWrap(value, start, end, "**");
        break;
      case "italic":
        result = toggleWrap(value, start, end, "*");
        break;
      case "strike":
        result = toggleWrap(value, start, end, "~~");
        break;
      case "bullet":
        result = prefixLines(value, start, end, () => "- ");
        break;
      case "number":
        result = prefixLines(value, start, end, (index) => `${index + 1}. `);
        break;
      case "quote":
        result = prefixLines(value, start, end, () => "> ");
        break;
    }
    setDraftLive(result.next);
    // Commit at once so the rendered result shows immediately.
    commitBlockEditor();
  };

  const applyBlockStyle = (style: BlockStyleId) => {
    const el = activeEditor();
    if (!el || !editingBlock) return;
    pushHistory();
    const value = blockDraft;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const rawEnd = value.indexOf("\n", end);
    const endIndex = rawEnd < 0 ? value.length : rawEnd;
    const marker = style === "normal" ? "" : `${"#".repeat(Number(style.slice(1)))} `;
    const next = value
      .slice(lineStart, endIndex)
      .split("\n")
      .map((line) => `${marker}${line.replace(/^\s*#{1,6}\s*/, "")}`)
      .join("\n");
    setDraftLive(`${value.slice(0, lineStart)}${next}${value.slice(endIndex)}`);
    // Commit at once so the rendered result shows immediately.
    commitBlockEditor();
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setLines((current) => [
      ...current,
      { id: `you-${current.length}`, from: "you", text },
      {
        id: `expert-${current.length}`,
        from: "expert",
        text: "Keep that, and do not let the face leave before the line lands.",
      },
    ]);
    setDraft("");
  };

  const addTab = () => {
    const id = `tab-${Date.now()}`;
    const label = `Tab ${tabs.length + 1}`;
    setTabs((current) => [...current, { id, label }]);
    setTexts((current) => ({ ...current, [id]: "" }));
    setDoc(id);
  };

  const commitRename = () => {
    if (!editingTab) return;
    const label = editingLabel.trim();
    if (label) {
      setTabs((current) =>
        current.map((tab) => (tab.id === editingTab ? { ...tab, label } : tab)),
      );
    }
    setEditingTab(null);
    setEditingLabel("");
  };

  const startRename = (tab: DocTab) => {
    setEditingTab(tab.id);
    setEditingLabel(tab.label);
  };

  // One header for both states: Edit and Discuss are ghost icon buttons
  // with tooltips. Clicking the active mode collapses back to the excerpt.
  // The drawer owns the only close button, so the plan keeps none.
  const toggleMode = (target: PlanMode) => {
    if (open && mode === target) onClose();
    else onOpen(target);
  };
  const modeButton = (target: PlanMode, label: string, Icon: typeof PenLine) => {
    const active = open && mode === target;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={label}
              aria-pressed={active}
              onClick={() => toggleMode(target)}
              className={cn(active && "bg-white/10")}
            >
              <Icon />
            </Button>
          }
        />
        <TooltipPopup sideOffset={8}>{label}</TooltipPopup>
      </Tooltip>
    );
  };
  const planHeader = (
    <div className="flex shrink-0 items-center gap-1">
      <h2 className="text-title font-medium text-neutral-100">Plan</h2>
      <div className="ml-auto flex items-center gap-0.5">
        {modeButton("edit", "Edit plan", PenLine)}
        {modeButton("talk", "Discuss", MessageSquare)}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                ref={docsButtonRef}
                aria-label={docsToken ? "Google Docs connected" : "Connect Google Docs"}
                aria-pressed={docsOpen}
                data-pressed={docsOpen ? "" : undefined}
                onClick={() => {
                  setDocsError(null);
                  setDocsOpen((current) => !current);
                }}
              >
                {docsToken ? <Link2 /> : <Unlink />}
              </Button>
            }
          />
          <TooltipPopup sideOffset={8}>
            {docsToken ? "Google Docs connected" : "Connect Google Docs"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );

  // Expanded modes share one overflow menu: switch to the other mode,
  // collapse back to the excerpt, or import from Google Docs. The drawer
  // tab above already says Plan, so the expanded header needs no title.
  const planOverflow = (other: PlanMode, otherLabel: string, OtherIcon: typeof PenLine) => (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            ref={docsButtonRef}
            aria-label="Plan actions"
          >
            <Ellipsis />
          </Button>
        }
      />
      <MenuPopup align="end">
        <MenuItem onClick={() => onOpen(other)}>
          <OtherIcon />
          {otherLabel}
        </MenuItem>
        <MenuItem onClick={onClose}>
          <FoldVertical />
          Collapse plan
        </MenuItem>
        <MenuItem
          onClick={() => {
            setDocsError(null);
            setDocsOpen(true);
          }}
        >
          {docsToken ? <Link2 /> : <Unlink />}
          {docsToken ? "Google Docs connected" : "Import from Google Docs…"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  const docsPopout = docsOpen ? (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            onClick={() => setDocsOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Connect Google Docs"
            className="fixed z-50 flex w-80 flex-col gap-2 rounded-card border bg-popover p-4 text-neutral-100 shadow-lg/5"
            style={docsPos ? { top: docsPos.top, right: docsPos.right } : undefined}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDocsOpen(false);
              }
            }}
          >
            <p className="text-title font-medium">Google Docs</p>
            <p className="text-meta leading-5 text-muted-foreground">
              {docsToken
                ? "Connected. Paste a Docs link to import it as a plan tab."
                : "Sign in with a Google OAuth client ID (read-only Docs scope), then paste a link to import it as a tab."}
            </p>
            {!docsToken ? (
              <div className="flex gap-2">
                <Input
                  type="text"
                  size="sm"
                  autoFocus
                  value={clientId}
                  placeholder="OAuth client ID"
                  aria-label="Google OAuth client ID"
                  onChange={(event) => setClientId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") connectDocs();
                  }}
                />
                <Button type="button" size="sm" disabled={docsBusy} onClick={connectDocs}>
                  {docsBusy ? "…" : "Connect"}
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  type="text"
                  size="sm"
                  autoFocus
                  value={docsUrl}
                  placeholder="Paste a Google Docs link"
                  aria-label="Google Docs link"
                  onChange={(event) => setDocsUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") importDocs();
                  }}
                />
                <Button type="button" size="sm" disabled={docsBusy} onClick={importDocs}>
                  {docsBusy ? "…" : "Import"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Disconnect Google Docs"
                  onClick={() => {
                    tokenClientRef.current = null;
                    setDocsToken(null);
                  }}
                >
                  Disconnect
                </Button>
              </div>
            )}
            {docsError ? <p className="text-meta text-red-400">{docsError}</p> : null}
          </div>
        </>
      ) : null;

  if (!open) {
    return (
      <article
        aria-label="Plan"
        className={cn("flex shrink-0 flex-col gap-3", className)}
      >
        {planHeader}
        {docsPopout}
        <p className="line-clamp-2 text-body leading-6 text-muted-foreground">{excerpt}</p>
        {notice ? <p className="text-meta text-muted-foreground">{notice}</p> : null}
      </article>
    );
  }

  return (
    <motion.article
      aria-label="Plan"
      className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-hidden", className)}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      {docsPopout}

      {mode === "edit" ? (
        <>
          <div className="flex shrink-0 items-center gap-2">
            <Tabs
              value={section}
              onValueChange={(value) => setSection(value as PlanSection)}
              className="min-w-0 flex-1"
            >
              <TabsList size="sm" aria-label="Plan section">
                <TabsTab value="script">Script</TabsTab>
                <TabsTab value="beats">Beats</TabsTab>
                <TabsTab value="board">Board</TabsTab>
              </TabsList>
            </Tabs>
            {planOverflow("talk", "Discuss", MessageSquare)}
          </div>
          <motion.div
            key={section}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
          >
            {section === "script" ? (
            <>
            <div
              role="toolbar"
              aria-label="Format the plan"
              className="flex shrink-0 flex-wrap items-center gap-0.5 @container [&>button]:shrink-0"
            >
              {editingTab ? (
                <Input
                  autoFocus
                  type="text"
                  size="sm"
                  value={editingLabel}
                  aria-label="Section name"
                  className="h-7 w-32 shrink-0 border-white/15 bg-transparent"
                  onChange={(event) => setEditingLabel(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") {
                      setEditingTab(null);
                      setEditingLabel("");
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Section: ${activeDocLabel}. Change it.`}
                        className="h-7 max-w-36 px-2 @max-[399px]:min-w-0 @max-[399px]:shrink"
                      >
                        <span className="min-w-0 flex-1 truncate text-left text-meta">
                          {activeDocLabel}
                        </span>
                        <ChevronDown className="size-3!" />
                      </Button>
                    }
                  />
                  <MenuPopup align="start" className="min-w-44">
                    <MenuRadioGroup value={doc} onValueChange={(value) => setDoc(value)}>
                      {tabs.map((item) => (
                        <MenuRadioItem key={item.id} value={item.id} closeOnClick>
                          {item.label}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                    <MenuSeparator />
                    <MenuItem closeOnClick onClick={addTab}>
                      <Plus />
                      New section
                    </MenuItem>
                    <MenuItem
                      closeOnClick
                      onClick={() => {
                        const tab = tabs.find((item) => item.id === doc);
                        if (tab) startRename(tab);
                      }}
                    >
                      <PenLine />
                      Rename section
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              )}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Text style: ${caretStyle === "normal" ? "normal text" : caretStyle.toUpperCase()}`}
                      className="h-7 px-2"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                    >
                      <span className="text-meta">{caretStyle === "normal" ? "Normal" : caretStyle.toUpperCase()}</span>
                      <ChevronDown className="size-3!" />
                    </Button>
                  }
                />
                <MenuPopup align="start" className="min-w-36">
                  <MenuRadioGroup
                    value={caretStyle}
                    onValueChange={(value) => {
                      if (value === "normal" || value === "h1" || value === "h2" || value === "h3") {
                        applyBlockStyle(value);
                      }
                    }}
                  >
                    {BLOCK_STYLES.map((style) => (
                      <MenuRadioItem
                        key={style.id}
                        value={style.id}
                        closeOnClick
                        onMouseDown={(event) => {
                          // Keep the editor focused so the selection survives
                          // the click: without this the block commits and closes
                          // before the style lands, and nothing happens.
                          event.preventDefault();
                        }}
                      >
                        {style.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
              {FORMAT_ACTIONS.map((action) => {
                const pressed =
                  (action.id === "bold" && marks.bold) ||
                  (action.id === "italic" && marks.italic) ||
                  (action.id === "strike" && marks.strike);
                return (
                  <Tooltip key={action.id}>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={action.label}
                          className={OVERFLOW_FORMATS.has(action.id) ? "@max-[399px]:hidden" : undefined}
                          aria-pressed={pressed || undefined}
                          data-pressed={pressed ? "" : undefined}
                          onMouseDown={(event) => {
                            // Keep the textarea focused so the selection survives.
                            event.preventDefault();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            applyFormat(action.id);
                          }}
                        >
                          <action.icon />
                        </Button>
                      }
                    />
                    <TooltipPopup sideOffset={8}>{action.label}</TooltipPopup>
                  </Tooltip>
                );
              })}
              <Tooltip key="undo">
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Undo plan edit"
                      disabled={!canUndo}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        undo();
                      }}
                    >
                      <Undo2 />
                    </Button>
                  }
                />
                <TooltipPopup sideOffset={8}>Undo</TooltipPopup>
              </Tooltip>
              <Tooltip key="redo">
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Redo plan edit"
                      disabled={!canRedo}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        redo();
                      }}
                    >
                      <Redo2 />
                    </Button>
                  }
                />
                <TooltipPopup sideOffset={8}>Redo</TooltipPopup>
              </Tooltip>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="More formatting options"
                      className="hidden @max-[399px]:inline-flex"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                    >
                      <Ellipsis />
                    </Button>
                  }
                />
                <MenuPopup align="end" className="ring-1 ring-white/10">
                  {FORMAT_ACTIONS.filter((action) => OVERFLOW_FORMATS.has(action.id)).map((action) => (
                    <MenuItem
                      key={action.id}
                      closeOnClick
                      onMouseDown={(event) => {
                        // Keep the editor focused so the selection survives
                        // the click, like the text-style menu items.
                        event.preventDefault();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        applyFormat(action.id);
                      }}
                    >
                      <action.icon />
                      {action.label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>
            <div
              ref={planScrollRef}
              aria-label={`Preview ${tabs.find((tab) => tab.id === doc)?.label ?? doc}`}
              className={cn(
                "min-h-[20rem] flex-1 overflow-y-auto overscroll-contain",
                skeleton && "relative",
              )}
            >
              <motion.div
                aria-hidden={skeleton || undefined}
                inert={skeleton}
                initial={false}
                animate={{ opacity: skeleton ? 0 : 1 }}
                transition={{ duration: skeleton ? 0 : 0.22, ease: "easeOut" }}
              >
                <MarkdownText
                  text={texts[doc] ?? ""}
                  editing={editingBlock}
                  draft={blockDraft}
                  onDraftChange={setDraftLive}
                  onOpenBlock={openBlockEditor}
                  onCommitBlock={commitBlockEditor}
                  onCancelBlock={cancelBlockEditor}
                  onBlurBlock={handleBlockBlur}
                  onUndoKey={handleUndoKey}
                  onSelectChange={(start, end) => setBlockSel({ start, end })}
                  onInlineFormat={(id) => applyFormat(id)}
                  onSplitBlock={splitBlockAtCaret}
                  onJoinBackward={() => joinBlockAtCaret(-1)}
                  onJoinForward={() => joinBlockAtCaret(1)}
                  onMoveOut={moveOutOfBlock}
                  editorRef={(el) => {
                    blockAreaRef.current = el;
                  }}
                />
              </motion.div>
              {skeleton ? (
                <motion.div
                  aria-hidden="true"
                  className="absolute inset-0 flex flex-col gap-3 overflow-hidden bg-card"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                >
                  {skeletonGroupsForText(texts[doc] ?? "").map((widths, groupIndex) => (
                    <div key={groupIndex} className="flex flex-col gap-2.5">
                      {widths.map((width, barIndex) => (
                        <div
                          key={barIndex}
                          style={{ width }}
                          className="h-3.5 shrink-0 rounded-md bg-white/8"
                        />
                      ))}
                    </div>
                  ))}
                  <motion.div
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 w-full bg-gradient-to-r from-transparent via-white/10 to-transparent" // taste-skill-ignore: skeleton shimmer sweep, the one moving highlight while the plan opens.
                    initial={{ x: "-100%" }}
                    animate={{ x: "100%" }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  />
                </motion.div>
              ) : null}
            </div>
            <SmoothScrollTarget target={planScrollRef} lerp={0.075} />
            </>
            ) : section === "beats" ? (
              plan ? (
                <PlanBeats
                  beats={plan.front.beats}
                  onChange={(beats) => updateFront({ ...plan.front, beats })}
                  onImport={importPlanMarkdown}
                />
              ) : (
                <PlanNotice loading={loading} error={error} />
              )
            ) : plan ? (
              <PlanBoard
                items={plan.front.board}
                digests={Object.fromEntries(
                  Object.entries(plan.back.digests).map(([id, digest]) => [id, { mood: digest.mood }]),
                )}
                digesting={digesting}
                onChange={(board) => updateFront({ ...plan.front, board })}
                onDigest={runDigest}
                onFiles={addBoardFiles}
              />
            ) : (
              <PlanNotice loading={loading} error={error} />
            )}
          </motion.div>
          <AgentView
            tasks={plan?.back.tasks ?? []}
            stale={plan?.back.stale ?? false}
            busy={loading}
            saveState={saveState}
            notice={error}
            onGenerate={generate}
          />
        </>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2">
            <h2 className="min-w-0 flex-1 text-title font-medium text-neutral-100">Discuss</h2>
            {planOverflow("edit", "Edit plan", PenLine)}
          </div>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {lines.map((line) => (
              <li
                key={line.id}
                className={cn(
                  "max-w-[90%] rounded-card px-4 py-2 text-body leading-6",
                  line.from === "you"
                    ? "ml-auto bg-white/10 text-neutral-100"
                    : "bg-black/30 text-neutral-100",
                )}
              >
                {line.text}
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <Input
              type="text"
              size="sm"
              value={draft}
              placeholder="A note for the cut"
              aria-label="Note for the plan"
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={!draft.trim()}>
              Send
            </Button>
          </form>
        </>
      )}
    </motion.article>
  );
}
