# Design canvas chrome under zoom, transient paint and typecheck memory

Target: `gotchas.md` (browser and UI smoke; Node, Vitest and TypeScript).

- **Stroke widths.** Chromium rounds a border or outline width under 1 CSS px
  up to a whole pixel before an ancestor transform scales it, so canvas chrome
  sized `1px / zoom` drew 8 screen pixels at 800%. Stroke inside the camera
  with a box-shadow spread (`.zd-design-stroke`) and draw dashed or dotted
  runs as gradients (`.zd-design-dashed-line`, `.zd-design-dashed-box`); the
  deep-zoom check in `scripts/ui-smoke-design-transform-chrome.mjs` holds the
  selection stroke at two screen pixels.
- **Transient glitches.** A gesture glitch that lasts a few frames (a size
  badge reading another value, an outline at the old size) passes any check of
  the settled state, so such a check stayed green on the broken base. Record
  every intermediate value with a `MutationObserver` or a rAF sampler during
  the gesture and assert on the whole series, then confirm it fails on the
  base.
- **Tiny targets.** Corner handles appear from 16 screen pixels and edge strips
  from 24. A pointer check on a small selection must aim clear of them, or it
  tests the handle instead of the body.
- **Typecheck memory.** `pnpm typecheck` ran out of memory (about 13 GB) in
  `tsgo` against a stale `node_modules/.cache/zeros-typecheck/app.native.tsbuildinfo`,
  while `--incremental false` finished in 16 s. Delete that file before you
  suspect the change.
