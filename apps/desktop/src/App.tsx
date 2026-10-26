import { useMemo, useReducer, useState } from "react";
import { emptyTimeline } from "@chair/timeline-ir";
import type { Changeset, Timeline } from "@chair/timeline-ir";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatPanel } from "./chat/ChatPanel";
import { ChatRail } from "./chat/ChatRail";
import { ChatSidebar } from "./chat/ChatSidebar";
import { CutPanel } from "./chat/CutPanel";
import { createChat, reduceChat } from "./chat/state";

const DEMO_CHANGESET: Changeset = {
  schemaVersion: "0.1.0",
  id: "cs_demo",
  baseRevision: "rev_0",
  summary: "Rough-cut proposal",
  items: [
    {
      id: "item_hook",
      op: "trim",
      beatId: "beat_hook",
      rationale: "Drop the pause before the first line.",
      status: "pending",
    },
    {
      id: "item_caption",
      op: "add_track",
      beatId: "beat_setup",
      rationale: "Captions use the learned caption preset.",
      status: "pending",
    },
  ],
};

export function App() {
  const [timeline] = useState<Timeline>(() => emptyTimeline("tl_demo", "Untitled cut"));
  const [changeset, setChangeset] = useState<Changeset>(DEMO_CHANGESET);
  const [chat, dispatch] = useReducer(reduceChat, undefined, createChat);
  const [threadsOpen, setThreadsOpen] = useState(true);
  const [cutOpen, setCutOpen] = useState(true);

  const pending = useMemo(
    () => changeset.items.filter((item) => item.status === "pending").length,
    [changeset],
  );

  function setStatus(id: string, status: "accepted" | "rejected") {
    setChangeset((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, status } : item)),
    }));
  }

  return (
    <TooltipProvider delay={400}>
      <div className="flex h-full min-h-0 bg-background text-foreground">
        <ChatRail
          threadsOpen={threadsOpen}
          cutOpen={cutOpen}
          pending={pending}
          onToggleThreads={() => setThreadsOpen((open) => !open)}
          onToggleCut={() => setCutOpen((open) => !open)}
          onNewChat={() => dispatch({ type: "new" })}
        />
        {threadsOpen ? (
          <ChatSidebar
            chat={chat}
            dispatch={dispatch}
            cutName={timeline.name}
            cutOpen={cutOpen}
            pending={pending}
            onHide={() => setThreadsOpen(false)}
            onToggleCut={() => setCutOpen((open) => !open)}
          />
        ) : null}
        <ChatPanel
          chat={chat}
          dispatch={dispatch}
          cutName={timeline.name}
          threadsOpen={threadsOpen}
          onOpenThreads={() => setThreadsOpen(true)}
        />
        {cutOpen ? (
          <CutPanel
            timeline={timeline}
            changeset={changeset}
            onStatus={setStatus}
            onClose={() => setCutOpen(false)}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}
