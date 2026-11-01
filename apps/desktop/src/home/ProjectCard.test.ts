import React from "react";
import ReactDOMServer from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "@/components/ui/menu";
import { ProjectCard, ProjectCardActions } from "./ProjectCard";
import type { Project } from "./data";

const TEST_PROJECT: Project = {
  id: "proj_test",
  name: "Rough cut sample",
  editorId: "resolve",
  editedAt: "2026-10-26T18:40:00.000Z",
  preview: "Intro",
};

describe("ProjectCard", () => {
  it("renders card with quiet overflow action trigger", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(ProjectCard, { project: TEST_PROJECT }),
    );
    expect(html).toContain("Rough cut sample");
    expect(html).toContain("Actions for Rough cut sample");
  });
});

describe("ProjectCardActions", () => {
  it("renders stand-in actions: Open, Rename, Remove, and Reveal", () => {
    const onOpen = vi.fn();
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Menu,
        null,
        React.createElement(ProjectCardActions, {
          onOpen,
        }),
      ),
    );
    expect(html).toContain("Open");
    expect(html).toContain("Rename");
    expect(html).toContain("Remove from recents");
    expect(html).toContain("Reveal in editor");
    expect(html).toContain("data-disabled");
  });
});
