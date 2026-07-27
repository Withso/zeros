# Run loader — Vector Globe

A pure-vector (SVG) rotating globe drawn as clean **line-art**: a rim circle plus
continent **coastlines**, all in one uniform stroke — no fill, no country borders,
no graticule, no shimmer. Every mark is an SVG path, so it stays razor-crisp at
any size or DPI. Shown in the **Run loader — Vector Globe** section of
`../loaders-preview.html`.

Like the rest of `styles/Artifacts/`, this is a standalone design lab: the files
load with plain `<script>` tags and work straight off `file://` (no build step,
no server, no `fetch` — which `file://` forbids for local files).

## Files

| File | What it is |
| --- | --- |
| `run-globe.js` | The renderer. Auto-mounts on any `[data-run-globe]` element, injects a sized `<svg>`, and drives one shared `requestAnimationFrame` loop. **Authored here.** |
| `run-globe-geo.js` | Precomputed geometry as a `window.RUN_GLOBE_GEO` global: a single `land` MultiPolygon (simplified continent outlines). Generated — see below. |
| `run-globe-d3.min.js` | Vendored **d3-array@3 + d3-geo@3.1.1** UMD, concatenated. Used only for the orthographic projection + `geoPath` SVG-path generation. Upstream, unmodified. |
| `build-geo.mjs` | Regenerates `run-globe-geo.js` from Natural Earth. |

## How it works

- **d3-geo's orthographic projection** maps `[lon, lat]` → screen and clips the
  back hemisphere (`clipAngle(90°)`), so coastlines wrap and vanish around the
  limb correctly as the globe turns — the genuinely hard part (spherical polygon
  clipping) is delegated to a battle-tested projection instead of hand-rolled.
- The land shape is **stroked, not filled**: stroking a polygon traces its
  outline, i.e. the coastline. Where a continent crosses the limb the clip closes
  it along the sphere edge — which coincides with the rim, so it merely reinforces
  the rim, no stray marks.
- The **rim** is a single `<circle>`, drawn once: an orthographic sphere's outline
  never changes under rotation. Only the coastline is re-projected each frame.
- **One uniform stroke width** is set on the `<svg>` and inherited by both the rim
  and the coastline, so "all strokes the same size" holds at every scale.
- **Colour is entirely CSS** — everything rides `currentColor`. A light/dark theme
  flip needs zero JS here; only the coastline `d` is script-driven.
- Instances are **grouped by pixel size** — all globes of a size share one
  projection, so each frame's path is computed once and fanned out.
- Honours `prefers-reduced-motion`: renders a single static frame (an Atlantic
  view) instead of animating.

## Reuse

```html
<span class="globe" data-run-globe data-globe-size="16"></span>
<style>.globe { display: inline-flex; color: var(--blue-primary); }</style>

<!-- load order matters: d3 → geometry → renderer -->
<script src="run-globe-d3.min.js"></script>
<script src="run-globe-geo.js"></script>
<script src="run-globe.js"></script>
```

The host element carries the colour (via `currentColor`) and, through
`data-globe-size`, the pixel size. Tunables (rotation period, camera tilt, stroke
ratio) live as constants at the top of `run-globe.js`.

## Regenerating the geometry

`run-globe-geo.js` is derived from
[world-atlas](https://github.com/topojson/world-atlas)'s `countries-110m`
TopoJSON (built from
[Natural Earth](https://github.com/nvkelso/natural-earth-vector) 1:110m):

```
simplify(presimplify(topo), 12)   → smooth coastlines to a clean, icon-like level
feature(objects.land)             → the merged land MultiPolygon
drop landmasses < 1e-4 sr         → remove island "dust" simplification leaves behind
round to 2 dp                     → ~1 km, far finer than a 14–96 px globe resolves
```

To rebuild (needs Node 18+ for global `fetch`):

```sh
cd styles/Artifacts/run-globe
npm i --no-save topojson-client topojson-simplify   # if not already resolvable
node build-geo.mjs
```

Smoothness and island count are tuned by `SIMPLIFY_MIN_WEIGHT` (larger = smoother)
and `MIN_AREA_STERADIANS` (larger = fewer small islands) at the top of the script.

## Rebuilding the d3 bundle

`run-globe-d3.min.js` is just the two upstream UMD files concatenated (d3-geo
depends on d3-array, so array must come first — both attach to `window.d3`):

```sh
{ curl -s https://cdn.jsdelivr.net/npm/d3-array@3/dist/d3-array.min.js
  curl -s https://cdn.jsdelivr.net/npm/d3-geo@3/dist/d3-geo.min.js
} > run-globe-d3.min.js   # then re-add the header comment
```

## Promoting to production

This is an exploration study, exactly as the pixel globe was. A production port
would live under `src/loaders/` (mirroring `RunHorseShimmer`), importing `d3-geo`
from npm rather than the vendored bundle, and inlining the geometry as a typed
module — the render logic in `run-globe.js` carries over directly.
