import { describe, expect, it } from "vitest";
import { EDITORS, editorConnection } from "./editors";

describe("editorConnection", () => {
  it("is connected when linked and the agent answers", () => {
    expect(editorConnection({ linked: true, agentUp: true })).toBe(
      "connected",
    );
  });

  it("is unreachable when linked but the agent is down", () => {
    expect(editorConnection({ linked: true, agentUp: false })).toBe(
      "unreachable",
    );
  });

  it("is never configured until linked", () => {
    expect(editorConnection({ linked: false, agentUp: true })).toBe(
      "never-configured",
    );
    expect(editorConnection({ linked: false, agentUp: null })).toBe(
      "never-configured",
    );
  });

  it("is checking while reachability is unknown", () => {
    expect(editorConnection({ linked: true, agentUp: null })).toBe(
      "checking",
    );
  });
});

describe("editor manifests", () => {
  it("lists Resolve, Kdenlive, and interchange with versions", () => {
    expect(EDITORS.map((editor) => editor.id)).toEqual([
      "resolve",
      "kdenlive",
      "otio",
    ]);
    for (const editor of EDITORS) {
      expect(editor.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(editor.capabilities.length).toBe(7);
    }
  });

  it("keeps Resolve native with write-direction fallback notes", () => {
    const resolve = EDITORS[0]!;
    expect(
      resolve.capabilities.every((capability) => capability.native),
    ).toBe(true);
    expect(
      resolve.capabilities.filter((capability) => capability.fallback).length,
    ).toBe(2);
  });
});
