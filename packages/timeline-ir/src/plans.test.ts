import { describe, expect, it } from "vitest";
import {
  applyAccepted,
  emptyTimeline,
  planToChangeset,
  totalPlanDurationSec,
  validateEffectPlan,
} from "./index";

const multiShot = {
  schemaVersion: "0.1.0",
  effect: "muse_image",
  prompt: "Foggy harbor at dawn",
  shots: [
    { prompt: "Wide foggy harbor", durationSec: 4 },
    { prompt: "Push-in on the boat", durationSec: 3 },
  ],
  params: { aspect: "16:9" },
};

describe("effect plans", () => {
  it("accepts a multi-shot plan and sums durations", () => {
    const checked = validateEffectPlan(multiShot);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(totalPlanDurationSec(checked.plan)).toBe(7);
  });

  it("rejects invalid plans with a reason and never repairs the input", () => {
    const cases: Array<{ plan: Record<string, unknown>; reason: string }> = [
      { plan: { ...multiShot, effect: "unknown_fx" }, reason: "unknown effect" },
      { plan: { ...multiShot, extra: true }, reason: "unknown field: extra" },
      { plan: { ...multiShot, prompt: "" }, reason: "prompt must be a non-empty string" },
      { plan: { ...multiShot, params: { aspect: "4:3" } }, reason: "invalid value" },
      { plan: { ...multiShot, shots: [] }, reason: "shots must be a non-empty array" },
      {
        plan: { ...multiShot, shots: [{ prompt: "Wide", durationSec: 0 }] },
        reason: "durationSec must be a number above 0",
      },
    ];
    for (const { plan, reason } of cases) {
      const before = JSON.stringify(plan);
      const checked = validateEffectPlan(plan);
      expect(checked.ok).toBe(false);
      if (checked.ok) continue;
      expect(checked.reason).toContain(reason);
      expect(JSON.stringify(plan)).toBe(before);
    }
  });

  it("bridges shots to pending cuts without touching the timeline", () => {
    const checked = validateEffectPlan(multiShot);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const changeset = planToChangeset(checked.plan, { id: "cs1", baseRevision: "r0" });
    expect(changeset.items).toHaveLength(2);
    expect(changeset.items.map((item) => item.op)).toEqual(["add_clip", "add_clip"]);
    expect(changeset.items.map((item) => item.status)).toEqual(["pending", "pending"]);
    expect(changeset.items[0]?.patch).toMatchObject({ shotIndex: 0 });
    expect(changeset.items[1]?.patch).toMatchObject({ shotIndex: 1 });
    const timeline = emptyTimeline("tl", "Demo");
    expect(applyAccepted(timeline, changeset).tracks[0]?.clips).toHaveLength(0);
  });
});
