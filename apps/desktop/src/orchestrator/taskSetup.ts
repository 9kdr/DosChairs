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

/** Tool names mirror the agent's tool registry; lanes run what it can plan. */
export const LANE_TOOLS: Record<TaskLane, string[]> = {
  edit: ["measure_audio", "transcribe", "editor_op", "render_preview"],
  effects: ["sam3_mask", "sam_audio", "motion_graphics"],
  colour: ["grade", "render_preview"],
};

/** Lanes the agent loop can run today. Others report honestly, unconnected. */
export const RUNNABLE_LANES: ReadonlySet<TaskLane> = new Set(["edit"]);

export const AGENT_LABEL: Record<TaskLane, string> = {
  edit: "Edit",
  effects: "Effects",
  colour: "Colour",
};

export type Subagent = {
  lane: TaskLane;
  label: string;
  tools: string[];
  runnable: boolean;
};

/** One subagent per wanted lane. Tasks without a plan keep one edit turn. */
export function spawnSubagents(task: RunningTask): Subagent[] {
  const wanted = task.plan?.lanes;
  const lanes: readonly TaskLane[] = wanted?.length ? wanted : ["edit"];
  return lanes.map((lane) => ({
    lane,
    label: AGENT_LABEL[lane],
    tools: LANE_TOOLS[lane],
    runnable: RUNNABLE_LANES.has(lane),
  }));
}

/** Honest line for a lane with no connected tools. Submits nothing. */
export function gatedAgentText(agent: Subagent): string {
  const tools = agent.tools.join(", ");
  return (
    `${agent.label} subagent isn't connected yet — ${tools} ` +
    `${agent.tools.length === 1 ? "is" : "are"} still on the way. Nothing changed.`
  );
}
