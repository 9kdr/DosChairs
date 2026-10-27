---
name: chair-review
description: "Use before a commit, before mise run check, and whenever a change is moderately worth a review. Sends the check and the score to Gemini 3.8 Flash high on Antigravity. Also use for a quick task, one file, one error, a label, or a question."
---

# Review

Use this before a commit when the change is moderately worth a review.

Moderate means a behavior change, a new file, or a diff that touches the cut, the window, a schema, an adapter, or a check. A typo, a comment, or a one-line wording fix can skip the score. Run `mise run check` yourself for those.

Delegate the review to Gemini 3.8 Flash high on Antigravity, model `gemini-3.8-flash-high`. Role: `review`. Tell it to read `.agents/skills/chair-models/SKILL.md` and follow "Score the implementation". Tell it to read `.agents/skills/ponytail-review/SKILL.md` and the ladder in `.agents/skills/ponytail/SKILL.md` at level full, and to take the bloat deduction from that lean pass. It runs `mise run check` on what changed, then scores. It does not edit, commit, or open a pull request.

Commit only after the check passes. Bring the score back before you say the work is ready.

Quick work uses that same model: one file, one error, a label, a question. Ask for the patch, not a redesign.

OpenCode DeepSeek v4.1 only when the user names the screen or names the long bug.

When you delegate implementation, end the task with this paragraph. A child does not inherit your chat, and an Antigravity thread does not load `AGENTS.md`:

"Before you commit a change that is moderately worth a review, delegate the check and the score to Gemini 3.8 Flash high on Antigravity (model `gemini-3.8-flash-high`). Read `.agents/skills/chair-models/SKILL.md` and follow Score the implementation. Also read `.agents/skills/ponytail-review/SKILL.md` and the ladder in `.agents/skills/ponytail/SKILL.md` at level full. The bloat deduction follows that lean pass. Gemini runs `mise run check` on what changed, scores, and does not edit. Commit only after the check passes. Quick work uses that same Gemini. OpenCode only if the user named the screen or the long bug."
