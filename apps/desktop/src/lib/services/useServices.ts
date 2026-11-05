import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isWindowVisible, onWindowVisible, startPolling, type Poller } from "@/lib/poll";
import { getDefaultSettingsStore } from "@/settings/settings-store";
import { createServicesClient, ServiceError, type ServicesClient } from "./client";
import type {
  AgentHealth,
  AgentJob,
  SidecarHealth,
  SidecarJob,
  ServiceState,
} from "./types";

export type ServicesOptions = {
  agentUrl?: string;
  sidecarUrl?: string;
};

export function useServicesClient(options: ServicesOptions = {}): ServicesClient {
  const { agentUrl, sidecarUrl } = options;
  return useMemo(
    () => createServicesClient({ agentUrl, sidecarUrl }),
    [agentUrl, sidecarUrl],
  );
}

export type HealthSnapshot = {
  agent: ServiceState;
  sidecar: ServiceState;
  agentHealth?: AgentHealth;
  sidecarHealth?: SidecarHealth;
  refresh: () => void;
};

export type HealthState = {
  agent: ServiceState;
  sidecar: ServiceState;
  agentHealth?: AgentHealth;
  sidecarHealth?: SidecarHealth;
};

export type HealthStoreOptions = {
  intervalMs?: number;
  /** Seams for tests; the window uses the real visibility and timers. */
  visible?: () => boolean;
  schedule?: (tick: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
  loadKeys?: () => Promise<Record<string, string | null>>;
};

export type HealthStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HealthState;
  refresh: () => void;
};

const CHECKING: HealthState = {
  agent: { phase: "checking" },
  sidecar: { phase: "checking" },
};

/**
 * One shared health check for every hook instance on the same services:
 * one interval, one in-flight check, and one keys push per change. The
 * interval skips ticks while the window is hidden and rechecks when it
 * returns; subscribers only re-render when a check lands.
 */
export function createHealthStore(
  client: ServicesClient,
  options: HealthStoreOptions = {},
): HealthStore {
  const {
    intervalMs = 15000,
    visible = isWindowVisible,
    schedule,
    cancel,
    loadKeys = () =>
      getDefaultSettingsStore()
        .load()
        .then((stored) => stored.keys),
  } = options;
  let snapshot: HealthState = CHECKING;
  const listeners = new Set<() => void>();
  let poller: Poller | null = null;
  let stopWatching: (() => void) | null = null;
  let inFlight = false;
  let pushing = false;
  let lastKeysJson: string | null = null;

  function emit(next: HealthState): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  async function pushKeysIfChanged(): Promise<void> {
    if (pushing) return;
    pushing = true;
    try {
      let keys: Record<string, string | null>;
      try {
        keys = await loadKeys();
      } catch {
        return;
      }
      if (!Object.values(keys).some((key) => key != null)) return;
      const json = JSON.stringify(keys);
      if (json === lastKeysJson) return;
      try {
        await client.setAgentKeys(keys);
      } catch {
        return;
      }
      lastKeysJson = json;
    } finally {
      pushing = false;
    }
  }

  async function check(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const [agentResult, sidecarResult] = await Promise.allSettled([
        client.agentHealth(),
        client.sidecarHealth(),
      ]);
      const checkedAt = Date.now();
      const next: HealthState = {
        agent:
          agentResult.status === "fulfilled"
            ? { phase: "up", checkedAt }
            : { phase: "down", checkedAt, message: describe(agentResult.reason) },
        sidecar:
          sidecarResult.status === "fulfilled"
            ? { phase: "up", checkedAt }
            : { phase: "down", checkedAt, message: describe(sidecarResult.reason) },
        agentHealth: agentResult.status === "fulfilled" ? agentResult.value : undefined,
        sidecarHealth: sidecarResult.status === "fulfilled" ? sidecarResult.value : undefined,
      };
      emit(next);
      // Fire and forget like before: the snapshot never waits on the push,
      // and a changed key mid-push retries on the next check.
      if (agentResult.status === "fulfilled") void pushKeysIfChanged();
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (poller) return;
    void check();
    if (intervalMs > 0) {
      poller = startPolling(() => void check(), { intervalMs, visible, schedule, cancel });
      stopWatching = onWindowVisible(() => void check());
    }
  }

  function stop(): void {
    if (listeners.size > 0 || !poller) return;
    poller.stop();
    poller = null;
    stopWatching?.();
    stopWatching = null;
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    getSnapshot: () => snapshot,
    refresh: () => void check(),
  };
}

const healthStores = new Map<string, HealthStore>();

/** Test support: drop shared stores so each test starts unpolled. */
export function resetHealthStores(): void {
  healthStores.clear();
}

function getHealthStore(client: ServicesClient, key: string, intervalMs: number): HealthStore {
  let store = healthStores.get(key);
  if (!store) {
    store = createHealthStore(client, { intervalMs });
    healthStores.set(key, store);
  }
  return store;
}

/**
 * Live health for both services. Refreshes on mount, on demand, and on an
 * interval while mounted. Every mounted instance shares one poller per
 * service pair, so the header dot and the composer check once together.
 * States come only from real fetches.
 */
export function useServiceHealth(
  options: ServicesOptions & { intervalMs?: number } = {},
): HealthSnapshot {
  const { intervalMs = 15000, ...clientOptions } = options;
  const client = useServicesClient(clientOptions);
  const key = useMemo(
    () => `${clientOptions.agentUrl ?? ""}│${clientOptions.sidecarUrl ?? ""}│${intervalMs}`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, intervalMs],
  );
  const store = useMemo(() => getHealthStore(client, key, intervalMs), [client, key, intervalMs]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const refresh = useMemo(() => store.refresh, [store]);
  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}

function describe(reason: unknown): string {
  if (reason instanceof ServiceError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return "unreachable";
}

export type AgentJobRun = {
  job?: AgentJob;
  phase: "idle" | "submitted" | "done" | "error";
  error?: string;
  submit: (task: string, input?: Record<string, unknown>) => void;
  reset: () => void;
};

/**
 * Submit one agent job and poll it to a terminal state, surfacing the
 * result (artifacts plus any proposed edit) or the failure. One run at a
 * time; a new submit replaces the old run.
 */
export function useAgentJob(clientOptions: ServicesOptions = {}): AgentJobRun {
  const client = useServicesClient(clientOptions);
  const [job, setJob] = useState<AgentJob | undefined>(undefined);
  const [phase, setPhase] = useState<AgentJobRun["phase"]>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const runRef = useRef(0);

  const submit = useCallback(
    (task: string, input: Record<string, unknown> = {}) => {
      const run = runRef.current + 1;
      runRef.current = run;
      setJob(undefined);
      setError(undefined);
      setPhase("submitted");
      void (async () => {
        try {
          const handle = await client.submitAgentJob(task, input);
          const finished = await client.pollAgentJob(handle.request_id, {
            onUpdate: (current) => {
              if (runRef.current === run) setJob(current);
            },
          });
          if (runRef.current !== run) return;
          setJob(finished);
          if (finished.status === "completed") {
            setPhase("done");
          } else {
            setError(finished.error ?? `job ${finished.status}`);
            setPhase("error");
          }
        } catch (reason) {
          if (runRef.current !== run) return;
          if (reason instanceof Error && reason.name === "AbortError") return;
          setError(describe(reason));
          setPhase("error");
        }
      })();
    },
    [client],
  );

  const reset = useCallback(() => {
    runRef.current += 1;
    setJob(undefined);
    setError(undefined);
    setPhase("idle");
  }, []);

  return useMemo(() => ({ job, phase, error, submit, reset }), [job, phase, error, submit, reset]);
}

export type SidecarJobRun = {
  job?: SidecarJob;
  phase: "idle" | "submitted" | "done" | "error";
  error?: string;
  submit: (tool: string, body: Record<string, unknown>) => void;
  reset: () => void;
};

/** Same shape as {@link useAgentJob}, for sidecar media jobs. */
export function useSidecarJob(clientOptions: ServicesOptions = {}): SidecarJobRun {
  const client = useServicesClient(clientOptions);
  const [job, setJob] = useState<SidecarJob | undefined>(undefined);
  const [phase, setPhase] = useState<SidecarJobRun["phase"]>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const runRef = useRef(0);

  const submit = useCallback(
    (tool: string, body: Record<string, unknown>) => {
      const run = runRef.current + 1;
      runRef.current = run;
      setJob(undefined);
      setError(undefined);
      setPhase("submitted");
      void (async () => {
        try {
          const created = await client.submitSidecarJob(tool, body);
          const finished = await client.pollSidecarJob(created.id, {
            onUpdate: (current) => {
              if (runRef.current === run) setJob(current);
            },
          });
          if (runRef.current !== run) return;
          setJob(finished);
          if (finished.status === "done") {
            setPhase("done");
          } else {
            setError(finished.error ?? `job ${finished.status}`);
            setPhase("error");
          }
        } catch (reason) {
          if (runRef.current !== run) return;
          if (reason instanceof Error && reason.name === "AbortError") return;
          setError(describe(reason));
          setPhase("error");
        }
      })();
    },
    [client],
  );

  const reset = useCallback(() => {
    runRef.current += 1;
    setJob(undefined);
    setError(undefined);
    setPhase("idle");
  }, []);

  return useMemo(() => ({ job, phase, error, submit, reset }), [job, phase, error, submit, reset]);
}
