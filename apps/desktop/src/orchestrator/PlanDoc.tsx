import {
  Bold,
  ChevronDown,
  Eye,
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
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
};

function wrapSelection(value: string, start: number, end: number, marker: string) {
  const selected = value.slice(start, end) || "text";
  const next = `${value.slice(0, start)}${marker}${selected}${marker}${value.slice(end)}`;
  const at = start + marker.length;
  return { next, caret: [at, at + selected.length] as const };
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
        <code key={key} className="rounded bg-white/10 px-1 font-mono text-[13px]">
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
  onUndoKey,
  editorRef,
}: {
  text: string;
  editing: { start: number; end: number } | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onOpenBlock: (start: number, end: number) => void;
  onCommitBlock: () => void;
  onCancelBlock: () => void;
  onUndoKey: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  editorRef: (el: HTMLTextAreaElement | null) => void;
}) {
  if (!text.trim() && !editing) {
    return (
      <p
        className="cursor-text text-sm leading-6 text-neutral-600"
        onClick={() => onOpenBlock(0, 0)}
      >
        Nothing to preview. Click to write.
      </p>
    );
  }
  const lines = text.split("\n");
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
      onBlur={onCommitBlock}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancelBlock();
          return;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onCommitBlock();
          return;
        }
        if (event.key === "Enter" && !draft.includes("\n")) {
          event.preventDefault();
          onCommitBlock();
          return;
        }
        onUndoKey(event);
      }}
      className={`max-h-72 w-full resize-none overflow-y-auto bg-transparent text-neutral-100 outline-none placeholder:text-neutral-600 ${editorClassName}`}
    />
  );
  const wrapBlock = (
    key: string,
    start: number,
    end: number,
    content: ReactNode,
    editorClassName = "text-sm leading-6",
  ) => {
    if (editing && editing.start === start && editing.end === end) {
      blocks.push(<div key={key}>{renderEditor(editorClassName)}</div>);
      return;
    }
    blocks.push(
      <div key={key} onClick={() => onOpenBlock(start, end)} className="cursor-text">
        {content}
      </div>,
    );
  };
  let index = 0;
  const flushParagraph = (paragraph: string[], key: string, start: number, end: number) => {
    if (paragraph.length === 0) return;
    wrapBlock(
      key,
      start,
      end,
      <p className="text-sm leading-6 text-neutral-100">
        {paragraph.map((line, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex > 0 ? <br /> : null}
            {renderInline(line, `${key}-${lineIndex}`)}
          </span>
        ))}
      </p>,
    );
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const key = `block-${blocks.length}`;
    const start = index;
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const body = heading[2] ?? "";
      const className =
        level === 1
          ? "text-lg font-semibold text-neutral-100"
          : level === 2
            ? "text-base font-semibold text-neutral-100"
            : "text-sm font-semibold text-neutral-100";
      index += 1;
      wrapBlock(
        key,
        start,
        index,
        <p className={className}>{renderInline(body, key)}</p>,
        className,
      );
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      wrapBlock(
        key,
        start,
        index,
        <blockquote className="border-l-2 border-white/15 pl-3 text-sm leading-6 text-neutral-300">
          {quoted.map((quote, quoteIndex) => (
            <span key={quoteIndex}>
              {quoteIndex > 0 ? <br /> : null}
              {renderInline(quote, `${key}-${quoteIndex}`)}
            </span>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*([-*])\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*])\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*([-*])\s+/, ""));
        index += 1;
      }
      wrapBlock(
        key,
        start,
        index,
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-neutral-100 marker:text-neutral-500">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      wrapBlock(
        key,
        start,
        index,
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-neutral-100 marker:text-neutral-500">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^(#{1,3})\s+/.test(lines[index] ?? "") &&
      !/^\s*>\s?/.test(lines[index] ?? "") &&
      !/^\s*([-*])\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    flushParagraph(paragraph, key, start, index);
  }
  return <div className="flex min-h-0 flex-col gap-3">{blocks}</div>;
}

export function PlanDoc({ open, mode, onOpen, onClose, notice, className }: PlanDocProps) {
  const [tabs, setTabs] = useState<DocTab[]>(INITIAL_TABS);
  const [doc, setDoc] = useState<string>("brief");
  const [texts, setTexts] = useState<Record<string, string>>(INITIAL_TEXT);
  const [lines, setLines] = useState<Line[]>([OPENING_LINE]);
  const [draft, setDraft] = useState("");
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [preview, setPreview] = useState(true);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // In preview, a block is edited in place: click it and its source lines
  // swap for a small textarea. Commit on blur or Cmd+Enter, cancel on
  // Escape. Opening an edit pushes history; committing does not.
  const [editingBlock, setEditingBlock] = useState<{ start: number; end: number } | null>(null);
  const [blockDraft, setBlockDraft] = useState("");
  const [caretOffset, setCaretOffset] = useState<number | null>(null);

  // The style trigger mirrors the block at the caret: the open block
  // editor's first line in preview, the selected line in source.
  const caretStyle: BlockStyleId = (() => {
    const source = editingBlock ? blockDraft : (texts[doc] ?? "");
    const offset = editingBlock ? 0 : caretOffset;
    if (offset == null) return "normal";
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
  const lastPushRef = useRef(0);
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
    setBlockDraft(base.split("\n").slice(resolved.start, resolved.end).join("\n"));
    setEditingBlock(resolved);
    requestAnimationFrame(() => {
      const editor = blockAreaRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
  };
  const commitBlockEditor = () => {
    if (!editingBlock) return;
    const next = applyBlockToText(texts[doc] ?? "", editingBlock, blockDraft);
    if (next !== (texts[doc] ?? "")) {
      setTexts((current) => ({ ...current, [doc]: next }));
    }
    setEditingBlock(null);
  };
  const cancelBlockEditor = () => {
    setEditingBlock(null);
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

  const applyFormat = (id: FormatId) => {
    const el = activeEditor();
    if (!el) {
      setPreview(false);
      requestAnimationFrame(() => areaRef.current?.focus());
      return;
    }
    pushHistory();
    const inBlock = editingBlock !== null;
    const value = inBlock ? blockDraft : (texts[doc] ?? "");
    const start = el.selectionStart;
    const end = el.selectionEnd;
    let result: { next: string; caret: readonly [number, number] };
    switch (id) {
      case "bold":
        result = wrapSelection(value, start, end, "**");
        break;
      case "italic":
        result = wrapSelection(value, start, end, "*");
        break;
      case "strike":
        result = wrapSelection(value, start, end, "~~");
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
    if (inBlock) {
      setBlockDraft(result.next);
    } else {
      setTexts((current) => ({ ...current, [doc]: result.next }));
    }
    focusCaret(result.caret);
  };

  const applyBlockStyle = (style: BlockStyleId) => {
    const el = activeEditor();
    if (!el) {
      setPreview(false);
      requestAnimationFrame(() => areaRef.current?.focus());
      return;
    }
    pushHistory();
    const inBlock = editingBlock !== null;
    const value = inBlock ? blockDraft : (texts[doc] ?? "");
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
    const caret = [lineStart, lineStart + next.length] as const;
    const styled = `${value.slice(0, lineStart)}${next}${value.slice(endIndex)}`;
    if (inBlock) {
      setBlockDraft(styled);
    } else {
      setTexts((current) => ({ ...current, [doc]: styled }));
    }
    focusCaret(caret);
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

  if (!open) {
    return (
      <article
        aria-label="Plan"
        className={cn(
          "flex shrink-0 flex-col gap-3 rounded-[28px] bg-[#1a1a1a] p-4 text-neutral-100 shadow-raised ring-1 ring-white/8",
          className,
        )}
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-wide">Plan</h2>
        </div>
        <p className="line-clamp-2 text-sm leading-5 text-neutral-400">{excerpt}</p>
        {notice ? <p className="text-xs text-neutral-300">{notice}</p> : null}
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onOpen("edit")}>
            <PenLine />
            Edit
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpen("talk")}>
            <MessageSquare />
            Talk
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article
      aria-label="Plan"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-[28px] bg-[#1a1a1a] p-4 text-neutral-100 shadow-raised ring-1 ring-white/8",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide">Plan</h2>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="ml-auto"
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
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close the plan"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      {docsOpen ? (
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
            className="fixed z-50 flex w-80 flex-col gap-2 rounded-2xl border-0 bg-[#1a1a1a] p-4 text-neutral-100 shadow-raised ring-1 ring-white/10"
            style={docsPos ? { top: docsPos.top, right: docsPos.right } : undefined}
          >
            <p className="text-sm font-semibold tracking-wide">Google Docs</p>
            <p className="text-xs leading-5 text-neutral-400">
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
            {docsError ? <p className="text-xs text-red-400">{docsError}</p> : null}
          </div>
        </>
      ) : null}

      <Tabs value={mode} onValueChange={(value) => onOpen(value as PlanMode)}>
        <TabsList size="sm" className="grid w-full grid-cols-2 rounded-full bg-white/5 p-1 [&>[data-slot=tab-indicator]]:hidden">
          <TabsTab value="edit" className="rounded-full data-active:bg-white/10">
            Edit
          </TabsTab>
          <TabsTab value="talk" className="rounded-full data-active:bg-white/10">
            Talk
          </TabsTab>
        </TabsList>
      </Tabs>

      {mode === "edit" ? (
        <>
          <Tabs value={doc} onValueChange={(value) => setDoc(value)}>
            <TabsList
              size="sm"
              className="flex w-full items-center gap-1 overflow-x-auto rounded-full bg-white/5 p-1 [&>[data-slot=tab-indicator]]:hidden"
            >
              {tabs.map((item) =>
                editingTab === item.id ? (
                  <Input
                    key={item.id}
                    autoFocus
                    type="text"
                    size="sm"
                    value={editingLabel}
                    aria-label="Tab name"
                    className="h-7 min-w-24 rounded-full border-white/15 bg-transparent"
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
                  <TabsTab
                    key={item.id}
                    value={item.id}
                    className="rounded-full data-active:bg-white/10"
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      startRename(item);
                    }}
                    title="Double-click to rename"
                  >
                    {item.label}
                  </TabsTab>
                ),
              )}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Add a tab"
                className="ml-auto shrink-0 rounded-full"
                onClick={addTab}
              >
                <Plus />
              </Button>
            </TabsList>
          </Tabs>
          <div
            role="toolbar"
            aria-label="Format the plan"
            className="flex shrink-0 items-center gap-0.5"
          >
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Text style: ${caretStyle === "normal" ? "normal text" : caretStyle.toUpperCase()}`}
                    className="h-7 px-2 text-xs"
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                  >
                    <span>{caretStyle === "normal" ? "Normal" : caretStyle.toUpperCase()}</span>
                    <ChevronDown className="size-3!" />
                  </Button>
                }
              />
              <MenuPopup
                align="start"
                className="min-w-36 rounded-2xl border-0 bg-[#1a1a1a] text-neutral-100 shadow-raised ring-1 ring-white/10 before:hidden"
              >
                {BLOCK_STYLES.map((style) => (
                  <MenuItem
                    key={style.id}
                    className="min-h-0 grid-cols-1 gap-0 rounded-xl px-2.5 py-1.5 text-sm data-highlighted:bg-white/8 [&>span:first-child]:hidden [&>span:last-child]:col-start-1 [&>span:last-child]:flex [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                    onClick={() => applyBlockStyle(style.id)}
                  >
                    {style.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
            {FORMAT_ACTIONS.map((action) => (
              <Tooltip key={action.id}>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={action.label}
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
            ))}
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
            <Tooltip key="preview">
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={preview ? "Edit the plan text" : "Preview the plan text"}
                    aria-pressed={preview}
                    data-pressed={preview ? "" : undefined}
                    className="ml-auto"
                    onClick={() => setPreview((current) => !current)}
                  >
                    <Eye />
                  </Button>
                }
              />
              <TooltipPopup sideOffset={8}>
                {preview ? "Edit" : "Preview"}
              </TooltipPopup>
            </Tooltip>
          </div>
          {preview ? (
            <div
              aria-label={`Preview ${tabs.find((tab) => tab.id === doc)?.label ?? doc}`}
              className="min-h-[20rem] flex-1 overflow-y-auto"
            >
              <MarkdownText
                text={texts[doc] ?? ""}
                editing={editingBlock}
                draft={blockDraft}
                onDraftChange={setBlockDraft}
                onOpenBlock={openBlockEditor}
                onCommitBlock={commitBlockEditor}
                onCancelBlock={cancelBlockEditor}
                onUndoKey={handleUndoKey}
                editorRef={(el) => {
                  blockAreaRef.current = el;
                }}
              />
            </div>
          ) : (
            <textarea
              ref={areaRef}
              value={texts[doc] ?? ""}
              aria-label={`Edit ${tabs.find((tab) => tab.id === doc)?.label ?? doc}`}
              placeholder="Write the plan…"
              className="min-h-[20rem] flex-1 resize-none border-0 bg-transparent text-sm leading-6 text-neutral-100 shadow-none outline-none ring-0 placeholder:text-neutral-600 focus-visible:outline-none"
              onChange={(event) => {
                const now = Date.now();
                if (now - lastPushRef.current > 1000) {
                  pushHistory();
                  lastPushRef.current = now;
                }
                setTexts((current) => ({ ...current, [doc]: event.target.value }))
              }}
              onSelect={(event) => {
                setCaretOffset(event.currentTarget.selectionStart);
              }}
              onKeyDown={handleUndoKey}
            />
          )}
        </>
      ) : (
        <>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {lines.map((line) => (
              <li
                key={line.id}
                className={cn(
                  "max-w-[90%] rounded-2xl px-3 py-2 text-sm leading-5",
                  line.from === "you"
                    ? "ml-auto bg-white/10 text-neutral-100"
                    : "bg-black/30 text-neutral-300",
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
    </article>
  );
}
