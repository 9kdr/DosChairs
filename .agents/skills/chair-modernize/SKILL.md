---
name: chair-modernize
description: "Bring a stale pull request up to date. Use when asked to rebase a PR or modernize. Re-validates the idea before touching the branch, then rebases, checks, and pushes with lease."
---

# Modernize

Modernize the idea, not just the branch. A clean rebase does not prove that the PR still belongs in the product. Adapted from tstack's `modernize` skill under our rules: claims, review gates, and no merge without the user's direct answer.

## Guardrails

- Check the issue board first. If someone owns the PR's issue, post a handoff comment before touching the branch; do not start rival work.
- Fetch latest `origin/main` and the PR head before starting.
- Treat worktree changes as user-owned. Use a disposable worktree when the active one is dirty or busy.
- Modernizing authorizes rebasing and updating the PR branch. It does not authorize merging, closing, changing the base, or expanding scope.
- Force-push only after the user confirms, and only with `--force-with-lease` against the head SHA observed before the rebase. If the lease fails, fetch and reassess instead of overwriting.
- Sign every PR comment per the desk skill.

## Establish the PR's intent

Record the PR URL, state, base, head branch, head SHA, author, checks, and review state. Read the title, body, linked issues, commits, review threads, and full diff. State the smallest coherent goal before judging the implementation. Record the merge base so the original PR and later base changes can be judged separately.

## Check what changed around it

Inspect base-branch commits since the PR diverged. Search merged and open PRs for replacements or competing implementations. Look beyond overlapping lines: is the problem already solved, did types or schemas move on, was the touched code deleted or simplified, would landing restore old behavior or add a second way to do the same thing, is the benefit still worth the cost. A PR with no conflicts is not automatically current.

## Choose a disposition before pushing

- **MODERNIZE**: the goal still holds and the shape is still right. Rebase, resolve, check, push.
- **REWORK**: the goal holds but a mechanical rebase would preserve the wrong implementation. Explain the smallest credible rewrite and stop before pushing unless the rework was also asked for.
- **CLOSE**: superseded, obsolete, or no longer worth its cost. Cite concrete evidence and stop. Never close without explicit permission.

Recommend `CLOSE` willingly. Age is not evidence and sunk effort is not a reason.

## Rebase without losing intent

For `MODERNIZE`:

1. Work in a disposable worktree at the recorded PR head.
2. Rebase onto the freshly fetched base.
3. Resolve each conflict for the PR's current intent and the base's newer invariants. A conflict that reveals a product disagreement means stopping and reconsidering, not guessing.
4. Compare pre- and post-rebase series with `git range-diff` and inspect the final diff. Nothing intended disappears; nothing already landed returns.
5. Run the focused checks for the touched area (`mise run check` covers it). Tell real failures from pre-existing or infrastructure ones.
6. If conflict resolution changed behavior, the change is moderate and needs the review gate before it lands: score first, per the review skill.
7. Push with `--force-with-lease` on the observed SHA, after the user's confirmation.

Do not merge the PR.

## Report

Lead with `MODERNIZE`, `REWORK`, or `CLOSE` and the reason. Then: what changed on the base, conceptual conflicts found or ruled out, rebase and push result, checks and their results, and the remaining decision with a link to the PR. Separate observed facts from judgment, and say what could not be verified.
