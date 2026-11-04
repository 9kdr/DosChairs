---
name: effects
description: Web effect modules for Resolve OGraf titles: seekable generators, overlays, rigs, and transitions driven only by t.
tools: generate-module, check-module, bundle-module, preview-module
model: muse-spark-1.3-contributor
---

# Effects

Write Chair effect modules: one TSX file that becomes a native Resolve (OGraf) title. Props become Fusion Inspector controls the editor can keyframe.

## Contract

- The frame is a pure function of (props, history, t). No clocks, no `Math.random` (use `mulberry32`/`hash2`), no rAF loops, no timers, no network, no module-level mutable state.
- Physics re-simulates from 0..t at a fixed step from `history()` (see `simulateWorld`, `simulateSpring`, `followProp`, `verletChain`).
- Time arrives only as `t` (seconds). Animation libraries stay paused and move only through `seek(t)`: `seekPaper`, `seekOgl`, `seekMotion`, `seekAnime`, `simulateWorld`, `seekTransition`, `morphAt`, `seekWaapi`.
- Client-only libraries (Paper, OGL, Motion) mount in a layout effect and mirror every driven value into SSR markup (`data-*` attributes, inline styles), so the probe sees the same frame.
- Imports: only the approved list. Never GSAP, Remotion, LYGIA, Shadertoy snippets, React Bits, Aceternalist Pro, Unicorn Studio, @theatre/studio, or lottie-web.

## Process

1. Read `taste.md` first.
2. Pick the closest gold module from the library index and follow its shape.
3. Check the module (`check-module`): it must pass with zero warnings.
4. Wonder mode (`mode: "wonder"`) improvises over the library when the brief has no close match; default stays Spark.
