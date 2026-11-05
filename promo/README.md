# Chair promo video

A silent 1920×1080 30 fps motion-graphics video made of Chair's own UI look
(dark tokens, Inter, 24 px cards, pills, dither). Mel adds voice, music and SFX.

## Render (one command)

```sh
cd promo && npm install && npm run render
```

Output: `promo/out/chair-promo.mp4`, copied to `/tmp/chair-promo/chair-promo.mp4`,
plus six stills in `/tmp/chair-promo/stills/`. Uses the Chromium Playwright
already cached in `~/.cache/ms-playwright` (set `CHROMIUM=/path/to/chrome` to
override) and `ffmpeg` on PATH. Takes a few minutes with 8–12 workers
(`npm run render -- --workers 12`). Render a slice: `-- --from 100 --to 120`.

## Watch without rendering

```sh
cd promo && npm run preview   # writes out/preview.html (one self-contained file)
```

Open `promo/out/preview.html` in any browser: it plays the whole video live.
Click to pause, drag the bar to scrub. `npm run stills -- 26 119 161` saves
PNGs of chosen seconds to `/tmp/chair-promo/stills/`.

## Edit the text

All words and timings live in **`script.js`**:

- `intro`: Mel's voiceover beats. `say` is the spoken line (never shown, it sets
  the pace), `cue` holds stage directions and sound notes (never shown), `show`
  is the kinetic phrase on screen, `dur` is seconds. The `montage` beat is a
  placeholder card to swap for the clips in the edit.
- `features`: one scene each (label, title, sub, and scene props).
- `outro`: wordmark, tagline, URL.

Change a `dur` and the whole timeline re-flows. Preview any moment in a browser:
open `index.html?t=42` (or `?play` to loop live).

## How it works

`index.html` + `stage.js` draw each frame as a pure function of time
(`window.__seek(t)`), including the pendulum cursor physics (re-simulated from
the scene start each frame) and a small WebGL dithered-noise background shader
(own port of the shaders.com dither look, rendered at 480×270 and scaled up so
each pixel is a dither cell). `render.mjs` seeks frame by frame in headless
Chromium and pipes JPEGs to ffmpeg in parallel segments, then concatenates.
