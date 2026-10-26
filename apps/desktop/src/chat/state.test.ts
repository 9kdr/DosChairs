import { describe, expect, it } from "vitest";
import { applyChat, createChat, splitBlocks, type ChatAction, type ChatState } from "./state";

function clock() {
  let n = 0;
  return {
    now: 10,
    id: () => `id_${++n}`,
  };
}

function run(actions: ChatAction[], state: ChatState = createChat()): ChatState {
  return actions.reduce((current, action) => applyChat(current, action, clock()), state);
}

describe("chat state", () => {
  it("sends a message and can stop the stand-in before it finishes", () => {
    const sent = run([{ type: "new" }, { type: "draft", draft: "Hello" }, { type: "send" }]);
    const thread = sent.threads[0];
    expect(thread?.title).toBe("Hello");
    expect(thread?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(thread?.messages[1]?.status).toBe("pending");
    expect(thread?.draft).toBe("");

    const stopped = applyChat(sent, { type: "stop" }, clock());
    expect(stopped.threads[0]?.messages[1]?.status).toBe("stopped");
    expect(applyChat(stopped, { type: "complete" }, clock()).threads[0]?.messages[1]?.status).toBe(
      "stopped",
    );
  });

  it("finishes a local reply without touching an empty send", () => {
    const empty = run([{ type: "new" }, { type: "draft", draft: "   " }, { type: "send" }]);
    expect(empty.threads[0]?.messages).toEqual([]);

    const done = run([
      { type: "new" },
      { type: "draft", draft: "Trim the pause" },
      { type: "send" },
      { type: "complete" },
    ]);
    const reply = done.threads[0]?.messages[1];
    expect(reply?.status).toBe("done");
    expect(reply?.tool?.name).toBe("propose changeset");
    expect(reply?.text).toContain("pending");
  });

  it("retries, edits, and keeps file chips on the draft", () => {
    const sent = run([
      { type: "new" },
      { type: "attach", name: "notes.txt", size: 12 },
      { type: "draft", draft: "Look at this" },
      { type: "send" },
      { type: "complete" },
    ]);
    const userId = sent.threads[0]?.messages[0]?.id ?? "";
    const retried = applyChat(sent, { type: "retry" }, clock());
    expect(retried.threads[0]?.messages[1]?.status).toBe("pending");

    const edited = applyChat(sent, { type: "edit", id: userId }, clock());
    expect(edited.threads[0]?.messages).toEqual([]);
    expect(edited.threads[0]?.draft).toBe("Look at this");
    expect(edited.threads[0]?.attachments.map((file) => file.name)).toEqual(["notes.txt"]);
    expect(edited.threads[0]?.title).toBe("New chat");
  });

  it("deletes the last thread back to an empty one and filters by query only in state", () => {
    const removed = run([{ type: "delete", id: "thread_demo" }]);
    expect(removed.threads).toHaveLength(1);
    expect(removed.threads[0]?.messages).toEqual([]);
    const queried = applyChat(createChat(), { type: "query", query: "rough" }, clock());
    expect(queried.threads).toHaveLength(1);
    expect(queried.query).toBe("rough");
  });

  it("splits fenced code out of a reply", () => {
    expect(splitBlocks("Before\n```\ntrim\n```\nAfter")).toEqual([
      { kind: "text", text: "Before\n" },
      { kind: "code", text: "trim" },
      { kind: "text", text: "\nAfter" },
    ]);
  });
});
