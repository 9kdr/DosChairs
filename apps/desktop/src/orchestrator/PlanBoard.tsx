/**
 * The plan's Board tab: a list of style and campaign references that read as
 * content (a big image with a title) and edit inline on click. Drop an image
 * or paste a link to add a card. The collapsed Agent view below the tabs
 * lists the back-plan tasks with a stale badge.
 */
import { useRef, useState } from "react";
import { ImagePlus, Link2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
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

/** Text that reads as content and swaps for an input on click. */
function InlineEdit({
  value,
  displayValue,
  placeholder,
  ariaLabel,
  className,
  placeholderClassName,
  onSave,
}: {
  value: string;
  displayValue?: string;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  placeholderClassName?: string;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!editing) {
    const shown = displayValue ?? value;
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={cn("min-w-0 cursor-text text-left", className)}
      >
        {shown || <span className={placeholderClassName}>{placeholder}</span>}
      </button>
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
      className="h-7 border-transparent bg-transparent px-0"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setEditing(false);
      }}
    />
  );
}

export function PlanBoard({ items, digests, digesting, onChange, onDigest, onFiles }: PlanBoardProps) {
  const [url, setUrl] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const setItem = (id: string, patch: Partial<BoardItem>) => {
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const addUrl = () => {
    const value = url.trim();
    if (!value) return;
    const looksImage = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(value) || value.startsWith("data:image/");
    onChange([
      ...items,
      newItem(looksImage ? "Image" : "Link", looksImage ? { images: [value] } : { kind: "link", url: value }),
    ]);
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
      onChange([
        ...items,
        newItem(looksImage ? "Image" : "Link", looksImage ? { images: [value] } : { kind: "link", url: value }),
      ]);
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
        <p
          className={
            "rounded-3xl p-5 text-sm leading-6 text-neutral-400 " +
            (dragOver ? "bg-white/10" : "bg-white/[0.04]")
          }
        >
          No references yet. Drop an image, paste a link, or add one below.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-5">
          {items.map((item) => {
            const cover = item.images[0];
            const digest = digests[item.id];
            const name = item.title || "board item";
            return (
              <li key={item.id} className="flex min-w-0 flex-col gap-1.5">
                {cover ? (
                  <img
                    src={cover}
                    alt={item.title || "Board image"}
                    className="aspect-video w-full rounded-2xl object-cover"
                    loading="lazy"
                  />
                ) : item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate rounded-2xl bg-white/[0.04] p-3 text-[13px] text-neutral-300 underline decoration-neutral-600 underline-offset-4"
                  >
                    {item.url}
                  </a>
                ) : null}
                <div className="flex items-center gap-2">
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button type="button" size="sm" variant="ghost" className="h-6 rounded-full px-2 py-0">
                          <Badge variant="outline" className="border-white/10 text-neutral-300">{item.kind}</Badge>
                        </Button>
                      }
                    />
                    <MenuPopup align="start" className="min-w-32 rounded-2xl border-0 bg-[#1a1a1a] text-neutral-100 shadow-raised ring-1 ring-white/10">
                      <MenuRadioGroup value={item.kind} onValueChange={(value) => setItem(item.id, { kind: value as BoardKind })}>
                        {KINDS.map((kind) => (
                          <MenuRadioItem key={kind} value={kind} closeOnClick className="min-h-0 rounded-xl px-2.5 py-1.5 text-sm">
                            {kind}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuPopup>
                  </Menu>
                  <span className="flex-1" aria-hidden="true" />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    className="shrink-0 rounded-full"
                    onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}
                  >
                    <X />
                  </Button>
                </div>
                <InlineEdit
                  value={item.title}
                  placeholder="Title"
                  ariaLabel="Board item title"
                  className="text-[15px] font-medium leading-6 text-neutral-100"
                  placeholderClassName="text-neutral-500"
                  onSave={(value) => setItem(item.id, { title: value })}
                />
                <InlineEdit
                  value={item.tags.join(", ")}
                  displayValue={item.tags.join(" · ")}
                  placeholder="Tags, comma separated"
                  ariaLabel={`Tags for ${name}`}
                  className="text-[13px] leading-5 text-neutral-400"
                  placeholderClassName="text-neutral-600"
                  onSave={(value) =>
                    setItem(item.id, {
                      tags: value.split(",").map((tag) => tag.trim()).filter(Boolean),
                    })
                  }
                />
                <InlineEdit
                  value={item.notes}
                  placeholder="Notes"
                  ariaLabel={`Notes for ${name}`}
                  className="text-[13px] leading-5 text-neutral-400"
                  placeholderClassName="text-neutral-600"
                  onSave={(value) => setItem(item.id, { notes: value })}
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-[13px] text-neutral-500">
                    {digesting === item.id ? "Reading the image…" : (digest?.mood ?? (item.images.length > 0 ? "No digest yet." : ""))}
                  </p>
                  {item.images.length > 0 && !digest ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 rounded-full px-2 text-[13px]"
                      disabled={digesting !== null}
                      onClick={() => onDigest(item.id)}
                    >
                      Digest
                    </Button>
                  ) : null}
                </div>
              </li>
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
          className="h-8 min-w-0 flex-1 rounded-full border-white/10 bg-transparent text-[13px]"
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
          className="shrink-0 rounded-full"
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
          className="shrink-0 rounded-full"
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
    <details className="shrink-0 rounded-3xl bg-white/[0.04] px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-neutral-300 [&::-webkit-details-marker]:hidden">
        <Plus className="size-3.5 text-neutral-500" aria-hidden="true" />
        Agent view
        {stale ? (
          <Badge className="border-transparent bg-amber-400/15 text-amber-200">Stale</Badge>
        ) : null}
        <span className="ml-auto text-[13px] text-neutral-500">
          {tasks.length === 0 ? "No back plan" : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
          {saveState === "saving" ? " · Saving…" : saveState === "error" ? " · Save failed" : ""}
        </span>
      </summary>
      <div className="flex flex-col gap-2 pt-2">
        {notice ? <p className="text-[13px] text-red-400">{notice}</p> : null}
        {tasks.length === 0 ? (
          <p className="text-[13px] leading-5 text-neutral-500">
            Generate the back plan and the agents get ordered tasks from this front.
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {tasks.map((task, index) => (
              <li key={task.id} className="text-sm leading-6 text-neutral-300">
                <span className="text-neutral-500">{index + 1}. </span>
                {task.title}
                {task.detail ? <span className="text-neutral-500"> — {task.detail}</span> : null}
              </li>
            ))}
          </ol>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            disabled={busy}
            onClick={onGenerate}
          >
            {busy ? "Generating…" : tasks.length === 0 ? "Generate back plan" : "Regenerate"}
          </Button>
        </div>
      </div>
    </details>
  );
}
