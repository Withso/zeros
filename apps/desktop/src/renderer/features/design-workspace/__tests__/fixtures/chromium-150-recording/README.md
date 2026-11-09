# A real Chromium 150 recording

`design-canvaskit-fixture.test.ts` replays this recording with the vendored
CanvasKit build. It guards the recorded canvas against an SKP format or
externalized-typeface change that the pinned build no longer reads.

- **`changes-conflicts.skp`** is one layer exactly as the recorder delivered
  it: the frame `Zeros - Design/new-pages/changes-conflicts.html` (source
  version `072d6e9bc13fa0577ecb3fce`, 1434 × 1384 CSS pixels, scale 1).
  - It is SKP format version 109, with its font externalized as one
    `ZRTF` v1 reference.
  - Pipeline: `recordings-1:electron-43.8.3/chromium-150.0.7871.250/skp`.
  - It was recorded on Linux by the Design recorder (`iamarunrk/design-recorder`
    at `60ef36e8`, PR #929), headless (`--ozone-platform=headless
    --disable-gpu --disable-dev-shm-usage`), and taken from the first
    `design.recordings.render` reply of that run.
- **`LiberationSerif-Regular.ttf`** is the referenced font, unmodified.
  - Its content id, `8e23ee1f0b1cce384c9d3f7c39b9ccda`, is the first 32 hex
    characters of its SHA-256.
  - On that machine, Chromium's default font for the frame's text was
    Liberation Serif 2.1.5. The file is byte-identical to
    `/usr/share/fonts/liberation-serif/LiberationSerif-Regular.ttf` from the
    `liberation-serif-fonts-2.1.5` package.
  - Licensed under the SIL Open Font License 1.1, with the Reserved Font Name
    "Liberation". The terms are in
    [`third_party/liberation-fonts/LICENSE`](../../../../../../../../../third_party/liberation-fonts/LICENSE).

To refresh both files, run `scripts/design-recorder-qualification.ts` with
`ZEROS_QUALIFY_FIXTURES`. Take a single-layer recording and its fonts from a
self-contained reply, then update this README and the test's expected values.
