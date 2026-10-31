# Chair

You are working on Chair, a video editor that proposes edits and waits for a person to accept them. The repo is [9kdr/DosChairs](https://github.com/9kdr/DosChairs).

Talk to the user in plain language. Say what you are doing, which issue it belongs to, and what you need from them. Use the project words once, then the plain version: a changeset is a proposed edit, a timeline is the cut, an adapter is the link to one editing app.

## How to behave

- Start by looking at open issues and pull requests. If someone already claimed the issue, do not start a second branch. Read `.cursor/skills/chair-desk/SKILL.md`.
- One issue, one branch, one pull request. Branch from `main` as `feat/<area>/<slug>`. Areas: `desktop`, `ir`, `agent`, `sidecar`, `adapters`, `docs`.
- Do the smallest change that does the job. Do not tidy unrelated files.
- On a change that is moderately worth a review, Gemini 3.8 Flash high on Antigravity runs `mise run check` before you commit, then scores. Moderate means a behavior change, a new file, or a diff that touches the cut, the window, a schema, an adapter, or a check. Commit only after that check passes. A typo, a comment, or a one-line wording fix can skip the score; run `mise run check` yourself. Do not download model weights unless the user asks. Boot the desktop app only for the Gemini review screenshot, and only when the change has a screen.
- Never merge, and never turn on auto-merge, until the user answers a direct question. See the desk skill for the wording.
- A pending proposed edit does not change the timeline. Do not overwrite source video or audio. Name the editor's presets. If an adapter cannot do something, use the fallback in its capability manifest.
- When you add a feature on the user's behalf, name the model you are in your reply (e.g. built with Muse Spark). The user tracks which model built what.

## Which model

Read `.cursor/skills/chair-models/SKILL.md` before you hand work off. The same text is linked from `.agents/skills/` for harnesses that do not read `.cursor`.

- Name the field, then the weight. The models skill has the order.
- Quick work goes to Gemini 3.8 Flash high on Antigravity: one file, one error, a label, a question, and the check before a commit.
- A change that is moderately worth a review goes to that same Gemini before you commit. Moderate means a behavior change, a new file, or a diff that touches the cut, the window, a schema, an adapter, or a check. Gemini runs `mise run check` on what changed, then scores. It does not edit. Commit only after the check passes. A typo, a comment, or a one-line wording fix can skip the score.
- A screen stays with Grok 4.7 high on Cursor (not fast, 256k). Several packages stay there too.
- DeepSeek v4.1 on OpenCode is the free daily pool. Spend it only when the user names the screen or names the long bug. One of those a day is the idea.
- Muse Spark 1.3 is the fallback when Grok 4.7 or DeepSeek v4.1 is unavailable.
- If the job is small and you cannot tell the field, use Gemini. If it spans several packages, use Grok 4.7 high.
- Gemini 4 Argon is not on this account. Claude and Codex stay switched off.

When you delegate implementation, end the task with this paragraph. A child does not inherit the parent chat, and an Antigravity thread does not load this file:

"Before you commit a change that is moderately worth a review, delegate the check and the score to Gemini 3.8 Flash high on Antigravity (model `gemini-3.8-flash-high`). Read `.agents/skills/chair-models/SKILL.md` and follow Score the implementation. Also read `.agents/skills/ponytail-review/SKILL.md` and the ladder in `.agents/skills/ponytail/SKILL.md` at level full. The bloat deduction follows that lean pass. Gemini runs `mise run check` on what changed, scores, and does not edit. Commit only after the check passes. Quick work uses that same Gemini. OpenCode only if the user named the screen or the long bug."

A new job is a new T3 thread (`t3 thread start`, or `delegate_task` from inside a thread). The child gets that issue and the paragraph above. Two models run at the same time only when they are fixing different problems and will not edit the same files.

## Calling another agent

Agents share one board: the GitHub issue. A comment is the message. It is how Cursor, Grok Bot, OpenCode, and Antigravity see each other. Sign each comment so the others know who wrote it: end with "This message is on behalf of Mel by [Model]", naming the model sending it.

When calling a subagent within your thread, ONLY use T3Code's delegation system!
Roles:

- **Desk** claims the issue, tells the user the plan, and asks before a merge.
- **Builder** writes the code on that branch.
- **Reviewer** is Gemini 3.8 Flash high. Before a moderate change is committed, it runs `mise run check` on what changed, then scores with the rubric in the models skill. The bloat deduction follows `.agents/skills/ponytail-review/SKILL.md` and the ladder in `.agents/skills/ponytail/SKILL.md` at level full (prefer −1 over −0 when unsure). It does not edit. Come back to the user with that score before asking to merge. A heavy bloat deduction gets a cleanup chat on the same branch, from a different model, only after the user says yes.

If you need another role, post a handoff comment and stop that part of the work. In Cursor, you may also start one subagent with a short prompt and the issue number. Do not hand it the whole chat. Do not start a second agent on an issue that already has a claim.

Read the matching skill before editing that area:

- `.cursor/skills/chair-models/SKILL.md` for which model to ask, and how to open its thread. Same file: `.agents/skills/chair-models/SKILL.md`
- `.agents/skills/chair-review/SKILL.md` before you commit a change that is moderately worth a review
- `.agents/skills/ponytail-review/SKILL.md` and `.agents/skills/ponytail/SKILL.md` when scoring. The ladder is level full. Do not replace those files with a summary.
- `.cursor/skills/chair-desk/SKILL.md` for issues, branches, pull requests, and handoffs. Same file: `.agents/skills/chair-desk/SKILL.md`
- `.cursor/skills/chair-ir/SKILL.md` for `schemas/`, `packages/timeline-ir`, or `crates/chair-ir`
- `.cursor/skills/chair-adapter/SKILL.md` for `adapters/`
- `.agents/skills/coss/SKILL.md` and `.agents/skills/coss-particles/SKILL.md` before editing `apps/desktop` or `packages/ui`. The window uses coss. Use its components. Do not invent a second set.

## Where things live

| Path | What it is |
| --- | --- |
| `apps/desktop` | The app window |
| `packages/` | Types the window and the agent share |
| `crates/chair-ir` | The timeline, in Rust |
| `services/agent` | Plans and checks the edit |
| `services/sidecar` | Masks, audio, and preview files |
| `adapters/` | Resolve, Kdenlive, and interchange |
| `schemas/` | The shape of the timeline and the proposed edit |
