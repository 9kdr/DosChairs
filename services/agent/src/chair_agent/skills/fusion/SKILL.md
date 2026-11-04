# Fusion builder skill

One shared Fusion expert. The motion, effects/pieces, graphics and color
agents keep their own taste and all hand a node-graph spec to this one
builder, which knows how to build, connect, animate and lay out nodes.
Fusion covers compositing, design, wireframing and effects; motion
touches the whole app, so a rig is just baked keys on the same graph.

## What you hand over

An effect spec: layers of type `shape`, `text`, `image` or `shader`,
each with `params` and `curves`. The builder maps it to native tools,
builds it tool-by-tool on a NEW comp version (never touching the
person's existing comp), and lays the Flow out left to right.

## Safe native tools

| You write | Builder makes |
|---|---|
| `shape` + `kind: rect/ellipse` | Background + Rectangle/Ellipse mask |
| `text` | Text+ |
| `image` + `src` | Loader on that file |
| `shader` + `look: film-grain/dither/halftone/fast-noise/gradient/glow` | FilmGrain, Custom (Bayer/halftone math), FastNoise, gradient Background, SoftGlow |
| `shader` without a look | Loader on your baked PNG sequence (`sequences`) |
| `fx: blur/glow/grade` | Blur, SoftGlow, ColorCorrector |
| position/rotation/scale | Transform (XYPath when animated) |
| `blend`, `opacity` | Merge over the layers below |

Anything else falls back to a rendered clip instead of faking nodes.

## Naming

Keep layer ids short, ASCII, stable (`ball`, `title`, `dither`).
The builder names nodes `{Prefix}_{layerid}` (`Bg_ball`, `Xf_title`).

## Keep everything keyframable

- Curves are key lists in spec units (pixels, seconds); the builder
  converts to frames and 0..1 Fusion values.
- `easing: linear` (default) or `hold`; handles are `[dtSec, dv]`.
- Animate position with `x`/`y` curves (never a raw point track).
- A rig hands `baked` keys (`x`, `y`, `rotation`, `scale`, `scaley`);
  dense baked keys ride as Bezier splines, no resampling needed. `scaley`
  keeps the squash: without it the bounce lands puffed, not squashed.
- Dither `levels` keys must stay >= 2.
