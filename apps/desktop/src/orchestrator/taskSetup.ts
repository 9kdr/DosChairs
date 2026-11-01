/**
 * Prompted tasks: free text in, a planned running task out.
 *
 * The orchestrator plans the prompt locally (v1 keyword routing: which
 * lanes this task wants, in the order the prompt mentions them) and sets
 * the task up with its brief and context. Lane subagents arrive in slice B.
 */
import type { RunningTask, TaskLane, TaskPlan } from "./RunningTasks";

const LANE_WORDS: Record<TaskLane, string[]> = {
  edit: ["cut", "cuts", "trim", "trims", "silence", "filler", "subtitle", "caption", "assemble"],
  effects: ["effect", "effects", "mask", "glow", "halation", "blur", "track", "composite"],
  colour: ["color", "colour", "grade", "lut", "white balance"],
};

/** First mention of any of the lane's words, or -1 when none match. */
function mentionAt(text: string, words: string[]): number {
  let at = -1;
  for (const word of words) {
    const found = text.search(new RegExp(`\\b${word}\\b`));
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  return at;
}

/** Lanes the prompt wants, in mention order. Bare prompts default to edit. */
export function lanesForPrompt(text: string): TaskLane[] {
  const lowered = text.toLowerCase();
  const ranked = (["edit", "effects", "colour"] as const)
    .map((lane) => ({ lane, at: mentionAt(lowered, LANE_WORDS[lane]) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.lane);
  return ranked.length > 0 ? ranked : ["edit"];
}

export function planPrompt(text: string): TaskPlan {
  const brief = text.trim();
  return { brief, lanes: lanesForPrompt(brief) };
}

/** A running task from a command-bar prompt. The command id keeps it stable. */
export function setupTask(prompt: string, commandId: number): RunningTask {
  const plan = planPrompt(prompt);
  return {
    id: `task-prompt-${commandId}`,
    name: plan.brief,
    status: "Running",
    lane: plan.lanes[0]!,
    plan,
  };
}
