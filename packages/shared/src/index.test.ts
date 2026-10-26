import { describe, expect, it } from "vitest";
import { schemaIds, SERVICE_PORTS } from "./index";

describe("shared", () => {
  it("lists the committed schemas", () => {
    expect(schemaIds).toContain("timeline.schema.json");
    expect(schemaIds).toContain("changeset.schema.json");
  });

  it("reserves local service ports", () => {
    expect(SERVICE_PORTS.agent).toBe(8787);
    expect(SERVICE_PORTS.sidecar).toBe(8788);
  });
});
