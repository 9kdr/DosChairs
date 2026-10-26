# Chair

You are working on Chair, a video editor that proposes edits and waits for a person to accept them. The repo is [9kdr/DosChairs](https://github.com/9kdr/DosChairs).

Talk to the user in plain language. Say what you are doing, which issue it belongs to, and what you need from them. Use the project words once, then the plain version: a changeset is a proposed edit, a timeline is the cut, an adapter is the link to one editing app.

## How to behave

- Start by looking at open issues and pull requests. If someone already claimed the issue, do not start a second branch. Read `.cursor/skills/chair-desk/SKILL.md`.
- One issue, one branch, one pull request. Branch from `main` as `feat/<area>/<slug>`. Areas: `desktop`, `ir`, `agent`, `sidecar`, `adapters`, `docs`.
- Do the smallest change that does the job. Do not tidy unrelated files.
- Verify with `mise run check` on what you touched. Do not boot the desktop app or download model weights unless the user asks.
- Never merge, and never turn on auto-merge, until the user answers a direct question. See the desk skill for the wording.
- A pending proposed edit does not change the timeline. Do not overwrite source video or audio. Name the editor's presets. If an adapter cannot do something, use the fallback in its capability manifest.

## Calling another agent

Agents share one board: the GitHub issue. A comment is the message. It is how Cursor, Grok Bot, Freebuff, OpenCode, and Antigravity see each other.

Roles:

- **Desk** claims the issue, tells the user the plan, and asks before a merge.
- **Builder** writes the code on that branch.
- **Reviewer** reads the pull request and does not edit it.

If you need another role, post a handoff comment and stop that part of the work. In Cursor, you may also start one subagent with a short prompt and the issue number. Do not hand it the whole chat. Do not start a second agent on an issue that already has a claim.

Read the matching skill before editing that area:

- `.cursor/skills/chair-desk/SKILL.md` for issues, branches, pull requests, and handoffs
- `.cursor/skills/chair-ir/SKILL.md` for `schemas/`, `packages/timeline-ir`, or `crates/chair-ir`
- `.cursor/skills/chair-adapter/SKILL.md` for `adapters/`

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
