---
name: chair-models
description: Pick a Chair model and open a T3 thread for one specific job. Use when starting work, delegating, reviewing, or when the user mentions Grok, Auto, Gemini, DeepSeek, OpenCode, Antigravity, or T3.
---

# Models

Spend the scarce models on a named problem. Do not open a second chat to keep the first one company.

| When | Who | How to start it |
| --- | --- | --- |
| A short task: one file, one error, a label, a command check | Gemini 3.8 Flash, high, on Antigravity | `t3 thread start --project /var/home/mel/Arch/dc --provider antigravity --model gemini-3.8-flash-high` |
| A real bug or a long change, and you can name the files and the check | DeepSeek v4.1 on OpenCode. This is the free daily pool. Use it on purpose. | `--provider opencode --model opencode/deepseek-v4.1-flash-free` |
| Complex work: several packages, a design choice, or keeping the whole cut consistent | Grok 4.7 on Cursor. This is the workhorse. | `--provider cursor --model grok-4.7-medium` |
| You cannot tell which of the above fits | Cursor Auto | `--provider cursor --model default` |

Claude and Codex are switched off. Do not try to call them.

If a slug is rejected, tell the user the exact error and stop. Do not cycle through other models.

## What to ask

Give the child one issue and nothing else from the parent chat.

- Gemini: the error or the file, and the sentence that means done. Ask for the patch, not a redesign.
- DeepSeek: the issue number, the files it may touch, the check to run, and what it must not change. Do not spend it on a ping or a status reply.
- Grok 4.7: the goal, the constraints, and what to leave alone. Ask it to decide and then do the work.
- Auto: say you are unsure, give the issue, and ask it to pick the smallest next step.

A review call is one question the first model cannot settle, for example "Does this pending edit change the timeline? Point at the line." The reviewer does not start a second branch.

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

"The pull request is ready: link. Checks are green. I have not merged it. Should I merge it into main?"

Too much:

"I'll leverage a multi-agent orchestration layer and proceed to implement the full pipeline across all surfaces."

One note when you start, one if you are blocked, one when it is ready to merge. Do not restate the plan on every turn.
