import { describe, expect, it } from "vitest";
import type { FetchFn } from "@/lib/services/client";
import {
  applySound,
  isMissingRoute,
  revertSound,
  soundApplyErrorMessage,
  soundUndoErrorMessage,
} from "./sounds-api";

function reply(status: number, body: unknown): FetchFn {
  return async () => ({ ok: status < 400, status, json: async () => body });
}

const APPLIED = {
  timeline_name: "Demo Cut (sound copy)",
  original_timeline: "Demo Cut",
  tracks_added: 1,
  clips_added: 2,
  skipped: [{ intent: "duck", reason: "no dialogue regions" }],
  fallback: null,
};

describe("applySound", () => {
  it("posts the job id and reads the report", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return { ok: true, status: 200, json: async () => APPLIED };
    };
    const applied = await applySound({ jobId: "job-1" }, { fetchFn, agentUrl: "http://agent" });
    expect(seen).toMatchObject({ url: "http://agent/sounds/apply", body: { jobId: "job-1" } });
    expect(applied).toEqual({
      timelineName: "Demo Cut (sound copy)",
      originalTimeline: "Demo Cut",
      tracksAdded: 1,
      clipsAdded: 2,
      skipped: [{ intent: "duck", reason: "no dialogue regions" }],
      fallback: null,
    });
  });

  it("tolerates a missing original timeline and a fallback object", async () => {
    const fetchFn = reply(200, {
      ...APPLIED,
      original_timeline: null,
      fallback: { capability: "fairlightDucking", reason: "set the Fairlight ducking by hand" },
    });
    const applied = await applySound({ jobId: "job-1" }, { fetchFn });
    expect(applied.originalTimeline).toBeNull();
    expect(applied.fallback).toBe("set the Fairlight ducking by hand");
  });

  it("reads the plain-sentence error shape", async () => {
    const fetchFn = reply(400, { error: "no sound items in job job-1" });
    await expect(applySound({ jobId: "job-1" }, { fetchFn })).rejects.toMatchObject({
      message: "no sound items in job job-1",
      status: 400,
    });
  });

  it("also reads the agent's object error shape", async () => {
    const fetchFn = reply(503, {
      error: { code: "resolve_unavailable", message: "Resolve is not running" },
    });
    await expect(applySound({ jobId: "job-1" }, { fetchFn })).rejects.toMatchObject({
      message: "Resolve is not running",
      status: 503,
    });
  });

  it("rejects a payload with no timeline name", async () => {
    await expect(applySound({ jobId: "job-1" }, { fetchFn: reply(200, {}) })).rejects.toThrow(
      /malformed/,
    );
  });
});

describe("revertSound", () => {
  it("posts the original timeline and reads who is current", async () => {
    let seen: unknown = null;
    const fetchFn: FetchFn = async (_url, init) => {
      seen = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ timeline: "Demo Cut", project: "Captest" }),
      };
    };
    const reverted = await revertSound(
      { timeline: "Demo Cut (sound copy)", originalTimeline: "Demo Cut" },
      { fetchFn },
    );
    expect(seen).toMatchObject({ timeline: "Demo Cut (sound copy)", originalTimeline: "Demo Cut" });
    expect(reverted).toEqual({ timeline: "Demo Cut", project: "Captest" });
  });
});

describe("route-missing messages", () => {
  it("names the missing apply route plainly", async () => {
    const error = await applySound({ jobId: "job-1" }, { fetchFn: reply(404, {}) }).catch(
      (e: unknown) => e,
    );
    expect(isMissingRoute(error)).toBe(true);
    expect(soundApplyErrorMessage(error)).toBe("Sound apply isn't available on this agent yet.");
  });

  it("names the missing undo route plainly", async () => {
    const error = await revertSound(
      { originalTimeline: "Demo Cut" },
      { fetchFn: reply(404, {}) },
    ).catch((e: unknown) => e);
    expect(isMissingRoute(error)).toBe(true);
    expect(soundUndoErrorMessage(error)).toBe("Undo isn't available on this agent yet.");
  });

  it("passes real errors through", () => {
    expect(soundApplyErrorMessage(new Error("boom"))).toBe("boom");
    expect(isMissingRoute(new Error("boom"))).toBe(false);
  });
});
