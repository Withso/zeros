# Foundations: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Foundations”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Surfaces (`FndSurfaces`)

Owner today: `styles/zeros-tokens.cssdocs/design-system.md · Surfaces`

Changes:
- Light neutrals share one warm tint (OKLCH hue 70) at the same lightness: backgrounds, hovers, borders and text.
- Dark menus and popovers get their own bg3 #1C1C1C, a step above the sidebar, with hover #2A2A2A.
- Every pair in styles/policy/contrast-contract.json passes in both themes.

Code notes:
- Dark bg1 is #141414 (L8) and sidebar-bg #181818 (L9.4); bg3 and pane-bg follow as aliases and bg1-highlight stays #171717. In code, set both in the token source and run pnpm design:docs, which regenerates the tokens CSS, the token table, the marketing site’s copy and the zeros-ui skills. (`styles/tokens/base.tokens.json · styles/zeros-tokens.css:477,484,500,527 · docs/design-tokens.md:14,21,25 · apps/marketing/src/index.css:113,121,137`)
- Three hand-written copies of the canvas colour move with bg1, or the window shows the old shade before styles load: the boot screen, the Electron first frame and the marketing site’s theme colour. Stored window colours already migrate: #121212 and #141414 are both in the legacy list. (`index.html:69 · apps/desktop/electron/appearance-mode.ts:10-26 · apps/desktop/electron/ipc/commands/window.ts:191 · apps/marketing/index.html:11 · apps/desktop/electron/__tests__/appearance-mode.test.ts`)
- #141414 was dark bg1 once before (L8) and moved back to #121212; the design history does not record why. (`apps/desktop/electron/appearance-mode.ts:16-20 · docs/design-system-history.md:136-141`)

## Text and type (`FndText`)

Owner today: `styles/zeros-tokens.cssstyles/global/runtime-content.cssdocs/design-system.md · Text`

Changes:
- Light text tiers take the warm tint; lightness and contrast stay (muted-fg #6D6B67, 5.3:1 on bg1).
- Status labels (Backlog, In progress, In review, Done) use fg3 instead of muted-fg, so they reach 4.5:1.
- Design-tab labels, units, ruler marks and counts move from muted-fg (3.0:1 on bg2 in Dark) to fg3 (6.2:1).

Code notes:
- Every contrast pair still passes with bg1 #141414 and sidebar-bg #181818; bg2 stays the weakest surface. One exception: text on a selected search match (the 55% yellow wash over sidebar-bg) falls to 4.46:1, so the wash moves to 54%, 4.58:1. (`apps/desktop/src/renderer/shell/workbench/tabs/code-editor/theme.ts:89 · styles/policy/contrast-contract.json · scripts/design-system/token-palette.mjs:96-106`)

## Borders and focus (`FndBorders`)

Owner today: `styles/zeros-tokens.cssdocs/design-system.md · Borders, focus`

Changes:
- Dark border3 #444444 and border4 #575757: control outlines read better (1.65 and 2.23:1 on bg2).
- Focus is brighter: highlighted-bright #CACACA in dark (8.3:1), #4C4741 in light (7.0:1).
- Tiles take the standard focus ring instead of a 1px border2 ring.
- Every scrollbar thumb is `--scrollbar-thumb`, #222 in Dark and #EAEAEA in Light: 4px at rest in its 6px slot and 6px under the pointer or while dragged, with no color change (2026-11-09; the board's border2 at rest and border3 on hover retire).
- The Design tab uses the same keyboard ring: fields, segments, tools, keyframes and pads (a 1px inset or outline today, shown on a click too).

## Status color (`FndColor`)

Owner today: `styles/zeros-tokens.cssdocs/design-system.md · Status color`

Changes:
- Errors are a true red, not orange-brown: red-bg #341818 and red-fg #FFAAA7 in dark, #FFE8E7 and #AC262A in light.
- Destructive fill red-secondary #B32228 (white text 6.6:1).
- Dark blue-bg and blue-pill-bg #08233A with pill hover #0E304D: the same hue as blue-primary, no purple cast.
- Closed is red-primary on standalone glyphs and icons; text on red-bg stays red-fg.
- One meaning per hue stays as it is.

## Feature tokens (`FndFeatureTokens`)

Owner today: `styles/semantic-tokens.cssshared/theme/diff-theme.ts`

Changes:
- Diff rows, word highlights, gutters and line numbers get their own tokens (diff-add-*, diff-del-*) instead of blends: clearer green and red, readable line numbers (light 4.9 and 4.7:1).
- Switch thumb in dark is #0D0D0D on the on-track (8.5:1, was 1.9:1).
- Selection label design-selection-label-bg #0A6FC2 behind white text (5.2:1, was 3.5:1); the active tool in every toolbar uses it too.
- Design canvas labels get their own fills: design-gap-label-bg #C21A87 (5.5:1 with white) and design-measure #C11F1F (6.0:1), with design-selection-soft named; padding-soft and gap-soft retire.

## Red and error usage (`FndRed`)

Owner today: `docs/design-system.md · Status color`

Changes:
- Every error is red: red-bg and red-fg are a true red in both themes (see Status color).
- Failed tool rows use red-fg on red-bg, the same pair as every other text on red.
- The bespoke red outline and red ghost buttons become Destructive secondary.
- Errors inside content are message rows: the 16px red icon carries the tone, the line stays fg2 and Retry is a 24px Ghost, as in the Banner. Raw output such as fatal: moves to the diagnostics title; red-bg with red-fg stays for failed tool output and tinted chips.

## Radius, spacing and sizing (`FndShape`)

Owner today: `styles/zeros-tokens.cssshared/ui/menu-surface.tsdocs/design-system.md · Controls`

No change beyond the shared foundation and primitives.

## Motion (`FndMotion`)

Owner today: `styles/global/animations.cssshared/ui/anchored-overlay-motion.tsshared/ui/loading`

No change beyond the shared foundation and primitives.

## Loaders (`FndLoaders`)

Owner today: `shared/ui/loading/zeros-spinner.tsxpuzzle-square.tsxrun-stream.tsxglass-square.tsxlive-duration.tsx`

No change beyond the shared foundation and primitives.

## Workspace glyph (`FndGlyphs`)

Owner today: `shell/workspace-glyph.tsxfeatures/agent/agent-brands.tsshared/ui/loading/puzzle-square.tsx`

No change beyond the shared foundation and primitives.

## Logo (`FndLogo`)

Owner today: `features/auth/login-screen.tsxshell/no-projects-view.tsxindex.html`

No change beyond the shared foundation and primitives.

## Tooltip inventory (`FndTooltips`)

Owner today: `shared/ui/primitives/tooltip.tsx263 tooltips in apps/desktop/src/renderer`

No change beyond the shared foundation and primitives.

## Design canvas (`FndDesignCanvas`)

Owner today: `styles/semantic-tokens.css · --design-*design-workspace-ui.css · design-workspace-overlays.tsx`

Changes:
- Strokes keep one value in both themes on purpose: they draw over user content, which does not follow the app theme. The rule is written down with the tokens.
- Text never sits on a stroke colour. Three label fills join the tokens: design-selection-label-bg #0A6FC2 (5.2:1 with white), design-gap-label-bg #C21A87 (5.5:1) and design-measure #C11F1F for Alt measurement lines and labels (6.0:1, the same in both themes).
- design-selection-soft becomes a named token; the unused padding-soft and gap-soft retire.
- The accent belongs to the canvas. Chrome toggles (Play, the Motion toggle, the active theme column) use the neutral pressed state; the active canvas tool keeps the label blue, as every toolbar does.
- One canvas chip: 18 tall, radius 4, padding 6, 11/16 medium tabular, no edge, in four tones: selection (size, padding, rotation, grid tracks, motion), gap, measure, and neutral for the agent status, which lifts off the canvas (bg4 in Dark, bg1 in Light).
- The tokens move into styles/tokens/*.tokens.json and docs/design-tokens.md like every other family.

## Design editor (`FndDesignEditor`)

Owner today: `design-workspace-ui.css · Design UI standard v1design-workspace-width.ts · design-floating-panel.tsx`

Changes:
- The density stays: 28 controls, 13/18 tabular values, filled fields without resting borders, 36 headers and 8 gaps.
- The states join the system: hover bg2-highlight, a keyboard-only ring (highlighted-bright border with the 3px halo) for fields, segments, tools, keyframes and pads, and 50% for every disabled control.
- Labels are 12 medium fg3 (6.2:1 on bg2; muted-fg is 3.0:1); computed values are fg2 so they differ from authored ones.
- Icon sizes follow IconButton: 12 at 20 and 24, 14 at 28; section actions compact 24, row actions standard 28; canvas tools are the 28 Toolbar button.
- Surfaces collapse to three: toolbars (bar 36, bg2, border2, radius 10), floating windows (timeline, theme: bg1, border2, radius 12) and popovers and menus (bg3, border2, radius 12) at sm 240 and md 320.
- All three panel handles show a border4 line on hover and drag, so the resizable edges are discoverable.
