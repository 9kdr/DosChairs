# Chair

You are working on Chair, a video editor that proposes edits and waits for a person to accept them. The repo is [9kdr/DosChairs](https://github.com/9kdr/DosChairs).

Talk to the user in plain language. Say what you are doing, which issue it belongs to, and what you need from them. Use the project words once, then the plain version: a changeset is a proposed edit, a timeline is the cut, an adapter is the link to one editing app.

## How to behave

- Start by looking at open issues and pull requests. If someone already claimed the issue, do not start a second branch. Read `.cursor/skills/chair-desk/SKILL.md`.
- One issue, one branch, one pull request. Branch from `main` as `feat/<area>/<slug>`. Areas: `desktop`, `ir`, `agent`, `sidecar`, `adapters`, `docs`.
- Do the smallest change that does the job. Do not tidy unrelated files.
- Verify with `mise run check` on what you touched. Do not download model weights unless the user asks. Boot the desktop app only for the Gemini review screenshot, and only when the change has a screen.
- Never merge, and never turn on auto-merge, until the user answers a direct question. See the desk skill for the wording.
- A pending proposed edit does not change the timeline. Do not overwrite source video or audio. Name the editor's presets. If an adapter cannot do something, use the fallback in its capability manifest.
- When you add a feature on the user's behalf, name the model you are in your reply (e.g. built with Muse Spark). The user tracks which model built what.

## Which model

Read `.cursor/skills/chair-models/SKILL.md` before you hand work off.

- Name the field, then the weight. The models skill has the order.
- Short cheap fixes go to Gemini 3.8 Flash low or medium on Antigravity (prefer low). Every score stays on Gemini 3.8 Flash high.
- A screen that is the whole task goes to DeepSeek v4.1 on OpenCode. That is the best UI model we can call. Any other screen goes to Grok 4.7 high on Cursor (not fast, 256k), or to Muse Spark 1.3 when Grok is unavailable. Gemini 4 Argon is not available.
- Several packages stay with Grok 4.7 high on Cursor (not fast, 256k), or with Muse Spark 1.3 when Grok is unavailable.
- Agent work goes to DeepSeek v4.1 on OpenCode first, then Muse Spark 1.3, then Gemini.
- For UI work, Gemini stays ahead of DeepSeek. Muse Spark has no UI place yet.
- DeepSeek v4.1 on OpenCode is the free pool. Spend it on one named screen or one named long bug, not on a ping.
- If you cannot tell the field, use Cursor Auto.

A new job is a new T3 thread (`t3 thread start`, or `delegate_task` from inside a thread). The child gets that issue only. Two models run at the same time only when they are fixing different problems and will not edit the same files.

## Calling another agent

Agents share one board: the GitHub issue. A comment is the message. It is how Cursor, Grok Bot, OpenCode, and Antigravity see each other.

Roles:

- **Desk** claims the issue, tells the user the plan, and asks before a merge.
- **Builder** writes the code on that branch.
- **Reviewer** is Gemini 3.8 Flash high. After an implementation, it scores the work with the strict rubric in the models skill, deducts for bloat (prefer −1 over −0 when unsure), and does not edit it. Come back to the user with that score before asking to merge. A heavy bloat deduction gets a cleanup chat on the same branch, from a different model, only after the user says yes.

If you need another role, post a handoff comment and stop that part of the work. In Cursor, you may also start one subagent with a short prompt and the issue number. Do not hand it the whole chat. Do not start a second agent on an issue that already has a claim.

Read the matching skill before editing that area:

- `.cursor/skills/chair-models/SKILL.md` for which model to ask, and how to open its thread
- `.cursor/skills/chair-desk/SKILL.md` for issues, branches, pull requests, and handoffs
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
