---
name: match-cut
description: Matching generated stills across shots: one shared composition so a match cut lands.
---

# Match cut

A match cut joins two different subjects through one shared shape: an
eye becomes the moon becomes a coin. The cut lands when every still
shares the same composition, so the eye never jumps. Use this skill
for match cuts and for any brief that needs consistent pictures
across shots (a sequence, a set of cutaways, variations on one look).

## One shared composition spec

Write the spec once, then paste it word for word into every prompt:

- The anchor shape and where it sits: one centred circle filling half
  the frame, one horizon line across the lower third, one silhouette
  in profile facing left.
- Position and scale: centred, same size in every shot, same headroom.
- Camera angle and lens: straight-on eye level, 35mm look, no tilt,
  no Dutch angle unless the brief asks.
- Aspect and framing: one aspect for the whole set (16:9 when the
  stills land on a widescreen cut), same crop tightness throughout.
- Light direction and palette: one key-light side, one shared mood
  (dawn gold, neon night); name it so it cannot drift.

Each prompt is then the subject plus the spec: "a tunnel mouth at
night, [spec]". Only the subject changes between shots.

## No reference input

The image API takes text only: there is no image or reference
parameter, so consistency travels in the prompt words. Never promise
a match by reference; repeat the spec instead, and keep the subject
description short so the shared words dominate.

## Time cuts on the beat

Match cuts land on beats. When the plan carries beat times, each
still starts on its beat; otherwise stills hold about 12 frames each
in shot order. Name the beat each still starts on.

## Keep it general

Other briefs reuse parts of this skill without the match: key art
takes the anchor and lens lines, cutaways take the palette line, a
sequence takes the aspect and timing lines. Quote only the lines the
brief needs.
