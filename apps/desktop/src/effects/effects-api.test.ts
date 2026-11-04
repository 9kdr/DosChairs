import { describe, expect, it } from "vitest";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import {
  applyPiece,
  generateEffect,
  isClipGoneError,
  isPieceFallback,
  pieceUndoErrorMessage,
  revertPiece,
  sampleEffect,
  verifyEffect,
} from "./effects-api";

const input = { prompt: "bouncy", canvas: { width: 1920, height: 1080 }, fps: 30, durationSec: 3 };

function reply(status: number, body: unknown): FetchFn {
  return async () => ({ ok: status < 400, status, json: async () => body });
}

describe("generateEffect", () => {
  it("posts the brief and returns id, spec and notes", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return { ok: true, status: 200, json: async () => ({ id: "fx-1", spec: sampleEffect(), notes: "Drafted." }) };
    };
    const made = await generateEffect({ ...input, referenceImage: "data:image/png;base64,AA" }, { fetchFn, agentUrl: "http://agent" });
    expect(made).toMatchObject({ id: "fx-1", notes: "Drafted." });
    expect(seen).toMatchObject({ url: "http://agent/effects/generate", body: { prompt: "bouncy", referenceImage: "data:image/png;base64,AA" } });
  });

  it("sends references only when the brief has chips", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({ id: "fx-1", spec: sampleEffect() }) };
    };
    await generateEffect({ ...input, references: [{ id: "macro:user:title:lower", label: "My Lower Third" }] }, { fetchFn });
    await generateEffect({ ...input, references: [] }, { fetchFn });
    expect(bodies[0]!.references).toEqual([{ id: "macro:user:title:lower", label: "My Lower Third" }]);
    expect(bodies[1]).not.toHaveProperty("references");
  });

  it("carries the agent's plain message and status", async () => {
    const fetchFn = reply(502, { error: { code: "invalid_effect", message: "effect generate needs a model" } });
    await expect(generateEffect(input, { fetchFn })).rejects.toMatchObject({ message: "effect generate needs a model", status: 502 });
  });

  it("says the agent is unreachable when fetch fails", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("failed");
    };
    const error = await generateEffect(input, { fetchFn, agentUrl: "http://agent" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBeUndefined();
    expect((error as ServiceError).message).toContain("unreachable");
  });

  it("rejects a payload with no spec", async () => {
    await expect(generateEffect(input, { fetchFn: reply(200, { id: "fx" }) })).rejects.toThrow(/malformed/);
  });
});

describe("verifyEffect", () => {
  it("returns the verdict and the revised spec on a fail", async () => {
    const fetchFn = reply(200, { pass: false, notes: "glow overdone", revisedSpec: sampleEffect() });
    const verdict = await verifyEffect("fx-1", { previewPng: "data:image/png;base64,AA" }, { fetchFn });
    expect(verdict.pass).toBe(false);
    expect(verdict.notes).toBe("glow overdone");
    expect(verdict.revisedSpec?.id).toBe("bounce-title");
  });
});

describe("applyPiece", () => {
  const baked = { title: { x: [{ time: 0, value: 960 }] } };

  it("posts spec, baked curves and clip position, and reads the comp names", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          effect_id: "bounce-title",
          comp_name: "Comp 2",
          prev_comp_name: "Comp 1",
          paths: { title: "Text1" },
          keyframes: 1,
          project: "Captest",
          timeline: "Timeline 1",
          undo: { prev_comp_name: "Comp 1" },
        }),
      };
    };
    const result = await applyPiece(
      { spec: sampleEffect(), baked, trackIndex: 1, clipIndex: 0 },
      { fetchFn, agentUrl: "http://agent" },
    );
    expect(seen).toMatchObject({
      url: "http://agent/effects/rig/apply",
      body: { baked, trackIndex: 1, clipIndex: 0 },
    });
    expect((seen!.body as Record<string, unknown>).spec).toMatchObject({ id: "bounce-title" });
    expect(isPieceFallback(result)).toBe(false);
    if (!isPieceFallback(result)) {
      expect(result).toMatchObject({ compName: "Comp 2", prevCompName: "Comp 1", keyframes: 1 });
    }
  });

  it("sends effectId instead of a spec when that is all it has", async () => {
    let seen: unknown = null;
    const fetchFn: FetchFn = async (_url, init) => {
      seen = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ effect_id: "fx-9", comp_name: "Comp 1" }) };
    };
    await applyPiece({ effectId: "fx-9", trackIndex: 2, clipIndex: 3, trackType: "video" }, { fetchFn });
    expect(seen).toMatchObject({ effectId: "fx-9", trackIndex: 2, clipIndex: 3 });
    expect(seen).not.toHaveProperty("spec");
    expect(seen).not.toHaveProperty("baked");
  });

  it("returns the fallback with its plain reason", async () => {
    const fetchFn = reply(200, {
      effect_id: "bounce-title",
      fallback: { capability: "fusionMacro", reason: "a shader layer needs footage" },
      project: "Captest",
      timeline: "Timeline 1",
    });
    const result = await applyPiece({ spec: sampleEffect(), trackIndex: 1, clipIndex: 0 }, { fetchFn });
    expect(isPieceFallback(result)).toBe(true);
    if (isPieceFallback(result)) {
      expect(result.fallback.reason).toBe("a shader layer needs footage");
    }
  });

  it("carries the agent's plain error and status", async () => {
    const fetchFn = reply(502, { error: { code: "resolve_failed", message: "add_effect failed: no" } });
    await expect(applyPiece({ spec: sampleEffect(), trackIndex: 1, clipIndex: 0 }, { fetchFn })).rejects.toMatchObject({
      message: "add_effect failed: no",
      status: 502,
    });
  });

  it("rejects a payload with no effect id", async () => {
    await expect(
      applyPiece({ spec: sampleEffect(), trackIndex: 1, clipIndex: 0 }, { fetchFn: reply(200, {}) }),
    ).rejects.toThrow(/malformed/);
  });
});

describe("revertPiece", () => {
  it("posts the previous comp name", async () => {
    let seen: unknown = null;
    const fetchFn: FetchFn = async (_url, init) => {
      seen = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ comp_name: "Comp 1" }) };
    };
    const reverted = await revertPiece({ toComp: "Comp 1", trackIndex: 1, clipIndex: 0 }, { fetchFn });
    expect(seen).toMatchObject({ toComp: "Comp 1", trackIndex: 1, clipIndex: 0 });
    expect(reverted.compName).toBe("Comp 1");
  });

  it("names the missing undo route plainly", async () => {
    const error = await revertPiece({ toComp: "Comp 1" }, { fetchFn: reply(404, {}) }).catch((e: unknown) => e);
    expect(pieceUndoErrorMessage(error)).toBe("Undo isn't available on this agent yet.");
  });
});

describe("isClipGoneError", () => {
  it("matches the agent's missing-clip sentence", () => {
    const error = new ServiceError("agent", "Clip 2 is not on video track 1 (has 1 clips).", { status: 502 });
    expect(isClipGoneError(error)).toBe(true);
  });

  it("ignores other failures", () => {
    expect(isClipGoneError(new ServiceError("agent", "Resolve is not running", { status: 503 }))).toBe(false);
    expect(isClipGoneError(new Error("Clip 2 is not on video track 1 (has 1 clips)."))).toBe(false);
  });
});
