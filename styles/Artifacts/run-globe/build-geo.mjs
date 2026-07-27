// Regenerate run-globe-geo.js — the precomputed geometry the vector globe draws.
//
// The globe is a line-art outline: continent COASTLINES only, one uniform stroke —
// no country borders, no fill, no graticule. So all we embed is a single land
// shape (a MultiPolygon), stroked (fill:none) by the renderer to trace coastlines.
//
// Pipeline, from Natural Earth 1:110m via world-atlas (TopoJSON):
//   1. presimplify + simplify  → smooth the coastlines to a clean, icon-like level
//      (drops country-level wiggle the reference outline globes don't have).
//   2. feature(objects.land)   → the merged land MultiPolygon.
//   3. drop tiny landmasses    → simplification collapses small islands to near-zero
//      slivers that render as floating "dust"; filtering by spherical area removes
//      them while keeping every recognisable island (Greenland, Japan, NZ, UK…).
//   4. round to 2dp            → ~1 km, far finer than a 14–96 px globe resolves.
//
// The result loads as a plain <script> global (no runtime topojson, no fetch — so
// the standalone preview works straight off file://).
//
// Prerequisite: topojson-client + topojson-simplify on the module path. Run ad-hoc:
//   (cd styles/Artifacts/run-globe && npm i --no-save topojson-client topojson-simplify && node build-geo.mjs)
// Requires Node 18+ (global fetch).

import { writeFile } from "node:fs/promises";

const SRC = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const SIMPLIFY_MIN_WEIGHT = 12; // quantized-area threshold; larger = smoother coasts
const MIN_AREA_STERADIANS = 1e-4; // drop landmasses below this (collapsed island dust)
const DECIMALS = 2;

const [{ feature }, { presimplify, simplify }] = await Promise.all([
  import("topojson-client"),
  import("topojson-simplify"),
]).catch(() => {
  console.error(
    "Missing deps. Install first, e.g.\n" +
      "  npm i --no-save topojson-client topojson-simplify",
  );
  process.exit(1);
});

const topo = await fetch(SRC).then((r) => {
  if (!r.ok) throw new Error(`fetch ${SRC} → HTTP ${r.status}`);
  return r.json();
});

// 1–2. Smooth, then decode to a geographic MultiPolygon.
const simplified = simplify(presimplify(topo), SIMPLIFY_MIN_WEIGHT);
const collection = feature(simplified, simplified.objects.land);
const polygons = collection.features[0].geometry.coordinates;

// 3. Spherical area of a ring (steradians), used to drop collapsed island slivers.
const RAD = Math.PI / 180;
const ringArea = (ring) => {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    sum += (b[0] * RAD - a[0] * RAD) * (2 + Math.sin(a[1] * RAD) + Math.sin(b[1] * RAD));
  }
  return Math.abs(sum / 2);
};

// 4. Round while filtering.
const f = 10 ** DECIMALS;
const round = (n) => Math.round(n * f) / f;
const land = {
  type: "Feature",
  geometry: {
    type: "MultiPolygon",
    coordinates: polygons
      .filter((rings) => ringArea(rings[0]) >= MIN_AREA_STERADIANS)
      .map((rings) => rings.map((ring) => ring.map((c) => [round(c[0]), round(c[1])]))),
  },
};

const header =
  "// Natural Earth 1:110m continent coastlines (land outline only — no country\n" +
  "// borders), derived from world-atlas@2/countries-110m (TopoJSON):\n" +
  "//   simplify(presimplify(topo), " + SIMPLIFY_MIN_WEIGHT + ") → feature(objects.land) →\n" +
  "//   drop landmasses < " + MIN_AREA_STERADIANS + " sr (island dust). Coords [lon,lat] @ " + DECIMALS + "dp.\n" +
  "// The renderer strokes this (fill:none) to trace coastlines. Consumed by run-globe.js.\n" +
  "// Regenerate: node styles/Artifacts/run-globe/build-geo.mjs\n" +
  "// Source: https://github.com/topojson/world-atlas  ·  https://github.com/nvkelso/natural-earth-vector\n";

const out = new URL("./run-globe-geo.js", import.meta.url);
await writeFile(out, header + "window.RUN_GLOBE_GEO = " + JSON.stringify({ land }) + ";\n");
console.log(
  `wrote run-globe-geo.js — ${land.geometry.coordinates.length} landmasses`,
);
