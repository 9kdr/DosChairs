---
name: chair-ir
description: Keep Chair's timeline shape in sync across the schema, TypeScript, and Rust. Use when editing schemas/, packages/timeline-ir, or crates/chair-ir, or when the user mentions the timeline format or a proposed edit.
---

# Timeline shape

`schemas/` is the source of truth. `packages/timeline-ir` and `crates/chair-ir` follow it.

- Change all three in the same pull request. Say so on the issue if that crosses areas.
- Update the fixture under `fixtures/` and run `pnpm test:schemas`.
- A proposed edit with status `pending` must not change the timeline. Accepted items are the only ones that can.
- Do not overwrite source media. A new matte, caption, or stem is a new piece on the timeline.

If this work needs an editor adapter, hand off with the desk skill instead of editing `adapters/` in the same pass.
