# Vendored CanvasKit (generated)

`canvaskit.js` and `canvaskit.wasm` are **generated files**. Do not edit them;
rebuild them with `build.sh` and update the pins in `design-canvaskit-build.ts`.

## What it is

[CanvasKit](https://skia.org/docs/user/modules/canvaskit/) 0.42.0 (Skia's
WebAssembly build, BSD-3-Clause) with one Zeros patch, `zeros-design.patch`.
The recorded Design canvas replays the Skia pictures Chromium records for each
frame; the patch makes those pictures cheap to load many times:

- **Shared typefaces.** A recorded picture embeds full copies of every font it
  draws with. Stock `MakePicture` creates new typefaces from those copies for
  every picture. The patch shares one `SkTypeface` per distinct serialized
  typeface (`TypefaceCacheCount/Bytes/Hits/Misses()`, `ClearTypefaceCache()`).
- **Externalized typefaces.** `apps/desktop/shared/design-picture-typefaces.ts`
  replaces each embedded font file with a `ZRTF` reference to its content id.
  The patch resolves those references from a registry of font files the
  renderer has verified (`_RegisterDesignTypeface`, `HasDesignTypeface`,
  `UnregisterDesignTypeface`, `DesignTypefaceRegistryCount/Bytes()`). A
  picture with an unresolved reference fails to load as a whole.

Everything else is unchanged; pictures without references behave as in stock
CanvasKit.

## Inputs

| Input | Value |
| --- | --- |
| Skia revision | `e2def78fa232884d4aedcf3ad92d4a0dd673b898` (tag `canvaskit/0.42.0`) |
| Emscripten SDK | 4.0.7 (Skia's `bin/activate-emsdk` at that revision) |
| Flags | `modules/canvaskit/compile.sh release no_skottie no_sksl_trace no_alias_font no_effects_deserialization no_encode_jpeg no_encode_webp legacy_draw_vertices no_embedded_font`: the npm package's `bin/` build in `modules/canvaskit/Makefile` |
| Third-party sources | Pinned by Skia's `DEPS`: brotli, freetype, harfbuzz, icu, libjpeg-turbo, libpng, libwebp, partition_alloc, wuffs, zlib |

## Reproducibility

- `./build.sh --stock` builds the same inputs without the patch. Its
  `canvaskit.js` and `canvaskit.wasm` are byte-identical to the published npm
  `canvaskit-wasm@0.42.0` `bin/` files (`DESIGN_CANVASKIT_STOCK_SHA256`).
- `./build.sh` applies `zeros-design.patch` and checks the output against
  `DESIGN_CANVASKIT_SHA256`. The build is deterministic.
- `design-canvaskit-build.test.ts` hashes the committed files against the same
  pins, so a silent replacement fails the unit tests.

## Upgrading

Chromium changes the picture format with Skia. When Electron moves to a new
Chromium, check that the pinned CanvasKit still reads its pictures (the
real-recording fixture test), and if not rebuild from a matching Skia
revision: update `build.sh`, re-apply the patch, refresh the pins and record
the stock reproduction again.

## Licenses

Skia and the libraries compiled into the WebAssembly module are reproduced in
[`third_party/canvaskit/`](../../../../../../../../third_party/canvaskit) and in
the generated `THIRD-PARTY-LICENSES.txt`. See `THIRD-PARTY-NOTICES.md`.
