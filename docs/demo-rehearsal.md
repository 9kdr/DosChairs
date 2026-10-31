# Demo Rehearsal Checklist

A concise pre-flight checklist for the Chair rough-cut pitch.

## Pitch framing

- **Pitch angle:** Chair delivers a strong rough draft with full accept/reject control.
- **Core rule:** [Propose, never apply](philosophy.md). The agent generates proposed changesets and proxy previews; nothing applies to the timeline without explicit user approval, and source media is never overwritten.

## Rehearsal checklist

### 1. Source footage

- [ ] 15–30 minutes of raw talking-head or vlog footage prepared in a dedicated project directory.
- [ ] Original media verified intact and read-only (Chair never overwrites source media).
- [ ] Audio clean enough for transcription and stem separation.

### 2. Pitch brief

- [ ] Short, explicit prompt/brief ready to drop into the chat UI.
- [ ] Specifies target rough-cut length (~60 seconds), narrative pacing/beat expectations, and named preset styles.

### 3. Expected 60-second cut outputs

- [ ] Story-aware assembly: trimmed talking-head narrative matching story beat sheet.
- [ ] Captions: synchronized subtitle track generated from transcription.
- [ ] SAM 3 effect: at least one subject isolation / matte track applied to emphasize a key moment.
- [ ] Audio pass: dialogue clarity and balanced background music bed.
- [ ] Color grade: applied style profile preset.
- [ ] Motion graphic: one title card or accent graphic element.

### 4. Fallback recording

- [ ] Complete dry-run screen recording of a successful end-to-end generation captured in advance.
- [ ] Pre-rendered export video and timeline artifacts stored locally for instant presentation if network or live services stall.

### 5. Must-green issues before the pitch

Based on current board state (P0-MVP milestones):

- [ ] **#16 [agent] Verifier gates the first preview:** The UI must withhold changesets until the verifier inspects low-res proxy frames and audio snippets against the beat sheet and style profile.
- [ ] **#19 [docs] Demo rehearsal checklist:** This checklist merged and verified.
- [ ] **All foundational P0 issues passing:** Timeline IR (#2, #8), desktop shell and review UI (#3, #25, #57), agent planner/executor (#4, #6, #7, #9, #10, #12), sidecar services (#5, #14), and adapter round-trips (#1, #26).

### 6. Rehearsal-time tuning

- [ ] **#130 [sidecar] Scene-cut threshold tuning:** As noted in issue #130, synthetic flat-color clips under-detected cuts at default thresholds. Validate `detect_scenes` against the actual demo footage during rehearsal; adjust threshold sensitivity (or inspect per-cut scene scores) if real footage under-detects.
