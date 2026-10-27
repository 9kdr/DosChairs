# 0003 — Decoration, motion, and warmth on the desktop shell

The chat shell should feel like an app, not a web page. Three decisions did the work: a dithered backdrop instead of gradients, lenis for smooth scrolling, and a warm palette instead of pure neutrals.

## The dither engine is dithercn, pulled directly

Decoration comes from [dithercn](https://dithercn.dev) ([source](https://github.com/opencoredev/dithercn)), a dither engine for shadcn apps. It is installed with the shadcn registry (`npx shadcn@latest add https://dithercn.dev/r/dither-core.json`) and vendored into `apps/desktop/src/lib/dither` — no runtime dependency. Its tokens (`--dither-ink`, `--dither-paper`, `--dither-cell`, `--dither-bloom`, `--dither-color-*`) live in `app.css` and follow our theme variables.

We did not copy a ready-made background from React Bits or dithercn's catalog. Following dithercn's own guidance, the backdrop is a small custom field written on the engine: `src/components/chat/dither-backdrop.tsx` renders `DitherShader` with a GLSL field that draws a quiet night scene — a solid paper sky, one hard-edged moon with a two-cell dithered ring, and stepped Stardew-style water bands along the bottom, in two theme tones (paper → ink) on the `bayer4` matrix at a 4px cell, `speed` of 0.35 with one dither level per matrix rank (`levels` of 17), and a `stillTime` frame for `prefers-reduced-motion`. The water fades to near-paper at the bottom edge so the composer sits on calm ground. The engine handles resize, offscreen pausing, context limits, and reduced motion; we only own the field.

## Gradients are gone

The old `.app-atmosphere` radial gradients (indigo/sky in `--atmosphere`) were removed. All depth now comes from the dither, the glass surfaces, and flat warm tones. Any future dither-style decoration should go through the engine (`DitherShader`, `fillStyle`, `FillPattern`), not hand-rolled gradients.

## Smooth scroll is lenis, scoped like dithercn.dev

dithercn.dev runs lenis with `lerp: 0.1`, `autoRaf`, and `allowNestedScroll`, skips it under reduced motion, and destroys it on unmount. `src/components/chat/smooth-scroll.tsx` does the same, scoped to one scroll viewport instead of the page: `SmoothScrollTarget` wraps the chat conversation's viewport, so the message log glides while the sidebar and cut panel keep native scrolling. The jump-to-latest button keeps its native behavior.

## Warm palette, Claude-inspired

Pure neutral greys read flat and cold. The tokens in `app.css` now follow Claude's warmth: cream light mode (`#faf9f5` background, `#3d3929` text), warm charcoal dark mode (`#262624` background, `#1f1e1c` sidebar, `#f5f4ec` text), and a coral primary (`#d97757`) shared by buttons, selection highlight, and the dither's lamp glow. `color-scheme` is set per theme so native scrollbars and form controls match. Component code references tokens, never literal greys, so the warmth stays coherent everywhere.

## Scale

The empty state was retuned to read as an app surface rather than a small web hero: larger greeting (1.6rem) and clapper mark, taller suggestion rows, and a taller composer (min 4rem).

## Vendored-code notes

Two one-line touches keep the engine compiling under our strict tsconfig: `lib` is `ES2023` (the engine uses `Array.prototype.toSorted`, supported in Tauri's WebKitGTK and Chromium), and `diffuse.ts` guards one indexed access for `noUncheckedIndexedAccess`.

Consequences:

- New decoration should be a field on the engine, with theme palette names, slow motion, and a reduced-motion still frame — see dithercn's agent skill for the contract.
- Touching scroll feel means `smooth-scroll.tsx`; nested scroll areas are already allowed.
- New colors go in `app.css` tokens only; the dither palette reads the same variables.
