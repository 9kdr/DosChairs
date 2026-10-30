import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { ChatPrompt } from "@/components/chat-prompt";
import { Button } from "@/components/ui/button";
import type { RunningTask } from "./RunningTasks";
import { TaskActivityPanel } from "./TaskActivity";

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const OPENING: Record<string, string> = {
  "task-1": "A-roll is lining up on V1. The face stays through the question.",
  "task-2": "The highlight is sitting on the hook, not on the room.",
  "task-3": "Pauses are marked. Nothing has been cut yet.",
  "task-4": "Shot 04 is being balanced to the reference still.",
};

const LANE: Record<RunningTask["lane"], string> = {
  edit: "Edit",
  effects: "Effects",
  colour: "Colour",
};

/**
 * A full thread for one running task. Stand-in replies only.
 * Sending does not change the timeline.
 */
export function TaskChat({
  task,
  note,
  onClose,
  onSend,
}: {
  task: RunningTask;
  note: { id: number; text: string } | null;
  onClose: () => void;
  onSend: (text: string) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>(() => [
    {
      id: "open",
      role: "assistant",
      text: `${OPENING[task.id] ?? task.status} This is a stand-in, not a live agent.`,
    },
  ]);
  const endRef = useRef<HTMLDivElement>(null);
  const seenNote = useRef<number | null>(null);

  useEffect(() => {
    if (!note || seenNote.current === note.id) return;
    seenNote.current = note.id;
    const text = note.text.trim();
    if (!text) return;
    const reply = `Still on ${task.name}. I kept that note. The timeline is unchanged.`;
    setTurns((current) => [
      ...current,
      { id: `user-${note.id}`, role: "user", text },
      { id: `assistant-${note.id}`, role: "assistant", text: reply },
    ]);
  }, [note, task.name]);

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
        <h2 className="min-w-0 truncate text-sm font-semibold tracking-wide">
          {task.name}
        </h2>
        <span className="rounded-full bg-white/8 px-2 py-0.5 text-xs text-neutral-300">
          {LANE[task.lane]}
        </span>
        <span className="ml-auto text-xs text-neutral-500">{task.status}</span>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 px-4">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
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
        <TaskActivityPanel task={task} />
      </div>

      <div className="mx-auto flex w-full max-w-3xl shrink-0 justify-center px-4 pt-2 pb-6">
        <ChatPrompt
          open
          wide
          placeholder={`Message about ${task.name}…`}
          onOpen={() => {}}
          onClose={() => {}}
          onSend={(draft) => {
            if (draft.text.trim()) onSend(draft.text);
          }}
        />
      </div>
    </div>
  );
}
