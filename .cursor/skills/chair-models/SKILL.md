---
name: chair-models
description: Pick a Chair model and open a T3 thread for one specific job. Use when starting work, delegating, reviewing, or when the user mentions Grok, Auto, Gemini, DeepSeek, OpenCode, Antigravity, or T3.
---

# Models

Spend the scarce models on a named problem. Do not open a second chat to keep the first one company.

| When | Who | How to start it |
| --- | --- | --- |
| Cheap. One file, one error, a label, the score after implementation | Gemini 3.8 Flash, high, on Antigravity. This is the $20 plan you can spend often. | `--provider antigravity --model gemini-3.8-flash-high` |
| Heavy, a screen. The window a person will look at is the whole task | DeepSeek v4.1 on OpenCode. Best UI model we can call. The free daily pool is small, so the screen has to be named. | `--provider opencode --model opencode/deepseek-v4.1-flash-free` |
| A named long bug, when the Cursor pool should be spared | DeepSeek v4.1 on OpenCode, same slug as a screen. One bug per day is the idea. | `--provider opencode --model opencode/deepseek-v4.1-flash-free` |
| A screen when DeepSeek should be saved, or several packages | Grok 4.7, high, on Cursor. The $20 workhorse. Use medium when the change is wide but not hard. | `--provider cursor --model grok-4.7-high` |
| You cannot tell the field | Cursor Auto | `--provider cursor --model default` |

Claude and Codex lead the public boards and stay switched off. Gemini 4 Argon is not on this account. Do not call any of them. Pick the best model that is actually enabled.

If a slug is rejected, tell the user the exact error and stop. Do not cycle through other models.

## Field, then weight

Name the field before the model. A screen is UI. A score is review. One file is a short fix. Several packages is repo work.

For UI, check the WebDev board (https://arena.ai/leaderboard/code/webdev). For a long agent task, check the Artificial Analysis coding-agent index (https://artificialanalysis.ai/agents/coding-agents). Use the ranking only among enabled models. The snapshot below is 23 Oct 2026. If the board has moved, follow the board.

On that WebDev snapshot, the models we can call sit in this order: DeepSeek V4.1 Flash (about 1665), Grok 4.7 (about 1638), Gemini 3.8 Flash high (about 1585). On the coding-agent index, DeepSeek V4.1 Flash and Grok 4.7 are close, and Gemini 3.8 Flash high is well behind.

Then pick the weight from the plan:

- The Cursor and Antigravity plans are $20. OpenCode is the free daily pool.
- Cheap weight is Gemini 3.8 Flash high. Use it for a short fix and for every score.
- Heavy UI weight is DeepSeek v4.1, and only when that screen is the whole task. Otherwise the screen goes to Grok 4.7 high.
- Heavy repo weight is Grok 4.7 high on Cursor. Spend DeepSeek on a long bug only when the bug is named.
- A −1 bloat warning stays on the report. A −2 or −3 cleanup chat stays on Cursor Auto.

## What to ask

Give the child one issue and nothing else from the parent chat.

- Gemini, for a small fix: the error or the file, and the sentence that means done. Ask for the patch, not a redesign.
- Gemini, after an implementation: the rubric below. It scores and does not edit.
- DeepSeek, for a screen or a named bug: the issue number, the files it may touch, the check to run, and what it must not change. Do not spend it on a ping or a status reply.
- Grok 4.7: the goal, the constraints, and what to leave alone. Ask it to decide and then do the work. For a screen, name the window a person will look at.
- Auto: say you are unsure, give the issue, and ask it to pick the smallest next step.

A mid-task review is one question the builder cannot settle, for example "Does this pending edit change the timeline? Point at the line." The reviewer does not start a second branch.

## Score the implementation

After the code is written, and before you tell the user it is ready, open one review thread on Antigravity with model `gemini-3.8-flash-high`. Role: `review`. Give it the issue number, the branch, and the changed files. It reads the code and does not edit, commit, or open a pull request.

Each gate is worth 2 points, or 0. The score is the sum, out of 10.

1. **The issue.** The diff does what the issue asked. Files outside that work are untouched.
2. **The rules.** A pending edit does not change the timeline. Source video and audio stay untouched. No secrets, footage, or weights.
3. **The check.** It runs the check for the packages that changed and reports the command and the result. A failure scores 0.
4. **The code.** It opens the changed files and names the lines that do the work. A score with no line references is 0.
5. **The screen.** If `apps/desktop` or `packages/ui` changed, it runs `pnpm --filter @chair/desktop dev`, opens `http://localhost:1420`, and takes a screenshot of the screen a person would use. It says what is on that screen. No screenshot scores 0. If those paths did not change, this gate scores 2 and the report says there was no screen to shoot.

Then it deducts for bloat, from 0 to 3. The deduction comes off the gate total. The result cannot go below 0.

- **0.** The change is the smallest one that does the job.
- **−1.** One extra helper, one restated comment, or one unused prop.
- **−2.** A new file or layer that nothing else calls, or a second way to do something the repo already does.
- **−3.** A person would have to learn a structure this issue does not need.

It names the extra pieces and the lines. A deduction with no lines is invalid and counts as 0.

It returns the five gates, the deduction, then one line: `Score: N/10`.

Bring that score back to the user before any merge question. Under 7, do not ask to merge. Ask: "Gemini scored this N/10. The misses are: <the gates that scored 0>. Should I try again?"

A bloat deduction of 2 or 3 holds the pull request even when the score is 7 or above. Ask: "Gemini scored this N/10 and marked it overbuilt. The extra pieces are: <lines>. Should I open a cleanup chat on this same branch?" The cleanup chat is a different model from the one that wrote the code, and it is not Gemini. Use Cursor Auto. It may only delete or shrink what Gemini named. It does not add behavior and it does not open a second branch. After that one cleanup, Gemini scores once more, and you bring that score back. Do not start a second cleanup unless the user asks.

## Calling each other

Open a new T3 thread. Do not keep typing into the same chat.

From a shell, `t3 thread start` opens a top-level thread. Inside a T3 thread, `delegate_task` opens a child thread. The child receives only the task, the role (`implementation`, `review`, or `research`), and the issue number.

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
