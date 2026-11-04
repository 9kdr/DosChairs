import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/services/client";
import type { Project } from "./data";
import {
  fetchDetectedSnapshot,
  findStoredProject,
  mergeEditors,
  mergeProjects,
  openProjectInEditor,
  readStoredSnapshot,
  snapshotFromJson,
  writeStoredSnapshot,
} from "./projects";

const PAYLOAD = {
  editors: [
    { id: "resolve", status: "inProject" },
    { id: "kdenlive", status: "idle" },
    { id: "otio", status: "stopped" },
  ],
  projects: [
    {
      id: "resolve:talking-head",
      name: "Talking head",
      editor: "resolve",
      edited_at: "2026-10-26T18:40:00.000Z",
      preview: "Open now",
    },
  ],
};

function storedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "resolve:talking-head",
    name: "Talking head",
    editorId: "resolve",
    editedAt: "2026-10-26T18:40:00.000Z",
    preview: "Open now",
    ...overrides,
  };
}

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("snapshotFromJson", () => {
  it("parses a detected bundle", () => {
    const snapshot = snapshotFromJson(PAYLOAD);
    expect(snapshot.editors).toEqual([
      { id: "resolve", status: "inProject" },
      { id: "kdenlive", status: "idle" },
      { id: "otio", status: "stopped" },
    ]);
    expect(snapshot.projects).toEqual([
      {
        id: "resolve:talking-head",
        name: "Talking head",
        editorId: "resolve",
        editedAt: "2026-10-26T18:40:00.000Z",
        preview: "Open now",
      },
    ]);
  });

  it.each([
    ["missing lists", { editors: [] }],
    ["unknown editor", { editors: [{ id: "premiere", status: "idle" }], projects: [] }],
    ["unknown status", { editors: [{ id: "resolve", status: "live" }], projects: [] }],
    [
      "project without editor",
      {
        editors: [],
        projects: [
          {
            id: "x",
            name: "X",
            editor: "premiere",
            edited_at: "2026-10-26T18:40:00.000Z",
            preview: "",
          },
        ],
      },
    ],
    [
      "project with bad timestamp",
      {
        editors: [],
        projects: [
          {
            id: "x",
            name: "X",
            editor: "resolve",
            edited_at: "soon",
            preview: "",
          },
        ],
      },
    ],
    [
      "duplicate project ids",
      {
        editors: [],
        projects: [
          {
            id: "x",
            name: "X",
            editor: "resolve",
            edited_at: "2026-10-26T18:40:00.000Z",
            preview: "",
          },
          {
            id: "x",
            name: "X again",
            editor: "resolve",
            edited_at: "2026-10-26T18:40:00.000Z",
            preview: "",
          },
        ],
      },
    ],
  ])("fails loudly on %s", (_label, payload) => {
    expect(() => snapshotFromJson(payload)).toThrowError(ServiceError);
    expect(() => snapshotFromJson(payload)).toThrowError(/malformed/);
  });
});

describe("fetchDetectedSnapshot", () => {
  it("throws a plain error when the agent is unreachable", async () => {
    await expect(
      fetchDetectedSnapshot({
        fetchFn: () => Promise.reject(new TypeError("failed to fetch")),
      }),
    ).rejects.toThrowError(/unreachable/);
  });

  it("throws on a not-ok status without parsing", async () => {
    await expect(
      fetchDetectedSnapshot({
        fetchFn: () =>
          Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }),
      }),
    ).rejects.toThrowError(/agent failed \(500\)/);
  });
});

describe("mergeProjects", () => {
  it("updates re-detected entries without duplicating", () => {
    const stored = [
      storedProject({ name: "Talking head (old)" }),
      storedProject({ id: "kdenlive:trailer", name: "Trailer", editorId: "kdenlive" }),
    ];
    const detected = [
      storedProject({ editedAt: "2026-10-27T12:00:00.000Z" }),
      storedProject({ id: "otio:roundtrip", name: "Roundtrip", editorId: "otio" }),
    ];

    const merged = mergeProjects(stored, detected);

    expect(merged.map((project) => project.id)).toEqual([
      "resolve:talking-head",
      "otio:roundtrip",
      "kdenlive:trailer",
    ]);
    expect(merged[0]?.editedAt).toBe("2026-10-27T12:00:00.000Z");
  });
});

describe("mergeEditors", () => {
  it("fills unscanned editors as stopped", () => {
    expect(mergeEditors([{ id: "resolve", status: "inProject" }])).toEqual([
      { id: "resolve", status: "inProject" },
      { id: "kdenlive", status: "stopped" },
      { id: "otio", status: "stopped" },
    ]);
  });
});

describe("stored snapshot", () => {
  it("round-trips the mapping for restarts", () => {
    stubStorage();
    writeStoredSnapshot({
      editors: [{ id: "resolve", status: "inProject" }],
      projects: [storedProject()],
      scannedAt: "2026-10-27T12:00:00.000Z",
    });

    const stored = readStoredSnapshot();
    expect(stored.projects).toEqual([storedProject()]);
    expect(stored.scannedAt).toBe("2026-10-27T12:00:00.000Z");
    expect(findStoredProject("resolve:talking-head")).toEqual(storedProject());
    expect(findStoredProject("missing")).toBeNull();
  });

  it("starts empty on corrupt JSON instead of rendering fakes", () => {
    const store = stubStorage();
    store.set("chair.home.projects", "{nope");

    const stored = readStoredSnapshot();
    expect(stored.projects).toEqual([]);
    expect(stored.scannedAt).toBeNull();
  });
});

describe("openProjectInEditor", () => {
  const project = { id: "resolve:chair-captest", name: "Chair Captest" };

  it("posts the card id and name, then returns the confirmation", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const result = await openProjectInEditor(project, {
      agentUrl: "http://agent:9999",
      fetchFn: (url, init) => {
        seen.push({ url, init });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              project_id: project.id,
              editor: "resolve",
              opened: true,
              alreadyCurrent: true,
              project: "Chair Captest",
            }),
        });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://agent:9999/projects/open");
    expect(JSON.parse(seen[0]!.init?.body as string)).toEqual({
      project_id: "resolve:chair-captest",
      name: "Chair Captest",
    });
    expect(result).toEqual({
      opened: true,
      alreadyCurrent: true,
      project: "Chair Captest",
    });
  });

  it("throws the agent's plain message on failure", async () => {
    await expect(
      openProjectInEditor(project, {
        fetchFn: () =>
          Promise.resolve({
            ok: false,
            status: 503,
            json: () =>
              Promise.resolve({
                error: {
                  code: "editor_unavailable",
                  message: "DaVinci Resolve Studio is closed.",
                },
              }),
          }),
      }),
    ).rejects.toThrowError("DaVinci Resolve Studio is closed.");
  });

  it("throws a plain error when the agent is unreachable", async () => {
    await expect(
      openProjectInEditor(project, {
        fetchFn: () => Promise.reject(new TypeError("failed to fetch")),
      }),
    ).rejects.toThrowError(/unreachable/);
  });
});
