# Design canvas chrome under zoom, transient paint and typecheck memory

Target: `gotchas.md` (browser and UI smoke; Node, Vitest and TypeScript).

- **Stroke widths.** Chromium rounds a border or outline width under 1 CSS px
  up to a whole pixel before an ancestor transform scales it. Stroke canvas
  chrome with a box-shadow spread (`.zd-design-stroke`) and draw dashes as
  gradients; the transform-chrome smoke holds the 800% stroke at 2 px.
- **Coupled assertions.** Moving a stroke to box-shadow failed only in CI:
  `ui-smoke-design-workspace.mjs` read `borderColor` and `outlineColor`, and
  that scenario was not in the locally run set. Before pushing, grep every
  `scripts/ui-smoke-*.mjs` for computed-style reads of what you changed and
  run those scenarios.
- **Transient glitches.** A glitch lasting a few frames passes any check of the
  settled state. Record every value with a `MutationObserver` or rAF sampler
  and confirm the check fails on the base.
- **Saves in flight.** The layout-gestures harness holds canvas saves for
  700 ms, and a canvas gesture started before its save lands works from the
  saved geometry. Poll `designWorkspaceSnapshotCache` for the saved value
  before the next gesture.
- **Tiny targets.** Corner handles appear from 16 screen pixels and edge strips
  from 24; aim pointer checks clear of them.
- **Typecheck memory.** `pnpm typecheck` ran out of memory in `tsgo` on a stale
  `node_modules/.cache/zeros-typecheck/app.native.tsbuildinfo`; delete it
  before suspecting the change.
