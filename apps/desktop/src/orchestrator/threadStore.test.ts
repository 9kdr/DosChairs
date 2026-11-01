import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isTerminalTaskStatus,
  listTaskThreads,
  readTaskThread,
  writeTaskThread,
  type ThreadSnapshot,
} from "./threadStore";

/** Node has no localStorage; stand in with a map behind the same calls. */
function installMemoryStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  });
  return backing;
}

function snapshot(taskId: string, extra: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    taskId,
    taskName: `Task ${taskId}`,
    lane: "edit",
    status: "Scanning audio pauses",
    turns: [
      {
        id: "open",
        role: "assistant",
        text: "Done (req_0123456789): no previews, no proposed changes.",
      },
      { id: "user-1", role: "user", text: "trim the pause" },
    ],
    savedAt: "2026-11-01T10:00:00.000Z",
    ...extra,
  };
}

beforeEach(() => {
  installMemoryStorage();
});

describe("thread round-trip", () => {
  it("writes and reads one task's thread back unchanged", () => {
    expect(readTaskThread("task-3")).toBeNull();
    const stored = snapshot("task-3");
    writeTaskThread(stored);
    expect(readTaskThread("task-3")).toEqual(stored);
  });

  it("keeps tasks apart", () => {
    writeTaskThread(snapshot("task-1"));
    expect(readTaskThread("task-2")).toBeNull();
  });

  it("reads corrupt and wrong-shaped values as missing", () => {
    const backing = installMemoryStorage();
    backing.set("chair.task.thread.task-1", "{nope");
    expect(readTaskThread("task-1")).toBeNull();
    backing.set("chair.task.thread.task-1", JSON.stringify({ taskId: "task-1" }));
    expect(readTaskThread("task-1")).toBeNull();
    backing.set(
      "chair.task.thread.task-1",
      JSON.stringify(
        snapshot("task-1", { turns: [{ id: "x", role: "ghost", text: "?" }] as never }),
      ),
    );
    expect(readTaskThread("task-1")).toBeNull();
  });
});

describe("restart retention", () => {
  it("keeps threads across a restart (fresh module, same storage)", async () => {
    const stored = snapshot("task-3");
    writeTaskThread(stored);
    vi.resetModules();
    const fresh = await import("./threadStore");
    expect(fresh.readTaskThread("task-3")).toEqual(stored);
  });

  it("retains terminal task threads for the previous-tasks view", () => {
    writeTaskThread(
      snapshot("task-1", { status: "completed", savedAt: "2026-11-01T09:00:00.000Z" }),
    );
    writeTaskThread(snapshot("task-2", { status: "failed", savedAt: "2026-11-01T10:00:00.000Z" }));
    writeTaskThread(
      snapshot("task-3", { status: "Scanning audio pauses", savedAt: "2026-11-01T11:00:00.000Z" }),
    );
    const listed = listTaskThreads();
    expect(listed.map((entry) => entry.taskId)).toEqual(["task-3", "task-2", "task-1"]);
    expect(listed.map((entry) => entry.terminal)).toEqual([false, true, true]);
    expect(listed[0]).toMatchObject({ taskName: "Task task-3", turnCount: 2 });
  });

  it("skips index entries that no longer read", () => {
    const backing = installMemoryStorage();
    writeTaskThread(snapshot("task-1"));
    backing.set("chair.task.threads", JSON.stringify(["task-1", "task-gone"]));
    expect(listTaskThreads().map((entry) => entry.taskId)).toEqual(["task-1"]);
  });

  it("lists each task once no matter how often it saves", () => {
    writeTaskThread(snapshot("task-1"));
    writeTaskThread(snapshot("task-1", { savedAt: "2026-11-01T12:00:00.000Z" }));
    expect(listTaskThreads()).toHaveLength(1);
  });
});

describe("terminal task states", () => {
  it("flags completed, failed, and canceled tasks", () => {
    for (const status of [
      "completed",
      "Completed",
      "failed",
      "canceled",
      "cancelled",
      "moderated",
    ]) {
      expect(isTerminalTaskStatus(status)).toBe(true);
    }
    for (const status of ["Scanning audio pauses", "queued", ""]) {
      expect(isTerminalTaskStatus(status)).toBe(false);
    }
  });
});
