---
name: chair-models
description: "Pick a Chair model and open a T3 thread for one specific job. Use when starting work, delegating, reviewing, committing, running mise run check, or when a change is moderately worth a review. Also use when the user mentions Grok, Auto, Gemini, DeepSeek, OpenCode, Antigravity, or T3."
---

# Models

Spend the scarce models on a named problem. Do not open a second chat to keep the first one company.

| When | Who | How to start it |
| --- | --- | --- |
| Quick work. One file, one error, a label, a question, the check before a commit | Gemini 3.8 Flash, high, on Antigravity. This is the $20 plan you can spend often. | `delegate_task` to `antigravity` / `gemini-3.8-flash-high`. From a shell: `--provider antigravity --model gemini-3.8-flash-high` |
| A moderate change, before the commit. The check, then the score | Gemini 3.8 Flash, high, on Antigravity. It runs the check and scores. It does not edit. | Same Gemini slug as a quick task. Role: `review` |
| A screen the user named, or a long bug the user named | DeepSeek v4.1 on OpenCode. The free daily pool is small. One of these a day is the idea. | `--provider opencode --model opencode/deepseek-v4.1-flash-free` |
| A screen, or several packages | Grok 4.7, high, on Cursor. The $20 workhorse. Always high effort, never fast, always 256k (not 500k). | `delegate_task` / Cursor: model `grok-4.7` with options `reasoning_effort=high`, `fastMode=false`, `contextWindow=256k` |
| Small, and you cannot tell the field | Gemini 3.8 Flash, high, on Antigravity | Same Gemini slug as a quick task |
| Several packages, and you cannot tell the field | Grok 4.7, high, on Cursor | Same Grok options as a screen |

Claude and Codex lead the public boards and stay switched off. Gemini 4 Argon is not on this account. Do not call any of them. Pick the best model that is actually enabled.

If a slug is rejected, tell the user the exact error and stop. Do not cycle through other models.

## Field, then weight

Name the field before the model. A screen is UI. A score is review. One file is a short fix. Several packages is repo work.

For UI, check the WebDev board (https://arena.ai/leaderboard/code/webdev). For a long agent task, check the Artificial Analysis coding-agent index (https://artificialanalysis.ai/agents/coding-agents). Use the ranking only among enabled models. The snapshot below is 23 Oct 2026. If the board has moved, follow the board.

On that WebDev snapshot, the models we can call sit in this order: DeepSeek V4.1 Flash (about 1665), Grok 4.7 (about 1638), Gemini 3.8 Flash high (about 1585). On the coding-agent index, DeepSeek V4.1 Flash and Grok 4.7 are close, and Gemini 3.8 Flash high is well behind. When we call Grok, we only use **Grok 4.7 high**, not fast, on **256k**.

Then pick the weight from the plan:

- The Cursor and Antigravity plans are $20. OpenCode is the free daily pool.
- Cheap weight is Gemini 3.8 Flash high. Use it for a short fix, for the check before a commit, and for every moderate review.
- A screen goes to Grok 4.7 high (not fast, 256k). DeepSeek v4.1 only when the user named that screen, or named the long bug.
- Heavy repo weight is Grok 4.7 high on Cursor (not fast, 256k).
- Never set Grok `fastMode` true. Never set `contextWindow` to `500k`. Pass `reasoning_effort=high`, `fastMode=false`, and `contextWindow=256k` in `target.options`.
- A −1 bloat warning stays on the report. A −2 or −3 cleanup chat stays on Cursor Auto.

## Before you commit

A typo, a comment, or a one-line wording fix can go in after the builder runs `mise run check`.

Anything moderately worth a review waits for Gemini 3.8 Flash high on Antigravity. Moderate means a behavior change, a new file, or a diff that touches the cut, the window, a schema, an adapter, or a check.

Give it the issue, the branch, and the changed files. Ask it to read this skill and follow "Score the implementation". It runs `mise run check` on what changed, then scores. It does not edit, commit, or open a pull request. Commit only after the check passes.

Every implementation task you delegate ends with this paragraph. A child does not inherit your chat, and an Antigravity thread does not load `AGENTS.md`:

"Before you commit a change that is moderately worth a review, delegate the check and the score to Gemini 3.8 Flash high on Antigravity (model `gemini-3.8-flash-high`). Read `.agents/skills/chair-models/SKILL.md` and follow Score the implementation. Also read `.agents/skills/ponytail-review/SKILL.md` and the ladder in `.agents/skills/ponytail/SKILL.md` at level full. The bloat deduction follows that lean pass. Gemini runs `mise run check` on what changed, scores, and does not edit. Commit only after the check passes. Quick work uses that same Gemini. OpenCode only if the user named the screen or the long bug."

## What to ask

Give the child one issue, the paragraph above, and nothing else from the parent chat.

- Gemini, for a small fix: the error or the file, and the sentence that means done. Ask for the patch, not a redesign.
- Gemini, before a moderate commit: the rubric below. It runs the check, scores, and does not edit.
- DeepSeek, only when the user named the screen or the long bug: the issue number, the files it may touch, the check to run, and what it must not change. Do not spend it on a ping, a status reply, or a quick task.
- Grok 4.7: the goal, the constraints, and what to leave alone. Ask it to decide and then do the work. For a screen, name the window a person will look at. Pass `reasoning_effort=high`, `fastMode=false`, and `contextWindow=256k` in `target.options`, not only in the prompt.
- Auto: the cleanup chat after a bloat deduction of 2 or 3. It may only delete or shrink what Gemini named.

A mid-task review is one question the builder cannot settle, for example "Does this pending edit change the timeline? Point at the line." The reviewer does not start a second branch.

## Score the implementation

Before you commit a change that is moderately worth a review, open one review on Antigravity with model `gemini-3.8-flash-high`. Role: `review`. Give it the issue number, the branch, and the changed files. Tell it to read `.agents/skills/chair-models/SKILL.md`, then `.agents/skills/ponytail-review/SKILL.md`, then the ladder in `.agents/skills/ponytail/SKILL.md` at level full. Those two ponytail files are the cleanliness standard. It runs `mise run check`, then scores. It does not edit, commit, or open a pull request. Commit only after the check passes. Bring the score back before you tell the user the work is ready.

Be strict. A high score must be earned. Praise without line evidence is invalid. Do not default to −0 bloat because the issue works.

Each gate is worth 2 points, or 0. The score is the sum, out of 10.

1. **The issue.** The diff does what the issue asked. Files outside that work are untouched. Partial delivery or drive-by edits score 0.
2. **The rules.** A pending edit does not change the timeline. Source video and audio stay untouched. No secrets, footage, or weights. Any violation scores 0.
3. **The check.** It re-runs the check for the packages that changed in this environment and reports the exact command and result. Trusting the builder's claim without re-running scores 0. A failure scores 0.
4. **The code.** It opens every changed file and names the lines that do the work for each acceptance point. A score with no line references, or only file names, is 0.
5. **The screen.** If `apps/desktop` or `packages/ui` changed, it runs `pnpm --filter @chair/desktop dev`, opens `http://localhost:1420`, and takes a screenshot of the screen a person would use. It says what is on that screen. No screenshot scores 0. If those paths did not change, this gate scores 2 and the report says there was no screen to shoot.

Then it deducts for bloat, from 0 to 3. The deduction comes off the gate total. The result cannot go below 0.

The deduction follows the ponytail skills, not a private checklist. Read `.agents/skills/ponytail-review/SKILL.md` and do that review, especially Lean. Read the ladder in `.agents/skills/ponytail/SKILL.md` and apply level full. Walk every rung: does it need to exist, is it already in this repo, does the standard library or the platform do it, does an installed dependency do it, can it be one line, otherwise is this the minimum. A rung that would have made a smaller complete diff is a lean finding. Cite the lines.

Also hunt for each of these and either cite lines or say the pattern was not found:

- A duplicated expected blob that restates mapper or fixture output when a few field asserts plus schema validation would do.
- A hand-rolled helper that reimplements repo tooling (schema validation, IR helpers, formatting) already available elsewhere.
- An unused export, dead branch, restated comment, or wrapper that only renames a call.
- A new file or layer the issue did not need.

Deductions:

- **0.** Only when the ladder finds no smaller complete diff and the report says `Lean: -0 lines possible`. The report names each rung it checked. "Looks fine" is not enough.
- **−1.** One lean item: an extra helper, a near-copy, a few lines the standard library or an existing helper already covers, a restated comment, an unused prop, or an abstraction with one implementation.
- **−2.** A new file or a second way to do something the repo, the standard library, or an installed dependency already does.
- **−3.** A structure this issue does not need.

Stack the worst matching tier; do not average them away. Prefer −1 over −0 when unsure. A 10/10 with −0 bloat is rare and must survive the ponytail ladder.

It names the extra pieces and the lines. A deduction with no lines is invalid and counts as 0. A −0 without `Lean: -0 lines possible` is incomplete; desk re-asks the review. The report also includes `What this change does:` from ponytail-review.

It returns the five gates, the deduction (with hunt notes), then one line: `Score: N/10`.

Bring that score back to the user before any merge question. Under 7, do not ask to merge. Ask: "Gemini scored this N/10. The misses are: <the gates that scored 0>. Should I try again?"

A bloat deduction of 2 or 3 holds the pull request even when the score is 7 or above. Ask: "Gemini scored this N/10 and marked it overbuilt. The extra pieces are: <lines>. Should I open a cleanup chat on this same branch?" The cleanup chat is a different model from the one that wrote the code, and it is not Gemini. Use Cursor Auto. It may only delete or shrink what Gemini named. It does not add behavior and it does not open a second branch. After that one cleanup, Gemini scores once more, and you bring that score back. Do not start a second cleanup unless the user asks.

## Calling each other

Open a new T3 thread. Do not keep typing into the same chat.

From a shell, `t3 thread start` opens a top-level thread. Inside a T3 thread, `delegate_task` opens a child thread. The child receives only the task, the role (`implementation`, `review`, or `research`), the issue number, and the before-commit paragraph above.

Call another model when the first one has found a specific problem it should not fix itself, or when two problems do not touch the same files. Then they may run at the same time. If they would edit the same files, run them one after the other.

Post the handoff on the GitHub issue as well, so the board still shows who is doing what. One issue still gets one branch. Nobody merges until the user answers the merge question.

## How to talk

Say what is happening, which issue it is, and what you need. Then stop.

Good:

"I'm on issue 1, the Kdenlive round trip. Nobody else has it. DeepSeek will do the adapter. I won't merge until you say so."

"DeepSeek hit a schema question. I asked Gemini one thing: does this pending edit change the timeline? I'll wait for that before more code."

"Gemini scored this 8/10. The pull request is ready: link. Checks are green. I have not merged it. Should I merge it into main?"

"Gemini scored this 4/10. The misses are: the check failed, and there is no screenshot. Should I try again?"

"Gemini scored this 8/10 and marked it overbuilt. The extra pieces are: a new store in App.tsx that the composer never reads. Should I open a cleanup chat on this same branch?"

Too much:

"I'll leverage a multi-agent orchestration layer and proceed to implement the full pipeline across all surfaces."

One note when you start, one if you are blocked, one when it is ready to merge. Do not restate the plan on every turn.
