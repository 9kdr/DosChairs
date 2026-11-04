import { describe, expect, it } from "vitest";
import { modelLabel } from "./model-label";

describe("modelLabel", () => {
  it("names the model with its provider, like the composer picker", () => {
    expect(modelLabel("muse-wonder-1.0", "Meta")).toBe("muse-wonder-1.0 (Meta)");
  });
});
