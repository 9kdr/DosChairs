import { describe, expect, it } from "vitest";
import type { FetchFn } from "@/lib/services/client";
import {
  applyCut,
  cutApplyErrorMessage,
  cutUndoErrorMessage,
  isMissingRoute,
  revertCut,
} from "./cuts-api";

function reply(status: number, body: unknown): FetchFn {
  return async () => ({ ok: status < 400, status, json: async () => body });
}

const APPLIED = {
  timeline_name: "Demo Cut (cut copy)",
  original_timeline: "Demo Cut",
  tracks_added: 0,
  tracks_removed: 0,
  clips_added: 1,
  clips_removed: 0,
  clips_changed: 2,
  markers_added: 1,
  markers_removed: 0,
  skipped: [{ intent: "spd-1", reason: "retime the clip in Studio by hand" }],
  fallback: null,
};

describe("applyCut", () => {
  it("posts the job id and reads the report", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return { ok: true, status: 200, json: async () => APPLIED };
    };
    const applied = await applyCut({ jobId: "job-1" }, { fetchFn, agentUrl: "http://agent" });
    expect(seen).toMatchObject({ url: "http://agent/cuts/apply", body: { jobId: "job-1" } });
    expect(applied).toEqual({
      timelineName: "Demo Cut (cut copy)",
      originalTimeline: "Demo Cut",
      tracksAdded: 0,
      tracksRemoved: 0,
      clipsAdded: 1,
      clipsRemoved: 0,
      clipsChanged: 2,
      markersAdded: 1,
      markersRemoved: 0,
      skipped: [{ intent: "spd-1", reason: "retime the clip in Studio by hand" }],
      fallback: null,
    });
  });

  it("tolerates missing counts and a fallback object", async () => {
    const fetchFn = reply(200, {
      timeline_name: "Demo Cut (cut copy)",
      fallback: { capability: "speedChanges", reason: "retime the clip in Studio by hand" },
    });
    const applied = await applyCut({ jobId: "job-1" }, { fetchFn });
    expect(applied.originalTimeline).toBeNull();
    expect(applied.clipsChanged).toBe(0);
    expect(applied.fallback).toBe("retime the clip in Studio by hand");
  });

  it("reads the plain-sentence error shape", async () => {
    const fetchFn = reply(400, { error: "the request holds no cut items to apply" });
    await expect(applyCut({ jobId: "job-1" }, { fetchFn })).rejects.toMatchObject({
      message: "the request holds no cut items to apply",
      status: 400,
    });
  });

  it("rejects a payload with no timeline name", async () => {
    await expect(applyCut({ jobId: "job-1" }, { fetchFn: reply(200, {}) })).rejects.toThrow(
      /malformed/,
    );
  });
});

describe("revertCut", () => {
  it("posts the copy and original names the agent expects", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ current_timeline: "Demo Cut", deleted: false }),
      };
    };
    const reverted = await revertCut(
      { timeline: "Demo Cut (cut copy)", originalTimeline: "Demo Cut" },
      { fetchFn, agentUrl: "http://agent" },
    );
    expect(seen).toMatchObject({
      url: "http://agent/cuts/undo",
      body: {
        timeline_name: "Demo Cut (cut copy)",
        original_timeline: "Demo Cut",
      },
    });
    expect(reverted).toEqual({ timeline: "Demo Cut", deleted: false });
  });
});

describe("route-missing messages", () => {
  it("names the missing apply route plainly", async () => {
    const error = await applyCut({ jobId: "job-1" }, { fetchFn: reply(404, {}) }).catch(
      (e: unknown) => e,
    );
    expect(isMissingRoute(error)).toBe(true);
    expect(cutApplyErrorMessage(error)).toBe("Cut apply isn't available on this agent yet.");
  });

  it("names the missing undo route plainly", async () => {
    const error = await revertCut(
      { originalTimeline: "Demo Cut" },
      { fetchFn: reply(404, {}) },
    ).catch((e: unknown) => e);
    expect(isMissingRoute(error)).toBe(true);
    expect(cutUndoErrorMessage(error)).toBe("Undo isn't available on this agent yet.");
  });

  it("passes real errors through", () => {
    expect(cutApplyErrorMessage(new Error("boom"))).toBe("boom");
    expect(isMissingRoute(new Error("boom"))).toBe(false);
  });
});
