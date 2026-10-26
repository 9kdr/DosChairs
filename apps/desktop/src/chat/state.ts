export type ModelId = "wonder" | "spark";

export const MODELS: readonly { id: ModelId; label: string; hint: string }[] = [
  { id: "wonder", label: "Wonder", hint: "Planner" },
  { id: "spark", label: "Spark", hint: "Executor" },
];

export type ChatAttachment = {
  id: string;
  name: string;
  size: number;
};

export type ToolRow = {
  name: string;
  detail: string;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  thinking?: string;
  tool?: ToolRow;
  status?: "pending" | "done" | "stopped";
  feedback?: "up" | "down";
};

export type Thread = {
  id: string;
  title: string;
  model: ModelId;
  messages: ChatMessage[];
  draft: string;
  attachments: ChatAttachment[];
  updatedAt: number;
};

export type ChatState = {
  threads: Thread[];
  activeId: string;
  query: string;
};

export type ChatAction =
  | { type: "query"; query: string }
  | { type: "select"; id: string }
  | { type: "new" }
  | { type: "rename"; id: string; title: string }
  | { type: "delete"; id: string }
  | { type: "model"; model: ModelId }
  | { type: "draft"; draft: string }
  | { type: "attach"; name: string; size: number }
  | { type: "detach"; id: string }
  | { type: "send" }
  | { type: "stop" }
  | { type: "complete" }
  | { type: "retry" }
  | { type: "edit"; id: string }
  | { type: "feedback"; id: string; vote: "up" | "down" };

export type TextBlock = { kind: "text" | "code"; text: string };

type Clock = {
  now: number;
  id: () => string;
};

const SEED_NOW = 1_700_000_000_000;

export function modelLabel(id: ModelId): string {
  return MODELS.find((model) => model.id === id)?.label ?? id;
}

export function activeThread(state: ChatState): Thread | undefined {
  return state.threads.find((thread) => thread.id === state.activeId);
}

export function splitBlocks(source: string): TextBlock[] {
  const parts = source.split("```");
  const blocks: TextBlock[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const body = part.replace(/^[^\n]*\n/, "").replace(/\n$/, "");
      if (body) blocks.push({ kind: "code", text: body });
      return;
    }
    if (part) blocks.push({ kind: "text", text: part });
  });
  return blocks.length > 0 ? blocks : [{ kind: "text", text: source }];
}

export function standInReply(prompt: string): { text: string; thinking: string; tool?: ToolRow } {
  const asksForEdit = /cut|trim|caption|grade|beat|timeline|footage/i.test(prompt);
  if (!asksForEdit) {
    return {
      thinking: "Local stand-in. No model was called, and the timeline was left alone.",
      text: "I can draft a proposal once you describe the cut. This reply stays in the chat.",
    };
  }
  return {
    thinking: "Local stand-in. No model was called. A proposal stays pending until you accept it.",
    tool: {
      name: "propose changeset",
      detail: "trim on beat_hook, add a caption track. Pending. The timeline is unchanged.",
    },
    text: "I'll propose a trim and a caption track. Both stay pending until you accept them.\n\n```\ntrim beat_hook\nadd_track captions\n```",
  };
}

export function createChat(): ChatState {
  const thread: Thread = {
    id: "thread_demo",
    title: "Rough cut",
    model: "wonder",
    draft: "",
    attachments: [],
    updatedAt: SEED_NOW,
    messages: [
      {
        id: "msg_user",
        role: "user",
        text: "Rough-cut the talking head. Drop the pause before the first line.",
        createdAt: SEED_NOW,
        attachments: [{ id: "file_brief", name: "brief.txt", size: 1280 }],
      },
      {
        id: "msg_assistant",
        role: "assistant",
        createdAt: SEED_NOW + 1,
        status: "done",
        ...standInReply("Rough-cut the talking head"),
      },
    ],
  };
  return { threads: [thread], activeId: thread.id, query: "" };
}

function titleFrom(text: string, attachments: ChatAttachment[]): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  const base = line || (attachments[0] ? attachments[0].name : "New chat");
  return base.length > 42 ? `${base.slice(0, 41)}…` : base;
}

function blankThread(clock: Clock): Thread {
  return {
    id: clock.id(),
    title: "New chat",
    model: "wonder",
    messages: [],
    draft: "",
    attachments: [],
    updatedAt: clock.now,
  };
}

function mapActive(state: ChatState, update: (thread: Thread) => Thread): ChatState {
  return {
    ...state,
    threads: state.threads.map((thread) =>
      thread.id === state.activeId ? update(thread) : thread,
    ),
  };
}

function isEmptyDraft(thread: Thread): boolean {
  return (
    thread.messages.length === 0 && thread.draft.trim() === "" && thread.attachments.length === 0
  );
}

export function applyChat(state: ChatState, action: ChatAction, clock: Clock): ChatState {
  const current = activeThread(state);
  switch (action.type) {
    case "query":
      return { ...state, query: action.query };
    case "select":
      return state.threads.some((thread) => thread.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case "new": {
      if (current && isEmptyDraft(current) && current.title === "New chat") return state;
      const thread = blankThread(clock);
      return { ...state, threads: [thread, ...state.threads], activeId: thread.id };
    }
    case "rename": {
      const title = action.title.trim() || "New chat";
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.id === action.id ? { ...thread, title, updatedAt: clock.now } : thread,
        ),
      };
    }
    case "delete": {
      const remaining = state.threads.filter((thread) => thread.id !== action.id);
      if (remaining.length === state.threads.length) return state;
      if (remaining.length === 0) {
        const thread = blankThread(clock);
        return { ...state, threads: [thread], activeId: thread.id };
      }
      const activeId =
        state.activeId === action.id ? (remaining[0]?.id ?? state.activeId) : state.activeId;
      return { ...state, threads: remaining, activeId };
    }
    case "model":
      return mapActive(state, (thread) => ({ ...thread, model: action.model }));
    case "draft":
      return mapActive(state, (thread) => ({ ...thread, draft: action.draft }));
    case "attach": {
      const name = action.name.trim();
      if (!name || !current) return state;
      const file: ChatAttachment = { id: clock.id(), name, size: action.size };
      return mapActive(state, (thread) => ({
        ...thread,
        attachments: [...thread.attachments, file],
      }));
    }
    case "detach":
      return mapActive(state, (thread) => ({
        ...thread,
        attachments: thread.attachments.filter((file) => file.id !== action.id),
      }));
    case "send": {
      if (!current) return state;
      const text = current.draft.trim();
      const pending = current.messages.some((message) => message.status === "pending");
      if (pending || (text === "" && current.attachments.length === 0)) return state;
      const user: ChatMessage = {
        id: clock.id(),
        role: "user",
        text,
        createdAt: clock.now,
      };
      if (current.attachments.length > 0) user.attachments = current.attachments;
      const assistant: ChatMessage = {
        id: clock.id(),
        role: "assistant",
        text: "",
        createdAt: clock.now,
        status: "pending",
        thinking: "Thinking",
      };
      const title =
        current.messages.length === 0 && current.title === "New chat"
          ? titleFrom(text, current.attachments)
          : current.title;
      return mapActive(state, (thread) => ({
        ...thread,
        title,
        draft: "",
        attachments: [],
        updatedAt: clock.now,
        messages: [...thread.messages, user, assistant],
      }));
    }
    case "stop":
      return mapActive(state, (thread) => ({
        ...thread,
        updatedAt: clock.now,
        messages: thread.messages.map((message) =>
          message.status === "pending"
            ? { ...message, status: "stopped", text: "Stopped before a reply." }
            : message,
        ),
      }));
    case "complete":
      return mapActive(state, (thread) => {
        const pendingIndex = thread.messages.findIndex((message) => message.status === "pending");
        if (pendingIndex < 0) return thread;
        const prompt = [...thread.messages]
          .slice(0, pendingIndex)
          .reverse()
          .find((message) => message.role === "user");
        const reply = standInReply(prompt?.text ?? "");
        return {
          ...thread,
          updatedAt: clock.now,
          messages: thread.messages.map((message, index) =>
            index === pendingIndex
              ? {
                  ...message,
                  status: "done" as const,
                  text: reply.text,
                  thinking: reply.thinking,
                  ...(reply.tool ? { tool: reply.tool } : {}),
                }
              : message,
          ),
        };
      });
    case "retry":
      return mapActive(state, (thread) => {
        const last = thread.messages[thread.messages.length - 1];
        if (!last || last.role !== "assistant" || last.status === "pending") return thread;
        const assistant: ChatMessage = {
          id: clock.id(),
          role: "assistant",
          text: "",
          createdAt: clock.now,
          status: "pending",
          thinking: "Thinking",
        };
        return {
          ...thread,
          updatedAt: clock.now,
          messages: [...thread.messages.slice(0, -1), assistant],
        };
      });
    case "edit":
      return mapActive(state, (thread) => {
        const index = thread.messages.findIndex((message) => message.id === action.id);
        const message = index >= 0 ? thread.messages[index] : undefined;
        if (!message || message.role !== "user") return thread;
        const remaining = thread.messages.slice(0, index);
        return {
          ...thread,
          title: remaining.length === 0 ? "New chat" : thread.title,
          draft: message.text,
          attachments: message.attachments ?? [],
          messages: remaining,
          updatedAt: clock.now,
        };
      });
    case "feedback":
      return mapActive(state, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) => {
          if (message.id !== action.id || message.role !== "assistant") return message;
          if (message.feedback === action.vote) {
            const { feedback: _removed, ...rest } = message;
            return rest;
          }
          return { ...message, feedback: action.vote };
        }),
      }));
    default:
      return state;
  }
}

export function reduceChat(state: ChatState, action: ChatAction): ChatState {
  return applyChat(state, action, {
    now: Date.now(),
    id: () => crypto.randomUUID(),
  });
}
