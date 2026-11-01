---
name: chair-desk
description: "Claim Chair issues, open one branch and one pull request, hand work to another agent, and ask the user before merging. Use when starting work, committing, reviewing a moderate change, opening or updating a pull request, seeing a claim, avoiding duplicate work, or when the user mentions merge, handoff, desk, or another agent."
---

# Desk

The GitHub issue is the board. Comments are how agents call each other.

## Before you edit

1. `gh issue view <n> --comments` and `gh pr list --search <n>`.
2. If the issue has an open claim and an open pull request, stop. Tell the user who has it.
3. If the claim is older than two days and there is no pull request, ask the user before taking it.
4. If it is free, comment and add `agent:claimed`:

```
Claimed
Agent: <desk, builder, or reviewer>
Tool: <Cursor, Grok Bot, Freebuff, OpenCode, or Antigravity>
Branch: feat/<area>/<slug>
Doing: <one sentence>
Not doing: <what you will leave>
Need: <nothing, or which role you need>
```

5. Branch from an up-to-date `main`.

## Chats and branches

A main chat usually holds one branch and works its related issues through in sequence. A piece that might conflict with the main line of work tends to belong in a subagent with a separate worktree. An issue that grows long or multi-step tends to work better as its own chat with its own branch, claimed and tracked like any other.

## Calling another agent

Pick the model with `.cursor/skills/chair-models/SKILL.md`. Open a new T3 thread for that one problem. From a shell, use `t3 thread start` on project `/var/home/mel/Arch/dc`. Inside a T3 thread, use `delegate_task`. Do not paste the parent chat in. Do end an implementation task with the before-commit paragraph from that skill. A child does not inherit your chat.

Post this on the issue, then stop that part of the work:

```
Handoff
From: <role>
To: <role>
Issue: #<n>
PR: <link or none>
Ask: <one sentence>
Done when: <what the other agent should report back>
```

Switch the labels: `agent:needs-review` for a reviewer, `agent:needs-user` when only the user can decide.

In Cursor, you may start one subagent with the issue number, the handoff text, and nothing else from the chat. One subagent, one job.

## After the code

A typo, a comment, or a one-line wording fix can be committed after you run `mise run check` yourself.

Before you open a pull request for a change that is moderately worth a review, send it to Gemini 3.8 Flash high with the rubric in `.cursor/skills/chair-models/SKILL.md`. Moderate means a behavior change, a new file, or a diff that touches the cut, the window, a schema, an adapter, or a check. Wait for the check and the score. Gemini does not edit the branch. Open the pull request only after the check passes. Bring the score back before you tell the user the work is ready.

Under 7, add `agent:needs-user` and ask if you should try again. A bloat deduction of 2 or 3 also waits, even when the score is 7 or above. Ask before opening a cleanup chat. That chat uses Cursor Auto, on this same branch, and only removes what Gemini named. Gemini scores that cleanup once. At 7 or above, with a bloat deduction of 0 or 1, open the pull request and then ask about merging. Mention a −1 in the report so it can be cleaned later.

## Pull requests

Open a pull request when the score is 7 or above. Link the issue. Say in the body what a person can check, and include the score.

Remove `agent:claimed` when the pull request is open and add `agent:needs-review`, or leave the claim if you are still pushing commits. Do not open a second pull request for the same issue.

## Merge

Ask out loud:

"The pull request is ready: <link>. Checks are <green or the name of the failing job>. I have not merged it. Should I merge it into main?"

Merge only after the user answers that question with a yes. Then delete the branch and close the loop on the issue in one sentence.
