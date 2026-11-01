import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * Live health for both services. Refreshes on mount, on demand, and on an
 * interval while mounted. States come only from real fetches.
 */
export function useServiceHealth(options: ServicesOptions & { intervalMs?: number } = {}): HealthSnapshot {
  const { intervalMs = 15000, ...clientOptions } = options;
  const client = useServicesClient(clientOptions);
  const [agent, setAgent] = useState<ServiceState>({ phase: "checking" });
  const [sidecar, setSidecar] = useState<ServiceState>({ phase: "checking" });
  const [agentHealth, setAgentHealth] = useState<AgentHealth | undefined>(undefined);
  const [sidecarHealth, setSidecarHealth] = useState<SidecarHealth | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let live = true;

    async function check() {
      const [agentResult, sidecarResult] = await Promise.allSettled([
        client.agentHealth({ signal }),
        client.sidecarHealth({ signal }),
      ]);
      if (!live || signal.aborted) return;
      if (agentResult.status === "fulfilled") {
        setAgentHealth(agentResult.value);
        setAgent({ phase: "up", checkedAt: Date.now() });
        void getDefaultSettingsStore()
          .load()
          .then((stored) => {
            if (Object.values(stored.keys).some((k) => k != null)) {
              void client.setAgentKeys(stored.keys, { signal }).catch(() => {});
            }
          })
          .catch(() => {});
      } else {
        setAgent({
          phase: "down",
          checkedAt: Date.now(),
          message: describe(agentResult.reason),
        });
      }
      if (sidecarResult.status === "fulfilled") {
        setSidecarHealth(sidecarResult.value);
        setSidecar({ phase: "up", checkedAt: Date.now() });
      } else {
        setSidecar({
          phase: "down",
          checkedAt: Date.now(),
          message: describe(sidecarResult.reason),
        });
      }
    }

    void check();
    const timer = intervalMs > 0 ? window.setInterval(() => void check(), intervalMs) : 0;
    return () => {
      live = false;
      controller.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [client, intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((current) => current + 1), []);

  return useMemo(
    () => ({ agent, sidecar, agentHealth, sidecarHealth, refresh }),
    [agent, sidecar, agentHealth, sidecarHealth, refresh],
  );
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
