import { describe, expect, it, vi } from "vitest";
import {
  createServicesClient,
  ServiceError,
  type FetchFn,
} from "./client";

type StubResponse = { ok: boolean; status: number; payload: unknown };

function stubFetch(responses: StubResponse[] | ((url: string) => StubResponse)): FetchFn {
  const calls: string[] = [];
  const fn = (async (input: string) => {
    calls.push(input);
    const next =
      typeof responses === "function" ? responses(input) : (responses.shift() ?? responses[0]);
    if (!next) throw new Error("no stubbed response left");
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.payload,
    };
  }) as FetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const AGENT_HEALTH = {
  service: "agent",
  ok: true,
  tools: [{ name: "sam3_mask", summary: "mattes", destructive: false }],
  models: { edit: "test-model" },
};

const SIDECAR_HEALTH = {
  service: "sidecar",
  ok: true,
  device: "cpu",
  jobs: ["proxy"],
  sam3_runner: false,
  sam_audio_runner: false,
};

describe("agent health", () => {
  it("reads the agent health payload", async () => {
    const fetchFn = stubFetch([{ ok: true, status: 200, payload: AGENT_HEALTH }]);
    const client = createServicesClient({ fetchFn });
    const health = await client.agentHealth();
    expect(health.service).toBe("agent");
    expect(health.tools).toHaveLength(1);
  });

  it("reports the agent as unreachable when fetch throws", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const client = createServicesClient({ fetchFn });
    await expect(client.agentHealth()).rejects.toMatchObject({
      name: "ServiceError",
      service: "agent",
    });
  });
});

describe("agent jobs", () => {
  const handle = {
    request_id: "req_1",
    status: "queued",
    status_url: "http://127.0.0.1:8787/jobs/req_1",
    cancel_url: "http://127.0.0.1:8787/jobs/req_1/cancel",
    expires_at: null,
  };

  function jobBody(status: string, extra: Record<string, unknown> = {}) {
    return {
      request_id: "req_1",
      task: "edit",
      input: { brief: "trim the pause" },
      status,
      created_at: "2026-10-31T00:00:00Z",
      artifacts: [],
      changeset: null,
      status_url: "http://127.0.0.1:8787/jobs/req_1",
      cancel_url: "http://127.0.0.1:8787/jobs/req_1/cancel",
      ...extra,
    };
  }

  it("submits a job, polls it to done, and surfaces the result", async () => {
    const fetchFn = stubFetch([
      { ok: true, status: 200, payload: handle },
      { ok: true, status: 200, payload: jobBody("queued") },
      { ok: true, status: 200, payload: jobBody("in_progress") },
      {
        ok: true,
        status: 200,
        payload: jobBody("completed", {
          artifacts: [{ url: "file:///tmp/preview.mp4", content_type: "video/mp4" }],
          changeset: { status: "proposed", ops: [{ op: "remove_clip" }] },
        }),
      },
    ]);
    const client = createServicesClient({ fetchFn });
    const submitted = await client.submitAgentJob("edit", { brief: "trim the pause" });
    expect(submitted.request_id).toBe("req_1");

    const seen: string[] = [];
    const finished = await client.pollAgentJob("req_1", {
      delayForAttempt: () => 0,
      onUpdate: (job) => seen.push(job.status),
    });
    expect(finished.status).toBe("completed");
    expect(finished.artifacts).toHaveLength(1);
    expect(finished.changeset?.status).toBe("proposed");
    expect(seen).toEqual(["queued", "in_progress", "completed"]);
  });

  it("surfaces a failed job with its error", async () => {
    const fetchFn = stubFetch([
      { ok: true, status: 200, payload: handle },
      { ok: true, status: 200, payload: jobBody("failed", { error: "ValueError: no brief" }) },
    ]);
    const client = createServicesClient({ fetchFn });
    await client.submitAgentJob("edit", {});
    const finished = await client.pollAgentJob("req_1", { delayForAttempt: () => 0 });
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("ValueError: no brief");
  });

  it("wraps agent error payloads with code and status", async () => {
    const fetchFn = stubFetch([
      {
        ok: false,
        status: 400,
        payload: { error: { code: "invalid_task", message: "task must be a non-empty string" } },
      },
    ]);
    const client = createServicesClient({ fetchFn });
    const failure = await client.submitAgentJob("", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceError);
    expect(failure).toMatchObject({ service: "agent", status: 400, code: "invalid_task" });
  });

  it("stops polling when aborted", async () => {
    const fetchFn = stubFetch([{ ok: true, status: 200, payload: jobBody("queued") }]);
    const client = createServicesClient({ fetchFn });
    const controller = new AbortController();
    const pending = client.pollAgentJob("req_1", {
      signal: controller.signal,
      delayForAttempt: () => 50,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("sidecar health", () => {
  it("reads the sidecar health payload", async () => {
    const fetchFn = stubFetch([{ ok: true, status: 200, payload: SIDECAR_HEALTH }]);
    const client = createServicesClient({ fetchFn });
    const health = await client.sidecarHealth();
    expect(health.service).toBe("sidecar");
    expect(health.sam3_runner).toBe(false);
  });
});

describe("sidecar jobs", () => {
  function sidecarBody(status: string, extra: Record<string, unknown> = {}) {
    return {
      id: "job_1",
      tool: "render_preview",
      kind: "proxy",
      status,
      progress: status === "done" ? 1 : 0.2,
      result: null,
      error: null,
      ...extra,
    };
  }

  it("submits a job, polls it to done, and surfaces the result", async () => {
    const fetchFn = stubFetch([
      { ok: true, status: 202, payload: sidecarBody("queued") },
      { ok: true, status: 200, payload: sidecarBody("running") },
      {
        ok: true,
        status: 200,
        payload: sidecarBody("done", { result: { proxy: "/tmp/preview.mp4" } }),
      },
    ]);
    const client = createServicesClient({ fetchFn });
    const created = await client.submitSidecarJob("render_preview", { source: "/tmp/in.mp4" });
    expect(created.id).toBe("job_1");
    const finished = await client.pollSidecarJob("job_1", { delayForAttempt: () => 0 });
    expect(finished.status).toBe("done");
    expect(finished.result).toEqual({ proxy: "/tmp/preview.mp4" });
  });

  it("wraps sidecar string errors", async () => {
    const fetchFn = stubFetch([{ ok: false, status: 404, payload: { error: "unknown tool" } }]);
    const client = createServicesClient({ fetchFn });
    const failure = await client
      .submitSidecarJob("nope", {})
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceError);
    expect(failure).toMatchObject({ service: "sidecar", status: 404 });
    expect((failure as ServiceError).message).toBe("unknown tool");
  });

  it("reports progress updates while polling", async () => {
    const fetchFn = stubFetch([
      { ok: true, status: 200, payload: sidecarBody("running", { progress: 0.2 }) },
      { ok: true, status: 200, payload: sidecarBody("running", { progress: 0.8 }) },
      { ok: true, status: 200, payload: sidecarBody("done") },
    ]);
    const client = createServicesClient({ fetchFn });
    const onUpdate = vi.fn();
    await client.pollSidecarJob("job_1", { delayForAttempt: () => 0, onUpdate });
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });
});
