import { CheckCircle2, CircleDot, Plus } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface TodoItem {
  id: string;
  issueNumber: number;
  title: string;
  status: "open" | "done";
  label?: string;
}

export interface TodoListProps {
  className?: string;
  todos?: TodoItem[];
  initialTodos?: TodoItem[];
}

export const STANDIN_TODOS: readonly TodoItem[] = [
  {
    id: "todo-1",
    issueNumber: 1,
    title: "Rough cut: assemble A-roll selects for scene 1",
    status: "done",
    label: "edit",
  },
  {
    id: "todo-2",
    issueNumber: 2,
    title: "Audio cleanup: isolate dialogue track & remove hum",
    status: "open",
    label: "audio",
  },
  {
    id: "todo-3",
    issueNumber: 3,
    title: "Match color grade across camera A & B",
    status: "open",
    label: "color",
  },
  {
    id: "todo-4",
    issueNumber: 4,
    title: "Sync multi-cam angles on slate transient",
    status: "open",
    label: "sync",
  },
  {
    id: "todo-5",
    issueNumber: 5,
    title: "Export review cut with burn-in timecode",
    status: "open",
    label: "export",
  },
];

/**
 * Compact todo list that feels like GitHub issues.
 * Sits under the plan doc in the orchestrator view.
 */
export function TodoList({
  className,
  todos: propTodos,
  initialTodos = STANDIN_TODOS as TodoItem[],
}: TodoListProps) {
  const [todos, setTodos] = useState<TodoItem[]>(propTodos ?? initialTodos);
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  const [newTitle, setNewTitle] = useState("");

  const openCount = todos.filter((t) => t.status === "open").length;
  const doneCount = todos.filter((t) => t.status === "done").length;

  const filteredTodos = todos.filter((item) => {
    if (filter === "open") return item.status === "open";
    if (filter === "done") return item.status === "done";
    return true;
  });

  const toggleStatus = (id: string) => {
    setTodos((prev) =>
      prev.map((item) =>
        item.id === id
          ? { ...item, status: item.status === "open" ? "done" : "open" }
          : item,
      ),
    );
  };

  const handleAdd = (e?: FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = newTitle.trim();
    if (!trimmed) return;

    const maxNumber = todos.reduce((max, t) => Math.max(max, t.issueNumber), 0);
    const newItem: TodoItem = {
      id: `todo-${Date.now()}`,
      issueNumber: maxNumber + 1,
      title: trimmed,
      status: "open",
    };

    setTodos((prev) => [...prev, newItem]);
    setNewTitle("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleAdd();
    } else if (e.key === "Escape") {
      setNewTitle("");
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[28px] bg-[#1a1a1a] p-4 text-neutral-100 shadow-raised ring-1 ring-white/8",
        className,
      )}
    >
      {/* Header status counters */}
      <div className="flex items-center justify-between px-1 text-xs">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setFilter(filter === "open" ? "all" : "open")}
            className={cn(
              "flex items-center gap-1.5 font-medium transition-colors cursor-pointer",
              filter === "open"
                ? "text-emerald-400"
                : "text-neutral-400 hover:text-neutral-200",
            )}
            aria-pressed={filter === "open"}
          >
            <CircleDot className="size-3.5 text-emerald-500" />
            <span>{openCount} Open</span>
          </button>

          <button
            type="button"
            onClick={() => setFilter(filter === "done" ? "all" : "done")}
            className={cn(
              "flex items-center gap-1.5 font-medium transition-colors cursor-pointer",
              filter === "done"
                ? "text-purple-400"
                : "text-neutral-400 hover:text-neutral-200",
            )}
            aria-pressed={filter === "done"}
          >
            <CheckCircle2 className="size-3.5 text-purple-400" />
            <span>{doneCount} Done</span>
          </button>
        </div>

        {filter !== "all" && (
          <button
            type="button"
            onClick={() => setFilter("all")}
            className="cursor-pointer text-[11px] text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
          >
            Show all
          </button>
        )}
      </div>

      {/* Todo list items */}
      <ul className="flex flex-col gap-0.5" role="list">
        {filteredTodos.map((item) => {
          const isOpen = item.status === "open";
          return (
            <li
              key={item.id}
              className="group flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 transition-colors hover:bg-white/[0.04]"
            >
              <button
                type="button"
                aria-label={
                  isOpen
                    ? `Mark #${item.issueNumber} as done`
                    : `Reopen #${item.issueNumber}`
                }
                onClick={() => toggleStatus(item.id)}
                className="shrink-0 cursor-pointer transition-transform active:scale-90"
              >
                {isOpen ? (
                  <CircleDot className="size-3.5 text-emerald-500 transition-colors group-hover:text-emerald-400" />
                ) : (
                  <CheckCircle2 className="size-3.5 text-purple-400 transition-colors group-hover:text-purple-300" />
                )}
              </button>

              <div
                className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2"
                onClick={() => toggleStatus(item.id)}
              >
                <span
                  className={cn(
                    "truncate text-xs transition-colors",
                    isOpen
                      ? "font-medium text-neutral-100"
                      : "text-neutral-400 line-through",
                  )}
                >
                  {item.title}
                </span>

                {item.label && (
                  <span className="shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                    {item.label}
                  </span>
                )}
              </div>

              <span className="shrink-0 font-mono text-[11px] text-neutral-400">
                #{item.issueNumber}
              </span>
            </li>
          );
        })}
        {filteredTodos.length === 0 && (
          <li className="px-2.5 py-3 text-center text-xs text-neutral-400">
            No {filter} tasks
          </li>
        )}
      </ul>

      {/* Quiet add row */}
      <form
        onSubmit={handleAdd}
        className="mt-0.5 flex items-center gap-2 rounded-xl border border-dashed border-white/8 bg-white/[0.02] px-2.5 py-1.5 transition-colors focus-within:border-white/15 focus-within:bg-white/[0.04]"
      >
        <Plus className="size-3.5 shrink-0 text-neutral-400" />
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a task…"
          aria-label="Add a task"
          className="min-w-0 flex-1 bg-transparent text-xs text-neutral-100 placeholder:text-neutral-400/60 outline-none"
        />
        {newTitle.trim().length > 0 && (
          <button
            type="submit"
            className="shrink-0 cursor-pointer rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-medium text-neutral-200 transition-colors hover:bg-white/15 hover:text-white"
          >
            Add
          </button>
        )}
      </form>
    </div>
  );
}

export default TodoList;
