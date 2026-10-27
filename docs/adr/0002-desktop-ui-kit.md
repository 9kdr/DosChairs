# 0002 — The desktop UI is built on coss

The desktop window in `apps/desktop` is built from [coss](https://coss.com/ui), a shadcn-compatible component registry (`@coss` in `apps/desktop/components.json`) that renders on Base UI primitives with Tailwind CSS 4. Components are copied into `src/components/ui` rather than imported from a package, so the app owns every line it ships.

Consequences:

- One place to restyle: design tokens live in `src/styles/app.css`, components in `src/components/ui`.
- New components come from the registry (`pnpm dlx shadcn add` against the `@coss` registry) and stay vendorable — no runtime dependency on coss itself.
- Behavior (popovers, menus, tooltips, collapsibles) comes from Base UI; Chair only styles it.
- Glin UI and Radix UI are not used.
