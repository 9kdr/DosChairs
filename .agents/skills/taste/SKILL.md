---
name: taste
description: "Visual taste for Chair desktop UI, adapted from taste-skill v2. Use when styling, polishing, or reviewing a screen in apps/desktop, or when the user says a screen looks generic, templated, AI-made, or asks to make it look designed."
---

# Taste

Chair screens are app screens: windows people work in, not pages people scroll. The page run from upstream taste-skill does not apply here. Everything below is the app-screen run, adapted for a Tauri desktop window.

## The run

1. Read `vendor/references/app-screens.md` whole before starting screen work. Its numbers are measurements from real product screens, not opinions.
2. Deal a style from the repo root: `node .agents/skills/taste/vendor/scripts/draw.mjs --app --kind <kind> --brief "<one line>" --screens <screens> --options 3`, then commit to one style. Kinds and screens: `draw.mjs --app --list kinds`. Working files land in `.taste-skill/` (gitignored, delete when done).
3. Build with coss components (read the coss skills too). Chair's look is dark with dither and pixel accents; bend the dealt tokens toward it rather than restyling from zero.
4. Lint: `node .agents/skills/taste/vendor/scripts/lint.mjs --app <files>`. Fix FAILs before rendering. A line that must keep a flagged pattern for a real reason carries the comment `taste-skill-ignore`.
5. Look at what you made: screenshot the Tauri window (dev server plus window screenshot, per the review skill), critique against `vendor/references/critique.md` and the tells in `vendor/references/tells.md`, fix, look again.

Upstream's `inspect.mjs` needs a real browser and does not apply to Tauri; the screenshot loop above replaces it. `vendor/assets/charts.js` draws the §6 charts in SVG when a screen needs them.

Craft references: `vendor/references/type.md`, `colour.md`, `layout.md`. Source, pin, and what was skipped: `VENDORED.md`.
