/** Per-effect generation plans. Mirrors schemas/plan-*.schema.json. */
import type { Changeset, ChangesetItem } from "./index";

export const EFFECTS = ["muse_image", "sam3_mask", "grade", "motion_graphics"] as const;

export type EffectName = (typeof EFFECTS)[number];

const PARAM_ENUMS: Record<EffectName, Record<string, readonly string[]>> = {
  muse_image: {
    aspect: ["1:1", "16:9", "9:16"],
    style: ["photo", "cinematic", "illustration"],
  },
  sam3_mask: {
    promptKind: ["text", "point", "box"],
    trackMode: ["single", "tracked"],
  },
  grade: {
    intensity: ["subtle", "medium", "strong"],
    source: ["preset", "reference"],
  },
  motion_graphics: {
    template: ["lower-third", "title-card", "callout"],
    loop: ["once", "loop"],
  },
};

export const EFFECT_PARAM_DEFAULTS: Record<EffectName, Record<string, string>> = {
  muse_image: { aspect: "16:9", style: "cinematic" },
  sam3_mask: { promptKind: "text", trackMode: "tracked" },
  grade: { intensity: "medium", source: "preset" },
  motion_graphics: { template: "lower-third", loop: "once" },
};

export interface PlanShot {
  prompt: string;
  durationSec: number;
  mediaRef?: string;
}

export interface EffectPlan {
  schemaVersion: "0.1.0";
  effect: EffectName;
  prompt: string;
  mediaRefs?: string[];
  durationSec?: number;
  shots?: PlanShot[];
  params?: Record<string, string>;
}

export type PlanCheck = { ok: true; plan: EffectPlan } | { ok: false; reason: string };

const TOP_KEYS = new Set([
  "schemaVersion",
  "effect",
  "prompt",
  "mediaRefs",
  "durationSec",
  "shots",
  "params",
]);

const SHOT_KEYS = new Set(["prompt", "durationSec", "mediaRef"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

/** Reject invalid plans with a reason. Never mutates or repairs the input. */
export function validateEffectPlan(input: unknown): PlanCheck {
  if (!isRecord(input)) return { ok: false, reason: "plan must be an object" };
  for (const key of Object.keys(input)) {
    if (!TOP_KEYS.has(key)) return { ok: false, reason: `unknown field: ${key}` };
  }
  if (input.schemaVersion !== "0.1.0") {
    return { ok: false, reason: "schemaVersion must be 0.1.0" };
  }
  if (typeof input.effect !== "string" || !(EFFECTS as readonly string[]).includes(input.effect)) {
    return { ok: false, reason: `unknown effect: ${String(input.effect)}` };
  }
  const effect = input.effect as EffectName;
  if (!nonEmptyString(input.prompt)) {
    return { ok: false, reason: "prompt must be a non-empty string" };
  }
  if (
    input.mediaRefs !== undefined &&
    (!Array.isArray(input.mediaRefs) || input.mediaRefs.some((ref) => !nonEmptyString(ref)))
  ) {
    return { ok: false, reason: "mediaRefs must be an array of non-empty strings" };
  }
  if (input.durationSec !== undefined && !positiveNumber(input.durationSec)) {
    return { ok: false, reason: "durationSec must be a number above 0" };
  }
  if (input.shots !== undefined) {
    if (!Array.isArray(input.shots) || input.shots.length === 0) {
      return { ok: false, reason: "shots must be a non-empty array" };
    }
    for (let index = 0; index < input.shots.length; index += 1) {
      const shot = input.shots[index];
      if (!isRecord(shot)) return { ok: false, reason: `shots[${index}] must be an object` };
      for (const key of Object.keys(shot)) {
        if (!SHOT_KEYS.has(key)) {
          return { ok: false, reason: `shots[${index}] has unknown field: ${key}` };
        }
      }
      if (!nonEmptyString(shot.prompt)) {
        return { ok: false, reason: `shots[${index}].prompt must be a non-empty string` };
      }
      if (!positiveNumber(shot.durationSec)) {
        return { ok: false, reason: `shots[${index}].durationSec must be a number above 0` };
      }
      if (shot.mediaRef !== undefined && !nonEmptyString(shot.mediaRef)) {
        return { ok: false, reason: `shots[${index}].mediaRef must be a non-empty string` };
      }
    }
  }
  if (input.params !== undefined) {
    if (!isRecord(input.params)) return { ok: false, reason: "params must be an object" };
    const enums = PARAM_ENUMS[effect];
    for (const key of Object.keys(input.params)) {
      if (!(key in enums)) {
        return { ok: false, reason: `unknown param for ${effect}: ${key}` };
      }
      const value = input.params[key];
      if (typeof value !== "string" || !enums[key]!.includes(value)) {
        return { ok: false, reason: `invalid value for ${key}: ${String(value)}` };
      }
    }
  }
  return { ok: true, plan: input as unknown as EffectPlan };
}

/** Multi-shot durations summed for cost/time estimates. Single-shot plans use durationSec. */
export function totalPlanDurationSec(plan: EffectPlan): number {
  if (plan.shots && plan.shots.length > 0) {
    return plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0);
  }
  return plan.durationSec ?? 0;
}

/**
 * Bridge a shot list to explicit cuts. Each shot becomes one pending add_clip
 * item on the given track. Shots are not timeline cuts until the editor accepts them.
 */
export function planToChangeset(
  plan: EffectPlan,
  opts: { id: string; baseRevision: string; trackId?: string },
): Changeset {
  const trackId = opts.trackId ?? "v1";
  const params = { ...EFFECT_PARAM_DEFAULTS[plan.effect], ...plan.params };
  const cuts =
    plan.shots && plan.shots.length > 0
      ? plan.shots.map((shot) => ({
          prompt: shot.prompt,
          durationSec: shot.durationSec,
          mediaRef: shot.mediaRef,
        }))
      : [
          {
            prompt: plan.prompt,
            durationSec: plan.durationSec ?? 0,
            mediaRef: plan.mediaRefs?.[0],
          },
        ];
  const items: ChangesetItem[] = cuts.map((cut, index) => {
    const patch: Record<string, unknown> = {
      shotIndex: index,
      prompt: cut.prompt,
      durationSec: cut.durationSec,
      effect: plan.effect,
      params,
    };
    if (cut.mediaRef !== undefined) patch.mediaRef = cut.mediaRef;
    return {
      id: `${plan.effect}-shot-${index}`,
      op: "add_clip" as const,
      targetId: trackId,
      rationale: `Shot ${index + 1}: ${cut.prompt}`,
      patch,
      status: "pending" as const,
    };
  });
  return { schemaVersion: "0.1.0", id: opts.id, baseRevision: opts.baseRevision, items };
}
