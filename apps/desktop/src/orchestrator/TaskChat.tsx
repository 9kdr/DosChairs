import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Undo2 } from "lucide-react";
import { ChatPrompt, type ChatDraft } from "@/components/chat-prompt";
import { SmoothScrollTarget } from "@/components/smooth-scroll";
import { Button } from "@/components/ui/button";
import type { RunningTask } from "./RunningTasks";
import { TaskActivityPanel } from "./TaskActivity";
import { selectionForNote, useTaskThread, type TaskNote } from "./taskThread";
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
 * prompts propose rewinding the task's accepted tail as one gated
 * changeset. Each turn carries the composer's model pick and attachments.
 * Sending does not change the timeline.
 */
export function TaskChat({
  task,
  note,
  history,
  onClose,
  onSend,
  onUndoRequest,
  onUndoEntry,
}: {
  task: RunningTask;
  note: TaskNote | null;
  history: readonly HistoryEntry[];
  onClose: () => void;
  onSend: (text: string) => void;
  /** Propose rewinding the task's tail; answers the undo prompt. */
  onUndoRequest?: (task: RunningTask) => string;
  onUndoEntry?: (entry: HistoryEntry) => void;
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
  const { turns, activity } = useTaskThread(task, threadNote, resolveLocalReply);
  const endRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

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
          aria-label="Back to the desk"
          onClick={onClose}
        >
          <ArrowLeft />
          Desk
        </Button>
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-wide">{task.name}</h2>
        <span className="rounded-full bg-white/8 px-2 py-0.5 text-xs text-neutral-300">
          {LANE[task.lane]}
        </span>
        <span className="ml-auto text-xs text-neutral-500">{task.status}</span>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 px-4">
        <div
          ref={threadRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          <SmoothScrollTarget target={threadRef} lerp={0.075} />
          <ol className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-4">
            {turns.map((turn) =>
              turn.role === "user" ? (
                <li key={turn.id} className="flex justify-end">
                  <p className="max-w-[80%] rounded-2xl bg-[#1a1a1a] px-4 py-3 text-sm leading-6 text-neutral-100 shadow-raised ring-1 ring-white/8">
                    {turn.text}
                  </p>
                </li>
              ) : (
                <li key={turn.id} className="max-w-[40rem]">
                  <p className="text-sm leading-6 text-neutral-200">{turn.text}</p>
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

      <div className="flex shrink-0 gap-4 px-4 pt-2 pb-6">
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
