import { describe, expect, it } from "vitest";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { fetchProjectReview, LIVE_BASE_REVISION, reviewFromJson } from "./review";

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

const TIMELINE = {
  schemaVersion: "0.1.0",
  id: "tl-1",
  name: "Rough cut",
  rate: { num: 24, den: 1 },
  tracks: [
    {
      id: "v1",
      kind: "video",
      name: "V1",
      clips: [
        {
          id: "clip-1",
          name: "Interview",
          sourceRange: {
            start: { value: 100, rate: 24 },
            duration: { value: 96, rate: 24 },
          },
          timelineRange: {
            start: { value: 86400, rate: 24 },
            duration: { value: 48, rate: 24 },
          },
        },
      ],
    },
  ],
  markers: [],
};

const OP = {
  id: "item-1",
  op: "trim",
  targetId: "clip-1",
  rationale: "Trim the pause.",
  patch: { edge: "head", frames: 12 },
  status: "pending",
};

const JOB = { request_id: "req-1", task: "edit", finished_at: "2026-11-01T10:00:00.000Z" };

function bundle(changeset: unknown, job: unknown = JOB): unknown {
  return { project_id: "proj-1", timeline: TIMELINE, changeset, job };
}

describe("fetchProjectReview", () => {
  it("maps a proposal bundle to timeline, changeset, and job", async () => {
    const fetchFn = stubFetch([
      { ok: true, status: 200, payload: bundle({ status: "proposed", ops: [OP] }) },
    ]);
    const review = await fetchProjectReview("proj-1", { fetchFn });

    expect(review.kind).toBe("proposal");
    if (review.kind !== "proposal") return;
    expect(review.timeline.name).toBe("Rough cut");
    expect(review.changeset.id).toBe("cs-req-1");
    expect(review.changeset.baseRevision).toBe(LIVE_BASE_REVISION);
    expect(review.changeset.items).toHaveLength(1);
    expect(review.changeset.items[0]).toMatchObject({
      id: "item-1",
      op: "trim",
      targetId: "clip-1",
      rationale: "Trim the pause.",
      patch: { edge: "head", frames: 12 },
      status: "pending",
    });
    expect(review.job).toEqual(JOB);
  });

  it("requests the encoded project review path on the agent", async () => {
    const fetchFn = stubFetch([{ ok: true, status: 200, payload: bundle(null, null) }]);
    await fetchProjectReview("my project", { fetchFn });

    expect((fetchFn as unknown as { calls: string[] }).calls).toEqual([
      "http://127.0.0.1:8787/projects/my%20project/review",
    ]);
  });

  it("returns no proposal with the mirror when the changeset is null", async () => {
    const fetchFn = stubFetch([{ ok: true, status: 200, payload: bundle(null, null) }]);
    const review = await fetchProjectReview("proj-1", { fetchFn });

    expect(review).toEqual({ kind: "none", timeline: TIMELINE });
  });

  it("returns no proposal without a mirror on 404", async () => {
    const fetchFn = stubFetch([{ ok: false, status: 404, payload: null }]);
    const review = await fetchProjectReview("proj-1", { fetchFn });

    expect(review).toEqual({ kind: "none", timeline: null });
  });

  it("throws the agent's 503 message when Studio is closed", async () => {
    const fetchFn = stubFetch([
      {
        ok: false,
        status: 503,
        payload: {
          error: {
            code: "resolve_unavailable",
            message: "DaVinci Resolve Studio is closed. Open Resolve Studio and try again.",
          },
        },
      },
    ]);

    await expect(fetchProjectReview("proj-1", { fetchFn })).rejects.toMatchObject({
      name: "ServiceError",
      service: "agent",
      status: 503,
      code: "resolve_unavailable",
      message: "DaVinci Resolve Studio is closed. Open Resolve Studio and try again.",
    });
  });

  it("throws a ServiceError when the agent is unreachable", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(fetchProjectReview("proj-1", { fetchFn })).rejects.toMatchObject({
      name: "ServiceError",
      service: "agent",
      status: undefined,
    });
  });

  it("rethrows aborts instead of wrapping them", async () => {
    const fetchFn: FetchFn = async () => {
      throw new DOMException("aborted", "AbortError");
    };

    await expect(fetchProjectReview("proj-1", { fetchFn })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("reviewFromJson", () => {
  it("rejects a non-object bundle", () => {
    expect(() => reviewFromJson(null)).toThrowError(ServiceError);
    expect(() => reviewFromJson([])).toThrowError(ServiceError);
  });

  it("rejects a timeline without tracks and markers", () => {
    expect(() => reviewFromJson({ timeline: { tracks: [] } })).toThrowError(/tracks and markers/);
  });

  it("rejects a changeset without ops", () => {
    expect(() => reviewFromJson(bundle({ status: "proposed" }))).toThrowError(/needs ops/);
  });

  it("rejects a proposal without its job", () => {
    expect(() => reviewFromJson(bundle({ status: "proposed", ops: [OP] }, null))).toThrowError(
      /needs its job/,
    );
  });

  it("rejects a proposal with no items", () => {
    expect(() => reviewFromJson(bundle({ status: "proposed", ops: [] }))).toThrowError(/no items/);
  });

  it("rejects items missing id, op, or rationale", () => {
    expect(() =>
      reviewFromJson(bundle({ status: "proposed", ops: [{ id: "item-1" }] })),
    ).toThrowError(/id, op, and rationale/);
  });

  it("rejects unknown ops instead of crashing the diff", () => {
    expect(() =>
      reviewFromJson(bundle({ status: "proposed", ops: [{ ...OP, op: "teleport" }] })),
    ).toThrowError(/unknown op teleport/);
  });

  it("defaults unexpected item status to pending", () => {
    const review = reviewFromJson(
      bundle({ status: "proposed", ops: [{ ...OP, status: "archived" }] }),
    );
    expect(review.kind).toBe("proposal");
    if (review.kind !== "proposal") return;
    expect(review.changeset.items[0]?.status).toBe("pending");
  });

  it("parses a fallback capability and reason on the item", () => {
    const review = reviewFromJson(
      bundle({
        status: "proposed",
        ops: [
          {
            ...OP,
            op: "add_effect",
            fallback: {
              capability: "fusionComps",
              reason: "Resolve can't place this directly — pre-rendered clip instead",
            },
          },
        ],
      }),
    );
    expect(review.kind).toBe("proposal");
    if (review.kind !== "proposal") return;
    expect(review.changeset.items[0]?.fallback).toEqual({
      capability: "fusionComps",
      reason: "Resolve can't place this directly — pre-rendered clip instead",
    });
  });

  it("leaves items without a fallback alone", () => {
    const review = reviewFromJson(bundle({ status: "proposed", ops: [OP] }));
    expect(review.kind).toBe("proposal");
    if (review.kind !== "proposal") return;
    expect(review.changeset.items[0]?.fallback).toBeUndefined();
  });

  it("rejects a fallback without a capability and reason", () => {
    expect(() =>
      reviewFromJson(
        bundle({
          status: "proposed",
          ops: [{ ...OP, fallback: { capability: "fusionComps" } }],
        }),
      ),
    ).toThrowError(/without capability and reason/);
    expect(() =>
      reviewFromJson(
        bundle({
          status: "proposed",
          ops: [{ ...OP, fallback: { capability: "fusionComps", reason: "" } }],
        }),
      ),
    ).toThrowError(/without capability and reason/);
  });
});
