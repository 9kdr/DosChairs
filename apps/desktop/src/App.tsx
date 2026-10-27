import { useReducer, useState } from "react";
import { WindowChrome } from "@/components/window-chrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatPanel } from "./chat/ChatPanel";
import { ChatRail } from "./chat/ChatRail";
import { ChatSidebar } from "./chat/ChatSidebar";
import { createChat, reduceChat } from "./chat/state";
import { PROJECTS } from "./home/data";
import { HomeScreen } from "./home/HomeScreen";

type Screen = "home" | "chat";

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [chat, dispatch] = useReducer(reduceChat, undefined, createChat);
  const [threadsOpen, setThreadsOpen] = useState(true);

  const project = PROJECTS.find((entry) => entry.id === projectId) ?? null;

  return (
    <TooltipProvider delay={400}>
      <div className="relative h-full min-h-0 bg-background text-foreground">
        <WindowChrome />
        {screen === "home" ? (
          <HomeScreen
            onOpenProject={(id) => {
              setProjectId(id);
              setScreen("chat");
            }}
          />
        ) : (
          <div className="flex h-full min-h-0">
            <ChatRail
              threadsOpen={threadsOpen}
              projectName={project?.name}
              onToggleThreads={() => setThreadsOpen((open) => !open)}
              onNewChat={() => dispatch({ type: "new" })}
              onHome={() => setScreen("home")}
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
        )}
      </div>
    </TooltipProvider>
  );
}
