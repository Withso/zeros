# App Icons

Electron packaging reads the production and per-channel icons from this directory:
`electron-builder.yml` sets `mac.icon` for Production, and
`scripts/electron-builder-run.mjs` overrides it per channel with `-c.mac.icon=…`.
`pnpm check:packaging-paths` asserts every one of those paths exists **and** that each
channel has a **distinct** file — two channels sharing an icon makes them
indistinguishable in the Dock, which defeats the point of the badge.

| File | Used by | Badge |
| --- | --- | --- |
| `icon.icns` / `icon.png` | Production (`Zeros`) | none |
| `icon-alpha.icns` / `icon-alpha.png` | Alpha (`Zeros Alpha`) | α |
| `icon-beta.icns` / `icon-beta.png` | Beta (`Zeros Beta`) | β |
| `icon-dev.icns` | the dev instance (`Zeros Dev`) | — |

Regenerate icons from the current source artwork and replace the checked-in
`.icns`, `.ico`, and PNG assets here. Do not use the retired Tauri icon command;
Tauri is no longer part of this app.

## Badge geometry — keep channel badges consistent

The α and β badges are the same mark in two letters. Measured from `icon-beta.png`
on the 1024×1024 canvas; match these when adding a channel:

- **Circle** — Ø175 px, centre `(772, 239)` — i.e. 163 px in from the right edge and
  151 px down from the top.
- **Fill** — `rgb(193, 116, 0)` (`#C17400`).
- **Glyph** — white, uniform stroke ≈10–12 px with rounded terminals, optically
  ~72 px tall. (β measures 112 px only because it carries an ascender *and* a
  descender; α is x-height, so match it optically rather than by bounding box.)

`icon-alpha.*` was derived from `icon.png` by compositing an α at that geometry, and
its `.icns` replicates `icon-beta.icns`'s exact container layout: a `TOC ` chunk
followed by `icp4 icp5 icp6 ic07 ic08 ic09 ic10 ic11 ic12 ic13 ic14`, all PNG, at
16/32/64/128/256/512/1024 px. If a designer replaces it with a hand-drawn α, keep that
type set — it is the layout electron-builder already ships successfully for Beta.
