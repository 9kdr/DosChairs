# MVP

The demo drops in 15–30 minutes of talking-head or vlog footage plus a short brief and returns about a 60-second rough cut: story-aware assembly, captions, one SAM 3 effect, dialogue/music balance, a grade, and one motion-graphic element.

Pitch: the agent proposes a diff against a timeline, verifies a proxy, and uses the editor’s own presets.

## Must-have

- Timeline IR and changeset review
- One real adapter round-trip (Kdenlive, with Resolve if Studio is available)
- Transcription, shot index, captions
- Planner / executor / verifier loop
- SAM 3 mask as a separate matte track
- Style presets referenced by name
- Chat UI in the Tauri shell

## Should-have

- SAM Audio stems
- Motion templates
- Reference-based grading

## Stretch, cut first if time runs out

1. SAM 3D
2. Muse image generation
3. Premiere adapter

## Open work

Issues and milestones on GitHub track this list. Milestones:

| Milestone | Lands |
| --- | --- |
| M0 Foundation | IR, one adapter read/write, health checks, UI shell |
| M1 Agent loop | Transcript, shot index, edit ops, changeset UI wired to the agent |
| M2 Story and style | Beat sheet, style profile, captions, SAM 3, audio pass |
| M3 Demo polish | Verifier gate, grade, motion template, demo rehearsal |

Suggested split: one person on adapters and IR, one on the agent, one on the sidecar, one on the UI. Schema PRs stay small so those four branches can merge independently.
