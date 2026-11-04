import { describe, expect, it } from "vitest";
import type { FetchFn } from "@/lib/services/client";
import { fetchPieces, PiecesError } from "./pieces-api";

const piece = {
  id: "macro:user:title:lower",
  name: "My Lower Third",
  kind: "title",
  origin: "macro",
  source: "user",
  summary: "Resolve title in the user Fusion folder, 2 published controls.",
  controls: [
    { key: "Input1", name: "Name", type: "text", default: "MEL" },
    { key: "Input5", name: "Size", type: "number", default: 1, min: 0.25, max: 4 },
  ],
};

describe("fetchPieces", () => {
  it("asks the agent for the query and reads pieces with their controls", async () => {
    let seen = "";
    const fetchFn: FetchFn = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ pieces: [piece, { nope: true }], total: 2 }) };
    };
    const found = await fetchPieces("lower", { fetchFn, agentUrl: "http://agent", limit: 5 });
    expect(seen).toBe("http://agent/pieces/macros?q=lower&limit=5");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "My Lower Third", source: "user", origin: "macro" });
    expect(found[0]!.controls[1]).toEqual({ key: "Input5", name: "Size", type: "number", default: 1, min: 0.25, max: 4 });
  });

  it("says the agent is unreachable when fetch fails", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("failed");
    };
    const error = await fetchPieces("", { fetchFn, agentUrl: "http://agent" }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PiecesError);
    expect((error as PiecesError).kind).toBe("offline");
    expect((error as Error).message).toMatch(/unreachable/);
  });

  it("says refused with the agent's reason when it answers no", async () => {
    const down: FetchFn = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "pieces_unavailable", message: "macro folder missing" } }),
    });
    const error = await fetchPieces("", { fetchFn: down }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PiecesError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as PiecesError).kind).toBe("refused");
    expect((error as Error).message).toContain("refused");
    expect((error as Error).message).toContain("macro folder missing");
  });

  it("rejects a payload with no pieces array and a non-ok status", async () => {
    const bad: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await expect(fetchPieces("", { fetchFn: bad })).rejects.toThrow(/malformed/);
    const down: FetchFn = async () => ({ ok: false, status: 503, json: async () => null });
    await expect(fetchPieces("", { fetchFn: down })).rejects.toMatchObject({ status: 503 });
  });
});
