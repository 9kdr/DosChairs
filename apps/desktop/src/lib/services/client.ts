/**
 * The link to the agent and the sidecar: health, job submit, poll, result.
 * Task threads (issue #61) ride on this client. Reads stay read-only; job
 * submission is the one write, and finished jobs only carry proposals.
 */
import { agentBaseUrl, sidecarBaseUrl } from "./config";
import {
  isAgentTerminal,
  isSidecarTerminal,
  type AgentHealth,
  type AgentJob,
  type AgentJobHandle,
  type SidecarHealth,
  type SidecarJob,
} from "./types";

export class ServiceError extends Error {
  readonly service: "agent" | "sidecar";
  readonly status?: number;
  readonly code?: string;

  constructor(
    service: "agent" | "sidecar",
    message: string,
    options?: { status?: number; code?: string },
  ) {
    super(message);
    this.name = "ServiceError";
    this.service = service;
    this.status = options?.status;
    this.code = options?.code;
  }
}

export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

type FetchLike = typeof fetch;

export type ClientOptions = {
  agentUrl?: string;
  sidecarUrl?: string;
  /** Injected for tests; defaults to window fetch. */
  fetchFn?: FetchFn;
};

export type SubmitAgentOptions = {
  idempotencyKey?: string;
  /** Retried submits reuse the first job instead of queuing a duplicate. */
  signal?: AbortSignal;
};

export type PollOptions = {
  signal?: AbortSignal;
  /** Milliseconds to wait after attempt n (0-based). Defaults to 2s doubling, 10s cap. */
  delayForAttempt?: (attempt: number) => number;
};

export function defaultPollDelay(attempt: number): number {
  return Math.min(2000 * 2 ** Math.max(attempt, 0), 10000);
}

const TERMINAL_POLL_ATTEMPTS = 120;

async function readJson(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function agentErrorMessage(payload: unknown, status: number): { code?: string; message: string } {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const record = error as { code?: unknown; message?: unknown };
      return {
        code: typeof record.code === "string" ? record.code : undefined,
        message:
          typeof record.message === "string" ? record.message : `agent failed (${status})`,
      };
    }
  }
  return { message: `agent failed (${status})` };
}

function sidecarErrorMessage(payload: unknown, status: number): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return `sidecar failed (${status})`;
}

export type ServicesClient = {
  agentHealth: (options?: { signal?: AbortSignal }) => Promise<AgentHealth>;
  setAgentKeys: (
    keys: Record<string, string | null>,
    options?: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean; keys_configured?: Record<string, boolean> }>;
  submitAgentJob: (
    task: string,
    input?: Record<string, unknown>,
    options?: SubmitAgentOptions,
  ) => Promise<AgentJobHandle>;
  agentJob: (requestId: string, options?: { signal?: AbortSignal }) => Promise<AgentJob>;
  pollAgentJob: (
    requestId: string,
    options?: PollOptions & { onUpdate?: (job: AgentJob) => void },
  ) => Promise<AgentJob>;
  cancelAgentJob: (requestId: string, options?: { signal?: AbortSignal }) => Promise<AgentJob>;
  sidecarHealth: (options?: { signal?: AbortSignal }) => Promise<SidecarHealth>;
  submitSidecarJob: (
    tool: string,
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<SidecarJob>;
  sidecarJob: (jobId: string, options?: { signal?: AbortSignal }) => Promise<SidecarJob>;
  pollSidecarJob: (
    jobId: string,
    options?: PollOptions & { onUpdate?: (job: SidecarJob) => void },
  ) => Promise<SidecarJob>;
};

export function createServicesClient(options: ClientOptions = {}): ServicesClient {
  const agent = agentBaseUrl(options.agentUrl);
  const sidecar = sidecarBaseUrl(options.sidecarUrl);
  const fetchJson: FetchLike | FetchFn = options.fetchFn ?? fetch;

  async function request(
    service: "agent" | "sidecar",
    url: string,
    init?: RequestInit,
  ): Promise<unknown> {
    let response: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      response = await fetchJson(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ServiceError(service, `${service} is unreachable at ${url}`);
    }
    const payload = await readJson(response);
    if (!response.ok) {
      if (service === "agent") {
        const { code, message } = agentErrorMessage(payload, response.status);
        throw new ServiceError(service, message, { status: response.status, code });
      }
      throw new ServiceError(service, sidecarErrorMessage(payload, response.status), {
        status: response.status,
      });
    }
    return payload;
  }

  function wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("polling aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("polling aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  const client: ServicesClient = {
    async agentHealth({ signal } = {}) {
      return (await request("agent", `${agent}/health`, { signal })) as AgentHealth;
    },

    async setAgentKeys(keys, { signal } = {}) {
      return (await request("agent", `${agent}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys }),
        signal,
      })) as { ok: boolean; keys_configured?: Record<string, boolean> };
    },

    async submitAgentJob(task, input = {}, { idempotencyKey, signal } = {}) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      return (await request("agent", `${agent}/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task, input }),
        signal,
      })) as AgentJobHandle;
    },

    async agentJob(requestId, { signal } = {}) {
      return (await request(
        "agent",
        `${agent}/jobs/${encodeURIComponent(requestId)}`,
        { signal },
      )) as AgentJob;
    },

    async pollAgentJob(requestId, { signal, delayForAttempt, onUpdate } = {}) {
      const delay = delayForAttempt ?? defaultPollDelay;
      for (let attempt = 0; attempt < TERMINAL_POLL_ATTEMPTS; attempt += 1) {
        const job = await client.agentJob(requestId, { signal });
        onUpdate?.(job);
        if (isAgentTerminal(job.status)) return job;
        await wait(delay(attempt), signal);
      }
      throw new ServiceError("agent", `job ${requestId} did not finish in time`);
    },

    async cancelAgentJob(requestId, { signal } = {}) {
      return (await request(
        "agent",
        `${agent}/jobs/${encodeURIComponent(requestId)}/cancel`,
        { method: "POST", signal },
      )) as AgentJob;
    },

    async sidecarHealth({ signal } = {}) {
      return (await request("sidecar", `${sidecar}/health`, { signal })) as SidecarHealth;
    },

    async submitSidecarJob(tool, body, { signal } = {}) {
      return (await request("sidecar", `${sidecar}/jobs/${encodeURIComponent(tool)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      })) as SidecarJob;
    },

    async sidecarJob(jobId, { signal } = {}) {
      return (await request(
        "sidecar",
        `${sidecar}/jobs/${encodeURIComponent(jobId)}`,
        { signal },
      )) as SidecarJob;
    },

    async pollSidecarJob(jobId, { signal, delayForAttempt, onUpdate } = {}) {
      const delay = delayForAttempt ?? defaultPollDelay;
      for (let attempt = 0; attempt < TERMINAL_POLL_ATTEMPTS; attempt += 1) {
        const job = await client.sidecarJob(jobId, { signal });
        onUpdate?.(job);
        if (isSidecarTerminal(job.status)) return job;
        await wait(delay(attempt), signal);
      }
      throw new ServiceError("sidecar", `job ${jobId} did not finish in time`);
    },
  };

  return client;
}
