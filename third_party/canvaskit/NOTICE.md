# CanvasKit (Zeros build): upstream terms

The recorded Design canvas ships a CanvasKit WebAssembly build made from Skia
`e2def78fa232884d4aedcf3ad92d4a0dd673b898` (tag `canvaskit/0.42.0`) with the
Zeros patch in
`apps/desktop/src/renderer/features/design-workspace/gpu/canvaskit/`. The
module statically links the libraries below. Each file here is the unmodified
license text from that library's source, at the revision Skia's `DEPS` pins.

| Component | Revision | License | File |
| --- | --- | --- | --- |
| Skia (including CanvasKit and skcms) | `e2def78f` | BSD-3-Clause | `LICENSE.skia` |
| FreeType | `264b5fbf` | FreeType License (FTL), elected over GPL-2.0 | `LICENSE.freetype`, `LICENSE.freetype-ftl` |
| HarfBuzz | `9cb1fee5` | MIT ("Old MIT") | `COPYING.harfbuzz` |
| ICU | `d578f2e8` | Unicode-3.0 and ICU | `LICENSE.icu` |
| libjpeg-turbo | `e14cbfaa` | IJG, BSD-3-Clause, zlib | `LICENSE.libjpeg-turbo`, `LICENSE.libjpeg-turbo-ijg` |
| libpng | `d5515b5b` | libpng-2.0 | `LICENSE.libpng` |
| libwebp | `845d5476` | BSD-3-Clause, with Google's patent grant | `COPYING.libwebp`, `NOTICE.libwebp-patents` |
| Wuffs | `e3f919cc` | Apache-2.0 | `LICENSE.wuffs` |
| brotli | `6d03dfbe` | MIT | `LICENSE.brotli` |
| zlib (Chromium) | `646b7f56` | Zlib | `LICENSE.zlib` |
| PartitionAlloc (Chromium) | `03cc5131` | BSD-3-Clause (Chromium) | `LICENSE.chromium-partition-alloc` |
| Emscripten 4.0.7 runtime and libc | `c69d433d` (emsdk) | MIT and UIUC, with its listed component terms | `LICENSE.emscripten` |

Portions of this software are copyright © 1996-2026 The FreeType
Project (https://freetype.org).  All rights reserved.

The PartitionAlloc repository carries no license file of its own; its sources
are Chromium code under Chromium's `LICENSE`, reproduced here.
