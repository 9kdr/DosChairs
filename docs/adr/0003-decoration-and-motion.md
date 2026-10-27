# 0003 — Decoration, motion, and the desktop shell palette

The window should feel like an app. Neutral surfaces and scoped smooth scroll stayed. Issue #30 removed the stand-in project chat, including its dither field and composer, so an open project is a blank shell.

## Palette

Stepped neutrals keep the shell quiet. The tokens in `app.css` are cool neutrals: light mode is near-white (`#fafafa` background, `#171717` text), and dark mode starts at `#0C0C0C` with surfaces lifting through `#141414` (`card`, `sidebar`), `#1A1A1A` (`surface-fill`, `popover`), and `#1F1F1F` (`surface-raised`). The primary is a neutral accent, not a brand color: near-white (`#f5f5f5`) fill on dark, near-black on light. `color-scheme` is set per theme so native scrollbars and form controls match. Component code references tokens, never literal greys, so the neutrals stay coherent everywhere.

## Smooth scroll is lenis, on the home gallery

Home uses `src/components/smooth-scroll.tsx`: lenis on one scroll viewport, `autoRaf`, `allowNestedScroll`, skipped under reduced motion, destroyed on unmount. The project shell does not scroll.

## The stand-in chat is gone

The project view no longer has a thread list, a transcript, a composer, or a dither backdrop. The vendored dither engine (`src/lib/dither`) and the composer document model left with it. Do not put that scaffolding back. An open project is a header — home, the Chair mark, the project name — and an empty center.

Consequences:

- New colors go in `app.css` tokens only.
- Home scroll feel means `smooth-scroll.tsx`.
- Decoration for a future project screen is a new decision, not a restoration of the chat field.
