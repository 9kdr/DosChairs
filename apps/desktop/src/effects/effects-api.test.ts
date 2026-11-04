import { describe, expect, it } from "vitest";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { generateEffect, sampleEffect, verifyEffect } from "./effects-api";

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
