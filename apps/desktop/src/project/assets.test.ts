import { describe, expect, it } from "vitest";
import { ServiceError, type FetchFn } from "@/lib/services/client";
import { assetsFromJson, fetchProjectAssets } from "./assets";

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

const LISTING = {
  project_id: "proj-1",
  folders: [{ id: "interview", name: "Interview", asset_ids: ["interview/take1.mov"] }],
  assets: [
    { id: "interview/take1.mov", name: "take1.mov", kind: "video", proxy: "ready" },
    { id: "hero.png", name: "hero.png", kind: "image", proxy: "missing" },
  ],
  pieces: [{ id: "hero-key-art", name: "Hero key art" }],
};

describe("fetchProjectAssets", () => {
  it("maps a listing to folders, assets, and pieces", async () => {
    const fetchFn = stubFetch([{ ok: true, status: 200, payload: LISTING }]);
    const listing = await fetchProjectAssets("proj-1", { fetchFn });

    expect(listing.folders).toEqual([
      { id: "interview", name: "Interview", assetIds: ["interview/take1.mov"] },
    ]);
    expect(listing.assets).toEqual([
      { id: "interview/take1.mov", name: "take1.mov", kind: "video", proxy: "ready" },
      { id: "hero.png", name: "hero.png", kind: "image", proxy: "missing" },
    ]);
    expect(listing.pieces).toEqual([{ id: "hero-key-art", name: "Hero key art" }]);
  });

  it("requests the encoded project assets path on the agent", async () => {
    const fetchFn = stubFetch([
      { ok: true, status: 200, payload: { folders: [], assets: [], pieces: [] } },
    ]);
    await fetchProjectAssets("my project", { fetchFn });

    expect((fetchFn as unknown as { calls: string[] }).calls).toEqual([
      "http://127.0.0.1:8787/projects/my%20project/assets",
    ]);
  });

  it("throws the agent's 503 message when the listing is unavailable", async () => {
    const fetchFn = stubFetch([
      {
        ok: false,
        status: 503,
        payload: {
          error: { code: "assets_unavailable", message: "cannot read /projects: denied" },
        },
      },
    ]);

    await expect(fetchProjectAssets("proj-1", { fetchFn })).rejects.toMatchObject({
      name: "ServiceError",
      service: "agent",
      status: 503,
      code: "assets_unavailable",
      message: "cannot read /projects: denied",
    });
  });

  it("throws a ServiceError when the agent is unreachable", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(fetchProjectAssets("proj-1", { fetchFn })).rejects.toMatchObject({
      name: "ServiceError",
      service: "agent",
      status: undefined,
    });
  });

  it("rethrows aborts instead of wrapping them", async () => {
    const fetchFn: FetchFn = async () => {
      throw new DOMException("aborted", "AbortError");
    };

    await expect(fetchProjectAssets("proj-1", { fetchFn })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("assetsFromJson", () => {
  it("rejects a non-object listing", () => {
    expect(() => assetsFromJson(null)).toThrowError(ServiceError);
    expect(() => assetsFromJson([])).toThrowError(ServiceError);
  });

  it("rejects a listing without folders, assets, and pieces", () => {
    expect(() => assetsFromJson({})).toThrowError(/folders, assets, and pieces/);
  });

  it("rejects folders missing id, name, or asset_ids", () => {
    expect(() =>
      assetsFromJson({ ...LISTING, folders: [{ id: "interview" }] }),
    ).toThrowError(/folder needs id, name, and asset_ids/);
  });

  it("rejects assets missing id, name, kind, or proxy", () => {
    expect(() =>
      assetsFromJson({ ...LISTING, assets: [{ id: "hero.png" }] }),
    ).toThrowError(/asset needs id, name, kind, and proxy/);
  });

  it("rejects unknown kinds instead of rendering fakes", () => {
    expect(() =>
      assetsFromJson({
        ...LISTING,
        assets: [{ id: "doc.pdf", name: "doc.pdf", kind: "document", proxy: "missing" }],
      }),
    ).toThrowError(/unknown kind document/);
  });

  it("rejects pieces missing id or name", () => {
    expect(() => assetsFromJson({ ...LISTING, pieces: [{ id: "p1" }] })).toThrowError(
      /piece needs id and name/,
    );
  });
});
