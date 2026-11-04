import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Undo2 } from "lucide-react";
import { ChatPrompt, type ChatDraft } from "@/components/chat-prompt";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { Button } from "@/components/ui/button";
import { displayStatusFor, type RunningTask } from "./RunningTasks";
import { TaskActivityPanel } from "./TaskActivity";
import {
  activeStepLabel,
  headerStatusFor,
  landedFor,
  selectionForNote,
  useTaskThread,
  type TaskNote,
  type Turn,
} from "./taskThread";
import {
  canUndoTask,
  historyForTask,
  undoSummaryForTask,
  type HistoryEntry,
} from "../project/store";

const LANE: Record<RunningTask["lane"], string> = {
  edit: "Edit",
  effects: "Pieces",
  colour: "Colour",
};

/** The prompt the Undo chip (and the row's Undo task button) sends. */
export const UNDO_PROMPT = "Undo this task's changes.";

/**
 * A full thread for one running task. Turns run live on the agent; undo
 * prompts rewind the task's applied tail at once onto a copy. Each turn
 * carries the composer's model pick and attachments. Sending does not
 * change the timeline.
 */
export function TaskChat({
  task,
  note,
  history,
  onClose,
  onSend,
  onUndoRequest,
  onUndoEntry,
  onOpenSettings,
}: {
  task: RunningTask;
  note: TaskNote | null;
  history: readonly HistoryEntry[];
  onClose: () => void;
  onSend: (text: string) => void;
  /** Rewind the task's tail at once; answers the undo prompt. */
  onUndoRequest?: (task: RunningTask) => string;
  onUndoEntry?: (entry: HistoryEntry) => void;
  /** Where the composer's "Add a model key" goes. */
  onOpenSettings?: () => void;
}) {
  const entries = historyForTask(history, task.id);
  const resolveLocalReply = useCallback(
    (text: string) =>
      text.toLowerCase().startsWith("undo")
        ? (onUndoRequest?.(task) ?? undoSummaryForTask(history, task.id, task.name))
        : null,
    [history, onUndoRequest, task],
  );
  // The shell's note channel carries text only, so composer drafts pair up
  // here: each send stashes its draft, and the note it produces picks the
  // draft's files and model back up for the live turn.
  const pendingDraft = useRef<ChatDraft | null>(null);
  const [threadNote, setThreadNote] = useState<TaskNote | null>(null);
  useEffect(() => {
    if (note === null) {
      setThreadNote(null);
      return;
    }
    const selection = selectionForNote(note, pendingDraft.current);
    pendingDraft.current = null;
    setThreadNote((current) => {
      if (current?.id === note.id) return current;
      return selection === null ? { ...note } : { ...note, ...selection };
    });
  }, [note]);
  const { turns, activity, terminal } = useTaskThread(task, threadNote, resolveLocalReply);
  const endRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  // The thread opens with the person's own words: the brief that started
  // the task. Rendered, not stored, so reopening never duplicates it.
  const brief = task.plan?.brief.trim() ? task.plan.brief.trim() : null;
  const opening: Turn[] =
    brief === null ? [] : [{ id: `${task.id}-brief`, role: "user", text: brief }];
  // The header follows the task state, from the same state the card
  // uses: the settled turn plus the card's Resolve-write state. The
  // card's own line stays as the demo fallback and the tooltip.
  const card = displayStatusFor(task);
  const header = headerStatusFor({
    terminal,
    landed: landedFor(task.id)?.state ?? null,
    step: activeStepLabel(activity),
    live: activity !== null,
    fallback: card.short,
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 px-4 pt-2 pb-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Back to tasks"
          onClick={onClose}
        >
          <ArrowLeft />
          Back
        </Button>
        <h2 className="min-w-0 truncate text-title font-medium">{task.name}</h2>
        <span
          className="ml-auto shrink-0 truncate text-xs text-muted-foreground"
          title={card.detail ?? undefined}
        >
          {LANE[task.lane]} ·{" "}
          {header ?? (
            <Loader2
              className="inline size-3.5 animate-spin align-middle"
              aria-label="Working"
            />
          )}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 px-4">
        <div
          ref={threadRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          <SmoothScrollTarget target={threadRef} lerp={0.075} />
          <ol className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-4">
            {[...opening, ...turns].map((turn) =>
              turn.role === "user" ? (
                <li key={turn.id} className="flex justify-end">
                  <p className="max-w-[85%] rounded-card bg-surface-raised px-5 py-4 text-sm leading-6 text-neutral-100">
                    {turn.text}
                  </p>
                </li>
              ) : (
                <li key={turn.id} className="flex max-w-[85%]">
                  <p className="rounded-card bg-card px-5 py-4 text-sm leading-6 text-neutral-200">
                    {turn.text}
                  </p>
                </li>
              ),
            )}
            <div ref={endRef} />
          </ol>
        </div>
        <TaskActivityPanel
          task={task}
          activity={activity ?? undefined}
          history={entries}
          onUndoEntry={onUndoEntry}
        />
      </div>

      <div className="flex shrink-0 gap-4 px-4 pt-2 pb-20">
        <div className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-3xl">
            {canUndoTask(task, history) ? (
              <div className="pb-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onSend(UNDO_PROMPT)}
                >
                  <Undo2 />
                  Undo this task&rsquo;s changes
                </Button>
              </div>
            ) : null}
            <ChatPrompt
              open
              wide
              placeholder={`Message about ${task.name}…`}
              onOpen={() => {}}
              onClose={() => {}}
              onOpenSettings={onOpenSettings}
              onSend={(draft) => {
                // The composer only sends with text or files; stash the
                // whole draft so the note pairs its files and model back.
                pendingDraft.current = draft;
                onSend(draft.text);
              }}
            />
          </div>
        </div>
        {/* Spacer matching the activity rail so the bar starts where the text starts. */}
        <div aria-hidden className="hidden w-72 shrink-0 lg:block" />
      </div>
    </div>
  );
}
