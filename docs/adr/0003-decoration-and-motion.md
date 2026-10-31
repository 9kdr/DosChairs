# 0003 — Decoration, motion, and the desktop shell palette

The window should feel like an app. Neutral surfaces and scoped smooth scroll stayed. Issue #30 removed the stand-in project chat, including its dither field. An open project is the Orchestrator bento, not a chat transcript.

## Palette

Stepped neutrals keep the shell quiet. The tokens in `app.css` are cool neutrals: light mode is near-white (`#fafafa` background, `#171717` text), and dark mode starts at `#0C0C0C` with surfaces lifting through `#141414` (`card`, `sidebar`), `#1A1A1A` (`surface-fill`, `popover`), and `#1F1F1F` (`surface-raised`). The primary is a neutral accent, not a brand color: near-white (`#f5f5f5`) fill on dark, near-black on light. `color-scheme` is set per theme so native scrollbars and form controls match. Component code references tokens, never literal greys, so the neutrals stay coherent everywhere.

## Smooth scroll is lenis, on the home gallery

Home uses `src/components/smooth-scroll.tsx`: lenis on one scroll viewport, `autoRaf`, `allowNestedScroll`, skipped under reduced motion, destroyed on unmount. The project shell does not use lenis. The Orchestrator’s right column scrolls on its own when the cards overflow.

## The stand-in chat is gone

The project view no longer has a thread list, a transcript, or a dither backdrop. The vendored dither engine (`src/lib/dither`) left with it. Do not put that scaffolding back.

The header is Home, the project name, and that project's editor logo. The Chair mark sits at the bottom left, the same place as on home. A prompt bar sits just above an icon dock (Orchestrator, Edit, Effects, Colour).

Orchestrator is a two-column bento (`src/orchestrator/`):

- Left, wider: the Plan doc, then a short todo list under it.
- Right: running tasks, then assets, then inspiration and references.

Edit, Effects, and Colour are still empty. The running-tasks card is stand-in rows (a name and a short status), not a live agent.

Consequences:

- New colors go in `app.css` tokens only.
- Home scroll feel means `smooth-scroll.tsx`.
- Decoration for a future project screen is a new decision, not a restoration of the chat field.
