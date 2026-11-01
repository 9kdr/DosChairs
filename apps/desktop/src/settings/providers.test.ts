import { describe, expect, it } from "vitest";
import {
  keySourceLabel,
  maskKey,
  providerConnection,
} from "./providers";

describe("maskKey", () => {
  it("shows bullets plus the last four characters", () => {
    expect(maskKey("sk-secret-key-1234")).toBe("••••1234");
  });

  it("never leaks a short key", () => {
    expect(maskKey("abcd")).toBe("••••");
    expect(maskKey("")).toBe("••••");
  });
});

describe("providerConnection", () => {
  it("is live when a key is present and the agent is up", () => {
    expect(
      providerConnection({ appKey: true, envKey: false, agentUp: true }),
    ).toBe("live");
    expect(
      providerConnection({ appKey: false, envKey: true, agentUp: true }),
    ).toBe("live");
  });

  it("is saved when a key is present but the agent is down", () => {
    expect(
      providerConnection({ appKey: true, envKey: false, agentUp: false }),
    ).toBe("saved");
  });

  it("has no key when neither side holds one", () => {
    expect(
      providerConnection({ appKey: false, envKey: false, agentUp: true }),
    ).toBe("no-key");
  });

  it("is checking while reachability is unknown", () => {
    expect(
      providerConnection({ appKey: true, envKey: false, agentUp: null }),
    ).toBe("checking");
  });
});

describe("keySourceLabel", () => {
  it("names where the present key lives", () => {
    expect(keySourceLabel({ appKey: true, envKey: false })).toBe("in the app");
    expect(keySourceLabel({ appKey: false, envKey: true })).toBe(
      "in the environment",
    );
    expect(keySourceLabel({ appKey: true, envKey: true })).toBe(
      "in the app + the environment",
    );
    expect(keySourceLabel({ appKey: false, envKey: false })).toBe("");
  });
});
