# Vendored from taste-skill v2

- Source: https://github.com/Leonxlnx/taste-skill
- Pinned at: `12af471f627f866411b4bd785b19646d3672784c` (main, 2026-10-31)
- License: MIT, Copyright (c) 2026 Leonxlnx. Full text in upstream `LICENSE`.
- Files, verbatim under `vendor/`, mirroring upstream `skills/taste-skill/` layout:
  - `references/app-screens.md`, `critique.md`, `tells.md`, `type.md`, `colour.md`, `layout.md`
  - `library/app.json` (read by `draw.mjs --app`)
  - `scripts/draw.mjs`, `scripts/lint.mjs`, `scripts/lib/app-draw.mjs`
  - `assets/app.css`, `assets/charts.js` (referenced by app-screens §6)

Skipped deliberately: upstream `SKILL.md` page run (marketing bias; our `SKILL.md` is the entry), `imagery.md`/`copy.md`/`research.md`/`scenes.md` and the marketing library JSONs (~1.4 MB), `inspect.mjs` plus its CDP lib (needs a real browser; Tauri uses the screenshot loop instead), `assets.mjs`/`scenes.mjs`, evals, and examples.

To update: re-fetch the listed files at a new upstream commit, re-run `draw.mjs --app --list kinds` and `lint.mjs --app` on a sample, and bump the pin above.
