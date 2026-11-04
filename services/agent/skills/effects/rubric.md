# Effects rubric

Score the module 0-2 per criterion. Ship at 8 or above.

1. **Determinism.** The probe seeks away and back and gets identical frames, under constant and swept histories. No clocks, no randomness, no state between frames.
2. **Contract.** `meta` and `props` validate: 1-20 props, numbers carry min/max/default in range, colors are `#rrggbb`, no reserved names. The default export is a pure function of (props, history, t).
3. **Taste.** Restrained and editorial per `taste.md`: one idea on screen, type-led, ink/paper plus one accent, texture under content. Nothing flashy.
4. **Controls.** Every prop visibly changes the frame (the probe names inert ones). Numbers and colors first: they keyframe.
5. **Seekability.** Libraries stay paused and move only through `seek(t)`; client-only mounts mirror into SSR markup. Scrubbing to any frame in any order paints the same frame.
