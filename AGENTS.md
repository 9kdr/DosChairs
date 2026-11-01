# Chair

You are working on Chair, a video editor that proposes edits and waits for a person to accept them. The repo is [9kdr/DosChairs](https://github.com/9kdr/DosChairs). Product rule: [propose, never apply](docs/philosophy.md).

Talk to the user in plain language. Say what you are doing, which issue it belongs to, and what you need from them. Use the project words once, then the plain version: a changeset is a proposed edit, a timeline is the cut, an adapter is the link to one editing app.

## How to behave

- Start by looking at open issues and pull requests. If someone already claimed the issue, do not start a second branch. Read `.cursor/skills/chair-desk/SKILL.md`.
- One issue, one branch, one pull request. Branch from `main` as `feat/<area>/<slug>`. Areas: `desktop`, `ir`, `agent`, `sidecar`, `adapters`, `docs`.
- Do the smallest change that does the job. Do not tidy unrelated files.
- On a change that is moderately worth a review, Gemini 3.8 Flash high on Antigravity runs `mise run check` before you open the pull request, then scores. Moderate means a behavior change, a new file, or a diff that touches the cut, the window, a schema, an adapter, or a check. Open the pull request only after that check passes. A typo, a comment, or a one-line wording fix can skip the score; run `mise run check` yourself. Do not download model weights unless the user asks. Boot the desktop app only for the Gemini review screenshot, and only when the change has a screen.
- **Always give proof to the user on the changes; this is mainly what you must remember from this.** Proof scales with the change (see Working with Mel): a screenshot for a screen, pasted command output or status numbers for backend work, the check plus the score for pure code. If the harness cannot take a screenshot, give the exact click path plus what each step should show, in words.
- Never merge, and never turn on auto-merge, until the user answers a direct question. See the desk skill for the wording.
- Commit early and often on the branch while work lands; checkpoint commits need no review. The check-and-score review happens once, when you want to open the pull request. Nothing merges until that review passes and the user answers.
- A pending proposed edit does not change the timeline. Do not overwrite source video or audio. Name the editor's presets. If an adapter cannot do something, use the fallback in its capability manifest.
- When you add a feature on the user's behalf, name the model you are in your reply (e.g. built with Muse Spark). The user tracks which model built what.

## Working with Mel

- Mel is semi-technical and acts as the client. They judge what they can see and run. Agents get trusted on code they cannot see.
- Report what the implementation actually did, never just the plan. Name what changed in the app, the check that ran, and the review score.
- Every pull request carries its proof: a visual (screenshot, clip, or other capture) when there is a screen, the Gemini score, and a short explanation of the change. It never merges until Mel says so. The main agent reports back per issue: what the issue was, what got fixed, and the proof.
- When the user wants another round on an already-open PR, comment on the PR first: one line saying the user is reiterating, so the next push doesn't land unexplained.
- Visual or behavior-changing work comes back with what a person can check: where to look or click, what to expect, and a screenshot when there is a screen. It never merges until Mel has looked and said so.
- Pure code work still reports its check and score. It needs no eyes-on before the pull request.
- When backend work needs checking, make it checkable. Expose counts, timings, or status on the service's health or status endpoint: jobs queued, jobs done, last error, render time. Point at the numbers in the report so Mel can verify without reading code.

## Which model

Read `.cursor/skills/chair-models/SKILL.md` before you hand work off. The same text is linked from `.agents/skills/` for harnesses that do not read `.cursor`.

- Name the field, then the weight. The models skill has the order.
- Quick work goes to Gemini 3.8 Flash high on Antigravity: one file, one error, a label, a question, and the check before a pull request. Trivial one-file fixes may use lower effort or Muse Spark 1.3 contributor for speed.
- A change that is moderately worth a review goes to that same Gemini before you open the pull request. Moderate means a behavior change, a new file, or a diff that touches the cut, the window, a schema, an adapter, or a check. Gemini runs `mise run check` on what changed, then scores. It does not edit. Open the pull request only after the check passes. A typo, a comment, or a one-line wording fix can skip the score.
- A screen stays with Grok 4.7 high on Cursor (not fast, 256k). Several packages stay there too.
- DeepSeek v4.1 on OpenCode is the free daily pool. Spend it only when the user names the screen or names the long bug. One of those a day is the idea.
- Muse Spark 1.3 is the fallback when Grok 4.7 or DeepSeek v4.1 is unavailable.
- If the job is small and you cannot tell the field, use Gemini. If it spans several packages, use Grok 4.7 high.
- Gemini 4 Argon is not on this account. Claude and Codex stay switched off.

When you delegate implementation, end the task with this paragraph. A child does not inherit the parent chat, and an Antigravity thread does not load this file:

"Before you open a pull request for a change that is moderately worth a review, delegate the check and the score to Gemini 3.8 Flash high on Antigravity (model `gemini-3.8-flash-high`). Read `.agents/skills/chair-models/SKILL.md` and follow Score the implementation. Also read `.agents/skills/ponytail-review/SKILL.md` and the ladder in `.agents/skills/ponytail/SKILL.md` at level full. The bloat deduction follows that lean pass. Gemini runs `mise run check` on what changed, scores, and does not edit. Open the pull request only after the check passes. Quick work uses that same Gemini. OpenCode only if the user named the screen or the long bug. Never merge or enable auto-merge; report the PR back instead."

A new job is a new T3 thread (`t3 thread start`, or `delegate_task` from inside a thread). The child gets that issue and the paragraph above. Two models run at the same time only when they are fixing different problems and will not edit the same files.
Any chat may spawn separate sub-chats with no callback to the parent when the task is long, spans multiple issues, or Mel will follow that chat directly.

An agent that receives a worktree for an issue stays free for chat. It sets up subagents in separate worktrees and never edits code itself.

In practice, a main chat usually holds one branch and works its related issues through in sequence, which keeps context warm and the history readable. Pieces that might conflict tend to live in subagents with separate worktrees. An issue that grows long or multi-step tends to work better with its own chat and branch, following these same rules.

When using muse models, only use their contributor version!
## Calling another agent

Agents share one board: the GitHub issue. A comment is the message. It is how Cursor, Grok Bot, OpenCode, and Antigravity see each other. Sign everything shared so the others know who wrote it: end issue and PR comments with "This message is on behalf of Mel by [Model]", and end every pull request body with "This PR is on behalf of Mel by [Model]", naming the model sending it. A PR without the line is incomplete, no matter how good the diff.

When calling a subagent within your thread, ONLY use T3Code's delegation system!
Roles:

- **Desk** claims the issue, tells the user the plan, and asks before a merge.
- **Builder** writes the code on that branch.
- **Reviewer** is Gemini 3.8 Flash high. Before a moderate change is committed, it runs `mise run check` on what changed, then scores with the rubric in the models skill. The bloat deduction follows `.agents/skills/ponytail-review/SKILL.md` and the ladder in `.agents/skills/ponytail/SKILL.md` at level full (prefer −1 over −0 when unsure). It does not edit. Come back to the user with that score before asking to merge. A heavy bloat deduction gets a cleanup chat on the same branch, from a different model, only after the user says yes.

If you need another role, post a handoff comment and stop that part of the work. In Cursor, you may also start one subagent with a short prompt and the issue number. Do not hand it the whole chat. Do not start a second agent on an issue that already has a claim.

Read the matching skill before editing that area:

- `.cursor/skills/chair-models/SKILL.md` for which model to ask, and how to open its thread. Same file: `.agents/skills/chair-models/SKILL.md`
- `.agents/skills/chair-review/SKILL.md` before you open a pull request for a change that is moderately worth a review
- `.agents/skills/ponytail-review/SKILL.md` and `.agents/skills/ponytail/SKILL.md` when scoring. The ladder is level full. Do not replace those files with a summary.
- `.cursor/skills/chair-desk/SKILL.md` for issues, branches, pull requests, and handoffs. Same file: `.agents/skills/chair-desk/SKILL.md`
- `.agents/skills/chair-modernize/SKILL.md` when asked to rebase a PR or modernize. Same file: `.cursor/skills/chair-modernize/SKILL.md`
- `.cursor/skills/chair-ir/SKILL.md` for `schemas/`, `packages/timeline-ir`, or `crates/chair-ir`
- `.cursor/skills/chair-adapter/SKILL.md` for `adapters/`
- `.agents/skills/coss/SKILL.md` and `.agents/skills/coss-particles/SKILL.md` before editing `apps/desktop` or `packages/ui`. The window uses coss. Use its components. Do not invent a second set.
- `.agents/skills/taste/SKILL.md` before styling, polishing, or reviewing a screen in `apps/desktop`. App screens only; the page run does not apply.

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
