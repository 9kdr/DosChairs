import { describe, expect, it, vi } from "vitest";
import { createHealthStore } from "./useServices";
import { ServiceError, type ServicesClient } from "./client";
import type { AgentHealth, SidecarHealth } from "./types";

const AGENT_HEALTH: AgentHealth = {
  service: "agent",
  ok: true,
  tools: [],
  models: {},
};

const SIDECAR_HEALTH: SidecarHealth = {
  service: "sidecar",
  ok: true,
  device: "cpu",
  jobs: [],
  sam3_runner: false,
  sam_audio_runner: false,
};

function stubClient(overrides: Partial<ServicesClient> = {}) {
  const calls = { health: 0, keys: 0, pushed: [] as Record<string, string | null>[] };
  const client = {
    agentHealth: async () => {
      calls.health += 1;
      return AGENT_HEALTH;
    },
    sidecarHealth: async () => {
      calls.health += 1;
      return SIDECAR_HEALTH;
    },
    setAgentKeys: async (keys: Record<string, string | null>) => {
      calls.keys += 1;
      calls.pushed.push(keys);
      return { ok: true };
    },
    ...overrides,
  } as ServicesClient;
  return { client, calls };
}

function harness(
  client: ServicesClient,
  options: {
    visible?: boolean;
    keys?: Record<string, string | null>;
    intervalMs?: number;
  } = {},
) {
  let tick: (() => void) | null = null;
  const cancelled: unknown[] = [];
  const store = createHealthStore(client, {
    intervalMs: options.intervalMs,
    visible: () => options.visible ?? true,
    schedule: (fn) => {
      tick = fn;
      return "timer";
    },
    cancel: (timer) => {
      cancelled.push(timer);
    },
    loadKeys: async () => options.keys ?? { openai: "sk-test" },
  });
  return {
    store,
    fire: () => tick?.(),
    cancelled,
  };
}

describe("shared health store", () => {
  it("checks once on subscribe and fans the snapshot out to every subscriber", async () => {
    const { client, calls } = stubClient();
    const { store } = harness(client);
    const seen: string[] = [];
    const first = store.subscribe(() => seen.push(`first:${store.getSnapshot().agent.phase}`));
    const second = store.subscribe(() => seen.push(`second:${store.getSnapshot().agent.phase}`));

    await vi.waitFor(() => expect(store.getSnapshot().agent.phase).toBe("up"));
    expect(calls.health).toBe(2);
    expect(store.getSnapshot().sidecar).toMatchObject({ phase: "up" });
    expect(seen).toEqual(["first:up", "second:up"]);

    first();
    second();
  });

  it("runs one interval check for all subscribers, not one each", async () => {
    const { client, calls } = stubClient();
    const { store, fire } = harness(client);
    store.subscribe(() => {});
    store.subscribe(() => {});
    await vi.waitFor(() => expect(store.getSnapshot().agent.phase).toBe("up"));

    fire();
    await vi.waitFor(() => expect(calls.health).toBe(4));
  });

  it("skips ticks while the window is hidden", async () => {
    const { client, calls } = stubClient();
    const { store, fire } = harness(client, { visible: false });
    const stop = store.subscribe(() => {});
    // Mount still checks once; only the interval ticks are gated.
    await vi.waitFor(() => expect(store.getSnapshot().agent.phase).toBe("up"));
    expect(calls.health).toBe(2);
    fire();
    fire();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.health).toBe(2);
    stop();
  });

  it("marks a service down with the plain error", async () => {
    const { client } = stubClient({
      agentHealth: async () => {
        throw new ServiceError("agent", "agent is unreachable at http://127.0.0.1:8787/health");
      },
    });
    const { store } = harness(client);
    store.subscribe(() => {});
    await vi.waitFor(() => expect(store.getSnapshot().agent.phase).toBe("down"));
    expect(store.getSnapshot().agent).toMatchObject({
      phase: "down",
      message: "agent is unreachable at http://127.0.0.1:8787/health",
    });
    expect(store.getSnapshot().sidecar.phase).toBe("up");
  });

  it("pushes keys once until they change", async () => {
    const { client, calls } = stubClient();
    let keys: Record<string, string | null> = { openai: "sk-one" };
    let tick: (() => void) | null = null;
    const store = createHealthStore(client, {
      schedule: (fn) => {
        tick = fn;
        return "timer";
      },
      loadKeys: async () => keys,
    });
    const fire = () => tick?.();
    store.subscribe(() => {});
    await vi.waitFor(() => expect(calls.keys).toBe(1));

    fire();
    await vi.waitFor(() => expect(calls.health).toBe(4));
    await vi.waitFor(() => expect(store.getSnapshot().agent.phase).toBe("up"));
    fire();
    await vi.waitFor(() => expect(calls.health).toBe(6));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.keys).toBe(1);

    keys = { openai: "sk-two" };
    fire();
    await vi.waitFor(() => expect(calls.keys).toBe(2));
    expect(calls.pushed[1]).toEqual({ openai: "sk-two" });
  });

  it("never pushes when no key is set", async () => {
    const { client, calls } = stubClient();
    const { store } = harness(client, { keys: { openai: null } });
    store.subscribe(() => {});
    await vi.waitFor(() => expect(calls.health).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.keys).toBe(0);
  });

  it("refresh checks on demand", async () => {
    const { client, calls } = stubClient();
    const { store } = harness(client, { intervalMs: 0 });
    store.subscribe(() => {});
    await vi.waitFor(() => expect(store.getSnapshot().agent.phase).toBe("up"));
    store.refresh();
    await vi.waitFor(() => expect(calls.health).toBe(4));
  });
});
