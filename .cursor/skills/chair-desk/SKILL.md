---
name: chair-desk
description: Claim Chair issues, open one branch and one pull request, hand work to another agent, and ask the user before merging. Use when starting work, opening or updating a pull request, seeing a claim, avoiding duplicate work, or when the user mentions merge, handoff, desk, or another agent.
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

## Calling another agent

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

## Pull requests

Open a pull request when the change is ready for eyes. Link the issue. Say in the body what a person can check.

Remove `agent:claimed` when the pull request is open and add `agent:needs-review`, or leave the claim if you are still pushing commits. Do not open a second pull request for the same issue.

## Merge

Ask out loud:

"The pull request is ready: <link>. Checks are <green or the name of the failing job>. I have not merged it. Should I merge it into main?"

Merge only after the user answers that question with a yes. Then delete the branch and close the loop on the issue in one sentence.
