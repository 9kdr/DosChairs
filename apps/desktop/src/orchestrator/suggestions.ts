import type { RunningTask } from "./RunningTasks";
import type { ProjectPlan } from "./plan-api";

export type Suggestion =
  | { kind: "retry"; taskId: string; label: string }
  | { kind: "prompt"; label: string; text: string };

/** Longest chip label. The full step text still goes into the composer. */
const LABEL_MAX = 40;

/** Fewest normalised characters a task name needs to count as a step's short form. */
const SHORT_MATCH_MIN = 8;

/** A task that failed: a failed job, or a "Failed: …" status line. */
function isFailed(task: RunningTask): boolean {
  if (task.jobStatus === "failed") return true;
  return task.status.trim().toLowerCase().startsWith("failed:");
}

/** Lower-case words only: punctuation and spacing differences never matter. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

type Step = { title: string; text: string };

/**
 * The plan's steps in plan order: the tasks built from the plan, or, when
 * none are built yet, its beats. A step's text is what lands in the
 * composer: the title, then its detail as a second sentence.
 */
function stepsOf(plan: ProjectPlan): Step[] {
  const built = plan.back.tasks
    .map((task): Step => {
      const title = task.title.trim();
      const detail = task.detail?.trim() ?? "";
      const joined = /[.!?]$/.test(title) ? `${title} ${detail}` : `${title}. ${detail}`;
      return { title, text: detail ? joined : title };
    })
    .filter((step) => step.title !== "");
  if (built.length > 0) return built;
  return plan.front.beats
    .map((beat): Step => ({ title: beat.text.trim(), text: beat.text.trim() }))
    .filter((step) => step.title !== "");
}

/** True when a task (running, landed, planned or failed) already ran this step. */
function hasRun(step: Step, tasks: readonly RunningTask[]): boolean {
  const title = normalise(step.title);
  if (title === "") return true;
  return tasks.some((task) =>
    [task.name, task.plan?.brief ?? ""].some((raw) => {
      const key = normalise(raw);
      if (key === "") return false;
      if (key.includes(title)) return true;
      return key.length >= SHORT_MATCH_MIN && title.includes(key);
    }),
  );
}

/** The step as a short chip label, cut at a word boundary. */
function labelFor(title: string): string {
  const clean = title.replace(/[.!?]+$/, "");
  if (clean.length <= LABEL_MAX) return clean;
  const cut = clean.slice(0, LABEL_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 16 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Real suggestions only, three at most: a failed task's Retry first, then
 * the plan's next steps that no task has run yet, in plan order (two at
 * most). No plan and nothing failed means nothing — never made-up advice.
 * A failed task's step comes back only through its Retry.
 */
export function suggestionsFor(args: {
  plan: ProjectPlan | null;
  tasks: readonly RunningTask[];
}): Suggestion[] {
  const found: Suggestion[] = [];
  const failed = args.tasks.find(isFailed);
  if (failed) {
    found.push({ kind: "retry", taskId: failed.id, label: `Retry ${failed.name}` });
  }
  if (args.plan) {
    const next = stepsOf(args.plan)
      .filter((step) => !hasRun(step, args.tasks))
      .slice(0, 2);
    for (const step of next) {
      found.push({ kind: "prompt", label: labelFor(step.title), text: step.text });
    }
  }
  return found;
}
