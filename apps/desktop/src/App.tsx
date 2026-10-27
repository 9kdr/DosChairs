import { useReducer, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatPanel } from "./chat/ChatPanel";
import { ChatRail } from "./chat/ChatRail";
import { ChatSidebar } from "./chat/ChatSidebar";
import { createChat, reduceChat } from "./chat/state";

export function App() {
  const [chat, dispatch] = useReducer(reduceChat, undefined, createChat);
  const [threadsOpen, setThreadsOpen] = useState(true);

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full min-h-0 bg-background text-foreground">
        <ChatRail
          threadsOpen={threadsOpen}
          onToggleThreads={() => setThreadsOpen((open) => !open)}
          onNewChat={() => dispatch({ type: "new" })}
        />
        {threadsOpen ? (
          <ChatSidebar
            chat={chat}
            dispatch={dispatch}
            onHide={() => setThreadsOpen(false)}
          />
        ) : null}
        <ChatPanel
          chat={chat}
          dispatch={dispatch}
          threadsOpen={threadsOpen}
          onOpenThreads={() => setThreadsOpen(true)}
        />
      </div>
    </TooltipProvider>
  );
}
