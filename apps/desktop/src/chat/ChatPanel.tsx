import { useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  PanelLeftIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { ChatConversation } from "@/components/chat/chat-conversation";
import { ChatMessageActionToolbar } from "@/components/chat/chat-message-actions";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatMessageText } from "@/components/chat/chat-message-text";
import { ChatTypingIndicator } from "@/components/chat/chat-typing-indicator";
import { DitherBackdrop, DitherControlStrip } from "@/components/chat/dither-backdrop";
import type { DitherLook } from "@/components/chat/dither-backdrop";
import { useChatScroll } from "@/components/chat/hooks/use-chat-scroll";
import { SmoothScrollTarget } from "@/components/chat/smooth-scroll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerInput,
  ComposerSubmit,
} from "@/components/ui/composer";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { getComposerText, type ComposerValue } from "@/lib/composer-document";
import { cn } from "@/lib/utils";
import {
  activeThread,
  MODELS,
  modelLabel,
  splitBlocks,
  type ChatAction,
  type ChatMessage as ChatMessageModel,
  type ChatState,
  type ModelId,
  type Thread,
} from "./state";

type ChatPanelProps = {
  chat: ChatState;
  dispatch: (action: ChatAction) => void;
  threadsOpen: boolean;
  onOpenThreads: () => void;
};

const SUGGESTIONS = [
  {
    title: "Rough-cut the talking head",
    hint: "Drop the pause before the first line.",
    prompt: "Rough-cut the talking head. Drop the pause before the first line.",
  },
  {
    title: "Add captions",
    hint: "Use the learned caption preset.",
    prompt: "Add captions to the cut using the learned caption preset.",
  },
  {
    title: "Tighten the intro",
    hint: "Reach the hook sooner.",
    prompt: "Tighten the intro. Reach the hook sooner and keep the first line intact.",
  },
] as const;

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function draftValue(text: string): ComposerValue {
  return text ? [{ type: "text", text }] : [];
}

export function ChatPanel({ chat, dispatch, threadsOpen, onOpenThreads }: ChatPanelProps) {
  const thread = activeThread(chat);
  const messages = thread?.messages ?? [];
  const pending = messages.some((message) => message.status === "pending");
  const pendingId = messages.find((message) => message.status === "pending")?.id;
  const composerRef = useRef<HTMLFormElement>(null);
  const [dither, setDither] = useState<DitherLook>({
    matrix: "bayer4",
    cell: 4,
    scene: "wash",
  });
  const scroll = useChatScroll({
    itemCount: messages.length,
    ...(thread ? { layoutKey: thread.id } : {}),
  });

  useEffect(() => {
    if (!pendingId) return;
    const timer = window.setTimeout(() => dispatch({ type: "complete" }), 280);
    return () => window.clearTimeout(timer);
  }, [pendingId, dispatch]);

  const visible = messages.filter((message) => message.status !== "pending");
  const empty = visible.length === 0 && !pending;

  function fillDraft(prompt: string) {
    dispatch({ type: "draft", draft: prompt });
    requestAnimationFrame(() => {
      const input = composerRef.current?.querySelector<HTMLElement>('[data-slot="composer-input"]');
      input?.focus();
      if (input instanceof HTMLTextAreaElement) {
        input.setSelectionRange(prompt.length, prompt.length);
      }
    });
  }

  return (
    <section
      aria-label="Chat"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <DitherBackdrop matrix={dither.matrix} cell={dither.cell} scene={dither.scene} speed={0} />
      {!threadsOpen ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Show threads"
          className="absolute top-3 left-3 z-20 rounded-lg border border-edge bg-surface text-muted-foreground shadow-raised md:hidden"
          onClick={onOpenThreads}
        >
          <PanelLeftIcon />
        </Button>
      ) : null}

      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
          <div className="w-full max-w-[36rem]">
            <div className="flex flex-col items-center text-center">
              <h1 className="text-xl font-medium tracking-[-0.015em] text-foreground">
                What should we cut?
              </h1>
              <p className="mt-2.5 max-w-sm text-sm leading-6 text-subtle">
                Describe the edit. Chair proposes a changeset and waits for your yes.
              </p>
            </div>

            <div className="mt-10 space-y-1">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.title}
                  type="button"
                  className="flex w-full flex-col rounded-lg px-2 py-2 text-left transition-colors duration-[160ms] ease-out hover:bg-surface-quiet"
                  onClick={() => fillDraft(suggestion.prompt)}
                >
                  <span className="truncate text-sm text-foreground/90">{suggestion.title}</span>
                  <span className="truncate text-xs text-subtle">{suggestion.hint}</span>
                </button>
              ))}
            </div>

            {thread ? (
              <div className="mt-9">
                <ChairComposer
                  ref={composerRef}
                  thread={thread}
                  pending={pending}
                  dispatch={dispatch}
                  dither={dither}
                  onDither={setDither}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <SmoothScrollTarget target={scroll.viewportRef} />
          <ChatConversation
            scroll={scroll}
            label="Conversation"
            jumpLabel="Jump to latest"
            contentClassName="px-0 pb-0"
          >
            <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-7 px-6 py-8">
              {visible.map((message, index) => (
                <TranscriptMessage
                  key={message.id}
                  message={message}
                  grouped={visible[index - 1]?.role === message.role}
                  canRetry={index === visible.length - 1 && message.role === "assistant"}
                  dispatch={dispatch}
                />
              ))}
              <ChatTypingIndicator
                label="Thinking"
                visible={pending}
                className="pl-9 [&_[data-slot=chat-typing-indicator]]:text-subtle"
              />
            </div>
          </ChatConversation>
          {thread ? (
            <div className="shrink-0 px-6 pb-4">
              <div className="mx-auto w-full max-w-[44rem]">
                <ChairComposer
                  ref={composerRef}
                  thread={thread}
                  pending={pending}
                  dispatch={dispatch}
                  dither={dither}
                  onDither={setDither}
                />
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

const ChairComposer = ({
  ref,
  thread,
  pending,
  dispatch,
  dither,
  onDither,
}: {
  ref: React.RefObject<HTMLFormElement | null>;
  thread: Thread;
  pending: boolean;
  dispatch: (action: ChatAction) => void;
  dither: DitherLook;
  onDither: (look: DitherLook) => void;
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <Composer
        ref={ref}
        layout="stacked"
        value={draftValue(thread.draft)}
        submitDisabled={pending}
        allowEmpty={thread.attachments.length > 0}
        className="chat-composer"
        onValueChange={(value) => dispatch({ type: "draft", draft: getComposerText(value) })}
        onSubmit={(value) => {
          dispatch({ type: "draft", draft: getComposerText(value).trim() });
          dispatch({ type: "send" });
        }}
      >
        {thread.attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-2.5 pt-2" aria-label="Attachments">
            {thread.attachments.map((file) => (
              <Badge
                key={file.id}
                variant="secondary"
                size="sm"
                render={<button type="button" />}
                className="gap-1.5 rounded-md bg-foreground/[0.05] text-xs text-muted-foreground transition-colors duration-[160ms] ease-out hover:bg-foreground/[0.08]"
                onClick={() => dispatch({ type: "detach", id: file.id })}
              >
                {file.name}
                <span className="text-subtle">{formatSize(file.size)}</span>
                <XIcon className="size-3 opacity-60" />
              </Badge>
            ))}
          </div>
        ) : null}

        <ComposerInput
          aria-label="Message"
          placeholder="Ask Chair for a cut…"
          render={<textarea />}
          className="min-h-20 px-2.5 py-2.5 leading-6"
        />

        <ComposerActions>
          <ComposerActionGroup>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="sr-only"
              aria-label="Attach files"
              onChange={(event) => {
                const files = event.target.files;
                if (files) {
                  for (const file of files) {
                    dispatch({ type: "attach", name: file.name, size: file.size });
                  }
                }
                event.target.value = "";
              }}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label="Attach files"
                    className="rounded-full text-muted-foreground hover:text-foreground"
                    onClick={() => fileRef.current?.click()}
                  />
                }
              >
                <PlusIcon />
              </TooltipTrigger>
              <TooltipPopup>Attach files</TooltipPopup>
            </Tooltip>
            <span
              className="inline-flex h-6 items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 text-xs text-subtle"
              title="Local stand-in · nothing is sent to a model"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-subtle" />
              Local
            </span>
          </ComposerActionGroup>
          <ComposerActionGroup align="end">
            <ModelMenu
              model={thread.model}
              onChange={(model) => dispatch({ type: "model", model })}
            />
            {pending ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Stop generating"
                className="rounded-full border-edge bg-surface-quiet text-foreground/80 shadow-rim hover:bg-surface"
                onClick={() => dispatch({ type: "stop" })}
              >
                <SquareIcon />
              </Button>
            ) : (
              <ComposerSubmit
                render={
                  <Button aria-label="Send message" size="icon-sm" className="rounded-full">
                    <ArrowUpIcon />
                  </Button>
                }
              />
            )}
          </ComposerActionGroup>
        </ComposerActions>
      </Composer>
      <div className="mt-2">
        <DitherControlStrip
          matrix={dither.matrix}
          cell={dither.cell}
          scene={dither.scene}
          onMatrix={(matrix) => onDither({ ...dither, matrix })}
          onCell={(cell) => onDither({ ...dither, cell })}
          onScene={(scene) => onDither({ ...dither, scene })}
        />
      </div>
    </div>
  );
};

function ModelMenu({ model, onChange }: { model: ModelId; onChange: (model: ModelId) => void }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Model"
            className="gap-1 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-[160ms] ease-out hover:bg-foreground/[0.05] hover:text-foreground"
          />
        }
      >
        {modelLabel(model)}
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" side="top" className="w-56">
        <MenuRadioGroup value={model} onValueChange={(value) => onChange(value as ModelId)}>
          {MODELS.map((item) => (
            <MenuRadioItem key={item.id} value={item.id} className="items-start py-1.5">
              <span className="flex flex-col gap-0.5">
                <span>{item.label}</span>
                <span className="text-xs text-subtle">{item.hint}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function TranscriptMessage({
  message,
  grouped,
  canRetry,
  dispatch,
}: {
  message: ChatMessageModel;
  grouped: boolean;
  canRetry: boolean;
  dispatch: (action: ChatAction) => void;
}) {
  const outgoing = message.role === "user";

  if (outgoing) {
    return (
      <ChatMessage
        side="outgoing"
        grouped={grouped}
        className={grouped ? "-mt-4" : undefined}
        bubbleProps={{
          className: "border border-edge bg-surface-quiet px-3.5 py-2.5 shadow-rim",
        }}
        footer={
          message.attachments && message.attachments.length > 0 ? (
            <span className="flex flex-wrap justify-end gap-1">
              {message.attachments.map((file) => (
                <Badge key={file.id} variant="outline" size="sm" className="rounded-md">
                  {file.name} · {formatSize(file.size)}
                </Badge>
              ))}
            </span>
          ) : null
        }
        actions={
          <ChatMessageActionToolbar
            side="outgoing"
            toolbarLabel="Message actions"
            moreLabel="More"
            moreTooltip="More actions"
            menuChildren={
              <>
                <MenuItem onClick={() => void navigator.clipboard.writeText(message.text)}>
                  Copy
                </MenuItem>
                <MenuItem onClick={() => dispatch({ type: "edit", id: message.id })}>Edit</MenuItem>
              </>
            }
          />
        }
      >
        <ChatMessageText text={message.text} className="text-sm leading-6" />
      </ChatMessage>
    );
  }

  return (
    <ChatMessage
      side="incoming"
      grouped={grouped}
      className={grouped ? "-mt-4" : undefined}
      bubble={false}
      avatar={<AssistantMark />}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {message.thinking ? (
          <Collapsible>
            <CollapsibleTrigger className="group/thought inline-flex w-fit items-center gap-1.5 rounded-md text-xs text-subtle transition-colors hover:text-muted-foreground">
              <span>Thought</span>
              <ChevronDownIcon className="size-3 transition-transform group-data-[panel-open]/thought:rotate-180" />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <p className="mt-2 border-l border-line pl-3 text-xs leading-5 whitespace-pre-wrap text-subtle">
                {message.thinking}
              </p>
            </CollapsiblePanel>
          </Collapsible>
        ) : null}

        {message.tool ? (
          <Collapsible>
            <CollapsibleTrigger className="group/tool inline-flex w-fit max-w-full items-center gap-1.5 rounded-md text-xs text-subtle transition-colors hover:text-muted-foreground">
              <span className="truncate">{message.tool.name}</span>
              <Badge variant="warning" size="sm">
                Pending
              </Badge>
              <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[panel-open]/tool:rotate-180" />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <p className="px-1 pt-2 text-xs leading-5 whitespace-pre-wrap text-subtle">
                {message.tool.detail}
              </p>
            </CollapsiblePanel>
          </Collapsible>
        ) : null}

        <div className="flex min-w-0 flex-col gap-2.5 text-sm leading-7 text-foreground/90">
          {splitBlocks(message.text).map((block, index) =>
            block.kind === "code" ? (
              <pre
                key={index}
                className="overflow-x-auto rounded-xl border border-edge bg-surface-quiet px-3.5 py-3 font-mono text-xs leading-5 text-foreground/80 shadow-rim"
              >
                <code>{block.text}</code>
              </pre>
            ) : (
              <p key={index} className="whitespace-pre-wrap">
                {block.text}
              </p>
            ),
          )}
        </div>

        <div className="flex justify-start">
          <ChatMessageActionToolbar
            side="incoming"
            toolbarLabel="Message actions"
            moreLabel="More"
            moreTooltip="More actions"
            menuChildren={
              <>
                <MenuItem onClick={() => void navigator.clipboard.writeText(message.text)}>
                  Copy
                </MenuItem>
                {canRetry ? (
                  <MenuItem onClick={() => dispatch({ type: "retry" })}>Regenerate</MenuItem>
                ) : null}
                <MenuItem
                  onClick={() => dispatch({ type: "feedback", id: message.id, vote: "up" })}
                >
                  Good response
                </MenuItem>
                <MenuItem
                  onClick={() => dispatch({ type: "feedback", id: message.id, vote: "down" })}
                >
                  Bad response
                </MenuItem>
              </>
            }
          />
        </div>
      </div>
    </ChatMessage>
  );
}

function AssistantMark() {
  return (
    <span aria-hidden="true" className="text-[11px] font-medium leading-6 text-subtle">
      C
    </span>
  );
}
