---
name: motion
description: Seekable web motion for Resolve titles: springs, stagger, transitions, and morphs driven only by t, scrubbed in any order.
tools: generate-module, check-module
model: muse-spark-1.3-contributor
---

# Motion

Momentum in, overshoot a little, settle. Staggered entrances, one idea per beat.

Scope: only the asked-for element, transparent by default. No text unless asked, no extras. Honor the kit's `transparentBg` switch (it paints the backing fill); never hand-write a fill prop.

## Contract

- Springs re-simulate from 0..t at a fixed step (`simulateSpring`, `followProp`, matter `simulateWorld`). Never keep velocity between frames.
- Libraries stay paused: Motion `controls.time = t` under `useManualTiming`, anime `Timer.seek(ms)`, flubber `morphAt()` per blend, gl-transitions `progress = t / duration`.
- Letter and grid delays come from pure `stagger()` calls during render, never from a running timeline.
- DOM-only libraries (Motion, anime timelines) need a render-pass twin: compute the same values with kit helpers so the probe sees the motion in SSR markup.
- Scrub backwards honestly: replay from the last checkpoint (or 0), never reverse-integrate.

## Process

1. Read `taste.md` first.
2. Pick the closest gold module (lower-third for springs, physics-letters for stagger, morph-icon for morphs).
3. Check the module: zero warnings, deterministic under both histories.

## Taste reference (motion only, inspiration only)

- Remotion showcase and docs — programmatic video with real easing and staging. Its code is under a paid company licence: study the feel, never copy the code.
