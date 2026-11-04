/**
 * The plan's Board tab: quiet reference cards (a thumbnail with one title
 * line and one meta line) that edit inline on click. Drop an image or paste
 * a link to add a card. The collapsed task list below the tabs shows the
 * work this plan runs from.
 */
import { useRef, useState } from "react";
import { ChevronDown, ImagePlus, Link2, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DitherArt } from "@/components/dither-art";
import { Empty, EmptyArt } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import { ditherMaskStyle } from "@/lib/dither";
import { cn } from "@/lib/utils";
import type { BackTask, BoardItem, BoardKind } from "./plan-api";

const KINDS: BoardKind[] = ["style", "campaign", "reference", "link"];

type PlanBoardProps = {
  items: BoardItem[];
  digests: Record<string, { mood: string }>;
  digesting: string | null;
  onChange: (items: BoardItem[]) => void;
  onDigest: (itemId: string) => void;
  onFiles: (files: File[]) => void;
};

function newItem(title: string, patch: Partial<BoardItem>): BoardItem {
  return {
    id: `board-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    kind: "reference",
    title,
    images: [],
    notes: "",
    tags: [],
    ...patch,
  };
}

/** The link's host for display, or the raw value when it is not a URL. Null without a URL. */
function boardHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A pasted link is born titled by its host; the person can rename it after. */
function newLinkItem(url: string): BoardItem {
  return newItem(boardHost(url) ?? "Link", { kind: "link", url });
}

/**
 * Text that reads as content and swaps for an input on click. Type lives on
 * the inner span (a plain element), never on the Button, so the app's type
 * scale always wins over the component default.
 */
function InlineEdit({
  value,
  displayValue,
  placeholder,
  ariaLabel,
  className,
  textClassName,
  placeholderClassName,
  onSave,
}: {
  value: string;
  displayValue?: string;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  textClassName?: string;
  placeholderClassName?: string;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!editing) {
    const shown = displayValue ?? value;
    return (
      <Button
        type="button"
        variant="ghost"
        aria-label={ariaLabel}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={cn(
          "h-auto min-w-0 justify-start p-0 text-left font-normal hover:bg-transparent data-pressed:bg-transparent sm:h-auto",
          className,
        )}
      >
        {shown ? (
          <span className={cn("min-w-0", textClassName)}>{shown}</span>
        ) : (
          <span className={placeholderClassName}>{placeholder}</span>
        )}
      </Button>
    );
  }
  const commit = () => {
    onSave(draft);
    setEditing(false);
  };
  return (
    <Input
      size="sm"
      autoFocus
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="h-7 border-transparent bg-transparent px-0 text-meta dark:bg-transparent sm:text-meta"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setEditing(false);
        }
      }}
    />
  );
}

export function PlanBoard({ items, digests, digesting, onChange, onDigest, onFiles }: PlanBoardProps) {
  const [url, setUrl] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();

  const setItem = (id: string, patch: Partial<BoardItem>) => {
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const addUrl = () => {
    const value = url.trim();
    if (!value) return;
    const looksImage = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(value) || value.startsWith("data:image/");
    onChange([...items, looksImage ? newItem("Image", { images: [value] }) : newLinkItem(value)]);
    setUrl("");
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      onFiles(files);
      return;
    }
    const text = event.clipboardData?.getData("text") ?? "";
    const match = /(https?:\/\/[^\s)]+)/.exec(text);
    if (match && text.trim() === match[1]) {
      event.preventDefault();
      const value = match[1];
      const looksImage = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(value);
      onChange([...items, looksImage ? newItem("Image", { images: [value] }) : newLinkItem(value)]);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-col gap-3"
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
        if (files.length > 0) onFiles(files);
      }}
      onPaste={onPaste}
    >
      {items.length === 0 ? (
        <Empty className={cn("gap-4 rounded-card py-6 md:py-6", dragOver ? "bg-white/10" : "bg-muted")}>
          <EmptyArt>
            <DitherArt seed={9} />
          </EmptyArt>
          <p className="text-meta text-muted-foreground">
            No references yet. Drop an image, paste a link, or add one below.
          </p>
        </Empty>
      ) : (
        <ul className="flex min-h-0 flex-col gap-4">
          {items.map((item, index) => {
            const cover = item.images[0];
            const digest = digests[item.id];
            const host = boardHost(item.url);
            // A link keeps its default title ("Link", "Link 2") until the
            // person names it; the card shows the host until then. Editing
            // still edits the stored title.
            const title =
              item.kind === "link" && (item.title === "" || /^Link( \d+)?$/.test(item.title))
                ? (host ?? item.title)
                : item.title;
            const name = title || "board item";
            return (
              <motion.li
                key={item.id}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.18,
                  ease: [0.22, 1, 0.36, 1],
                  delay: Math.min(index * 0.04, 0.24),
                }}
                className="group relative flex min-w-0 flex-row overflow-hidden rounded-card bg-surface-raised"
              >
                {cover ? (
                  <span className="relative block w-20 shrink-0 self-stretch overflow-hidden">
                    <img
                      src={cover}
                      alt={item.title || "Board image"}
                      className="absolute inset-0 h-full w-full object-cover"
                      loading="lazy"
                    />
                  </span>
                ) : item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${host ?? "link"}`}
                    className="relative flex w-20 shrink-0 flex-col items-center justify-center gap-1 self-stretch overflow-hidden px-1 py-2"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 bg-white/[0.06]"
                      style={ditherMaskStyle(0.35)}
                    />
                    <Link2 className="relative size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </a>
                ) : (
                  <span
                    aria-hidden="true"
                    className="block w-20 shrink-0 self-stretch bg-white/[0.06]"
                    style={ditherMaskStyle(0.35)}
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 p-3">
                  <InlineEdit
                    value={item.title}
                    displayValue={title}
                    placeholder="Title"
                    ariaLabel="Board item title"
                    textClassName="flex-1 truncate text-title font-medium text-neutral-100"
                    placeholderClassName="text-meta text-neutral-500"
                    onSave={(value) => setItem(item.id, { title: value })}
                  />
                  <span className="flex min-w-0 items-baseline gap-1 text-meta text-muted-foreground">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Kind for ${name}: ${item.kind}. Change it.`}
                            className="h-auto shrink-0 p-0 font-normal text-muted-foreground hover:bg-transparent hover:text-neutral-100 data-pressed:bg-transparent sm:h-auto"
                          >
                            <span className="text-meta">{item.kind}</span>
                          </Button>
                        }
                      />
                      <MenuPopup align="start">
                        <MenuRadioGroup value={item.kind} onValueChange={(value) => setItem(item.id, { kind: value as BoardKind })}>
                          {KINDS.map((kind) => (
                            <MenuRadioItem key={kind} value={kind} closeOnClick>
                              {kind}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuPopup>
                    </Menu>
                    {item.tags.length > 0 || item.notes || digest || digesting === item.id ? (
                      <span aria-hidden="true" className="shrink-0">·</span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {item.tags.length > 0 ? (
                        <InlineEdit
                          value={item.tags.join(", ")}
                          displayValue={item.tags.join(" · ")}
                          placeholder="Tags"
                          ariaLabel={`Tags for ${name}`}
                          className="inline"
                          textClassName="text-meta text-muted-foreground"
                          placeholderClassName="text-meta text-neutral-500"
                          onSave={(value) =>
                            setItem(item.id, {
                              tags: value.split(",").map((tag) => tag.trim()).filter(Boolean),
                            })
                          }
                        />
                      ) : null}
                      {item.tags.length > 0 && (item.notes || digest || digesting === item.id) ? (
                        <span aria-hidden="true"> · </span>
                      ) : null}
                      {item.notes ? (
                        <InlineEdit
                          value={item.notes}
                          placeholder="Notes"
                          ariaLabel={`Notes for ${name}`}
                          className="inline"
                          textClassName="text-meta text-muted-foreground"
                          placeholderClassName="text-meta text-neutral-500"
                          onSave={(value) => setItem(item.id, { notes: value })}
                        />
                      ) : null}
                      {item.notes && (digest || digesting === item.id) ? (
                        <span aria-hidden="true"> · </span>
                      ) : null}
                      {digesting === item.id ? (
                        <span className="text-meta text-muted-foreground">Reading…</span>
                      ) : digest ? (
                        <span className="text-meta text-muted-foreground">{digest.mood}</span>
                      ) : null}
                    </span>
                  </span>
                </div>
                <span className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  {item.images.length > 0 && !digest && digesting !== item.id ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={digesting !== null}
                      onClick={() => onDigest(item.id)}
                      className="h-7 bg-black/50 px-2 text-neutral-100 hover:bg-black/70 hover:text-neutral-100"
                    >
                      <span className="text-meta">Digest</span>
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}
                    className="bg-black/50 text-neutral-100 hover:bg-black/70 hover:text-neutral-100"
                  >
                    <X />
                  </Button>
                </span>
              </motion.li>
            );
          })}
        </ul>
      )}
      <div className="flex shrink-0 items-center gap-2">
        <Input
          size="sm"
          value={url}
          placeholder="Paste an image or link URL"
          aria-label="Image or link URL"
          className="min-w-0 flex-1"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addUrl();
          }}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Add a link card"
          disabled={!url.trim()}
          onClick={addUrl}
        >
          <Link2 />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Add an image card"
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus />
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

type AgentViewProps = {
  tasks: BackTask[];
  stale: boolean;
  busy: boolean;
  saveState: string;
  notice: string | null;
  onGenerate: () => void;
};

export function AgentView({ tasks, stale, busy, saveState, notice, onGenerate }: AgentViewProps) {
  return (
    <details className="group shrink-0 rounded-card bg-muted px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-body text-neutral-100 [&::-webkit-details-marker]:hidden">
        <ChevronDown
          className="size-3.5 shrink-0 text-neutral-500 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
        {tasks.length === 0 ? "No tasks yet" : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
        {stale ? (
          <Badge className="border-transparent bg-amber-400/15 text-amber-200">Stale</Badge>
        ) : null}
        {saveState === "saving" || saveState === "error" ? (
          <span className="ml-auto text-meta text-muted-foreground">
            {saveState === "saving" ? "Saving…" : "Save failed"}
          </span>
        ) : null}
      </summary>
      <div className="flex flex-col gap-2 pt-2">
        {notice ? <p className="text-meta text-red-400">{notice}</p> : null}
        {tasks.length === 0 ? (
          <p className="text-meta leading-5 text-muted-foreground">
            No tasks yet — build them from this plan.
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {tasks.map((task, index) => (
              <li key={task.id} className="text-body leading-6 text-neutral-100">
                <span className="text-neutral-500">{index + 1}. </span>
                {task.title}
                {task.detail ? <span className="text-muted-foreground"> — {task.detail}</span> : null}
              </li>
            ))}
          </ol>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onGenerate}
          >
            {busy ? "Building…" : tasks.length === 0 ? "Build tasks" : "Rebuild"}
          </Button>
        </div>
      </div>
    </details>
  );
}
