import { useEffect, useRef, useState } from "react";
import {
  ChevronsUpDownIcon,
  EllipsisIcon,
  FilmIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ChatAction, ChatState } from "./state";

type ChatSidebarProps = {
  chat: ChatState;
  dispatch: (action: ChatAction) => void;
  cutName: string;
  cutOpen: boolean;
  pending: number;
  onHide: () => void;
  onToggleCut: () => void;
  onNavigate?: () => void;
  className?: string;
};

export function ChatSidebar({
  chat,
  dispatch,
  cutName,
  cutOpen,
  pending,
  onHide,
  onToggleCut,
  onNavigate,
  className,
}: ChatSidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const query = chat.query.trim().toLowerCase();
  const visible = chat.threads.filter((thread) => thread.title.toLowerCase().includes(query));

  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  function closeSearch() {
    setSearchOpen(false);
    dispatch({ type: "query", query: "" });
  }

  function selectThread(id: string) {
    dispatch({ type: "select", id });
    onNavigate?.();
  }

  return (
    <aside
      aria-label="Threads"
      className={cn(
        "flex w-[13.5rem] shrink-0 flex-col border-r border-line bg-sidebar/80 backdrop-blur-xl",
        className,
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-0.5 px-2">
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-w-0 flex-1 justify-start gap-1.5 px-1.5 text-[13px] font-medium text-foreground/90"
              />
            }
          >
            <span className="truncate">Chair</span>
            <ChevronsUpDownIcon className="size-3 text-subtle" />
          </MenuTrigger>
          <MenuPopup align="start" className="w-52">
            <MenuItem onClick={() => dispatch({ type: "new" })}>New chat</MenuItem>
            <MenuItem onClick={onHide}>Hide threads</MenuItem>
            <MenuSeparator />
            <MenuItem onClick={onToggleCut}>
              {cutOpen ? "Hide cut" : "Show cut"}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={searchOpen ? "Close search" : "Search threads"}
          aria-pressed={searchOpen}
          className="rounded-lg text-muted-foreground hover:text-foreground"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          {searchOpen ? <XIcon /> : <SearchIcon />}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Hide threads"
          className="rounded-lg text-muted-foreground hover:text-foreground"
          onClick={onHide}
        >
          <PanelLeftIcon />
        </Button>
      </div>

      {searchOpen ? (
        <div className="px-2 pb-2">
          <Input
            ref={searchRef}
            size="sm"
            value={chat.query}
            placeholder="Search threads"
            aria-label="Search threads"
            className="h-8 border-foreground/[0.08] bg-foreground/[0.03] text-[13px]"
            onChange={(event) => dispatch({ type: "query", query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSearch();
            }}
          />
        </div>
      ) : null}

      <div className="shrink-0 px-2">
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start gap-2 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
          onClick={() => {
            dispatch({ type: "new" });
            onNavigate?.();
          }}
        >
          <SquarePenIcon className="size-4" />
          New chat
        </Button>
      </div>

      <ScrollArea className="mt-4 min-h-0 flex-1">
        <div className="px-2">
          <p className="px-2 pb-1 text-[11px] font-medium text-subtle">Recents</p>
          <ul className="space-y-px" aria-label="Threads">
            {visible.map((thread) => (
              <li key={thread.id}>
                {renamingId === thread.id ? (
                  <Input
                    size="sm"
                    autoFocus
                    defaultValue={thread.title}
                    aria-label="Thread title"
                    className="h-8 text-[13px]"
                    onBlur={(event) => {
                      dispatch({ type: "rename", id: thread.id, title: event.target.value });
                      setRenamingId(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <div
                    className={cn(
                      "group/row flex items-center rounded-lg transition-colors hover:bg-foreground/[0.045]",
                      thread.id === chat.activeId && "bg-foreground/[0.065]",
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        "flex h-8 min-w-0 flex-1 items-center rounded-lg px-2 text-left text-[13px] text-muted-foreground transition-colors group-hover/row:text-foreground",
                        thread.id === chat.activeId && "text-foreground",
                      )}
                      aria-current={thread.id === chat.activeId ? "true" : undefined}
                      onClick={() => selectThread(thread.id)}
                    >
                      <span className="truncate">{thread.title}</span>
                    </button>
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Actions for ${thread.title}`}
                            className="me-1 rounded-md text-subtle opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                          />
                        }
                      >
                        <EllipsisIcon />
                      </MenuTrigger>
                      <MenuPopup align="end" className="w-36">
                        <MenuItem onClick={() => setRenamingId(thread.id)}>Rename</MenuItem>
                        <MenuItem
                          variant="destructive"
                          onClick={() => dispatch({ type: "delete", id: thread.id })}
                        >
                          Delete
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-xs text-subtle">
              {chat.query ? "No threads match." : "No threads yet."}
            </p>
          ) : null}
        </div>

        <div className="mt-5 px-2 pb-4">
          <p className="px-2 pb-1 text-[11px] font-medium text-subtle">Projects</p>
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground"
          >
            <FilmIcon className="size-4 shrink-0 opacity-70" />
            <span className="truncate">{cutName}</span>
          </button>
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-line p-2">
        <button
          type="button"
          className="hidden h-8 w-full items-center gap-2 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground lg:flex"
          onClick={onToggleCut}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              pending > 0 ? "bg-warning" : "bg-success",
            )}
          />
          <span className="flex-1 text-left">
            {pending > 0 ? `${pending} pending` : "No pending changes"}
          </span>
          <PanelRightIcon className="size-3.5 opacity-60" />
        </button>
      </div>
    </aside>
  );
}
