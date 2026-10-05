# Zeros design system — decision history

Why the system looks the way it does. This file is a record, not a rulebook:
the rules are in [design-system.md](design-system.md) and the values in
[design-tokens.md](design-tokens.md). Newest first.

## 2026-10-05 — DTCG token source with generated declarations

- Primitive values moved to `styles/tokens/base.tokens.json` and
  `styles/tokens/light.tokens.json` in DTCG 2025.10 format. The resolver applies
  the base set before the Dark/Light appearance modifier. Aliases stay CSS
  `var()` references so contextual overrides and theme inheritance keep working.
- The dependency-free generator writes only explicitly marked declaration
  groups in the existing `:root`, Light and Tailwind color-wiring blocks.
  Imports, explanatory headers, selector order, native hints, type/radius/weight
  wiring, named utilities and base rules remain authored. CSS names, raw token
  values and resolved sRGB values are preserved from the corrected palette.
- `pnpm design:docs` now regenerates token CSS as well as docs and provider
  guidance; `pnpm check:ui` rejects stale CSS or malformed token sources.
  Permanent tests cover value identity, alias resolution, round trips and errors.
- `pnpm design:docs` and `pnpm tokens:build` also generate marketing's 26 cloned
  colors in both appearances from the resolver export list, preserving raw value
  strings and leaving art-direction tokens/selectors hand-written while retaining
  independent parity tests and freshness gates.

## 2026-10-05 — Supplemental metadata and subtle control outlines

- **Metadata.** Both themes now use neutral `hsl(0 0% 42%)` (`#6B6B6B`) for
  `muted-fg`: Dark L54 (`#8A8A8A`) → L42; Light warm H20/S4/L41
  (`#6D6764`) → neutral H0/S0/L42. This is the owner's quietest supplemental
  tier, with a reviewed 3:1 floor below AA by design (worst rest ratios:
  Dark 3.02:1, Light 4.48:1). Hovered/selected metadata steps up to fg3.
- **Outlines.** The extra high-contrast control token was removed and the
  original checkbox border4, radio border3 → border4 hover → fg1 checked,
  switch border3 track/border4 outline, and slider half-alpha focus-color
  outline recipes restored. Opaque keyboard focus borders/outlines and halos
  remain. Resting outlines are subtle by reviewed design, below WCAG
  1.4.11's 3:1; focus is the strong cue.
- **Light borders.** border3 H60/S3/L85 (`#DADAD8`) → H60/S3/L78
  (`#C9C9C5`); border4 H0/S1/L78 (`#C7C6C6`) → H60/S3/L72 (`#BABAB5`).
  Dark border3/4 stay unchanged. Both themes now enforce border3 ≥1.45:1,
  border4 ≥1.6:1 on control surfaces, plus a ≥1.15× border4/border3 contrast
  step on bg2. These are perceptibility floors, not WCAG claims; the
  user-message bubble is excluded because controls do not sit on it.

## 2026-10-04 — Enforced design system and contrast contract

- **Compiled-class gate.** `pnpm check:ui` now compiles every class candidate
  against `styles/zeros-tokens.css` with the build's own Tailwind compiler. It
  found 20 classes that rendered nothing (`text-error` ×10, `bg-sidebar` ×3,
  `text-danger-fg` ×2, `text-muted-foreground`, `text-2xs`, bare `rounded`,
  `border-bd1`, `rounded-xl`); error messages had been rendering in the
  surrounding text color.
- **Palette reset.** `--color-*: initial` removes Tailwind's built-in palettes,
  so only Zeros colors compile (`bg-gray-500`, `text-white` emit nothing).
- **Policy ratchet.** `scripts/design-system/ui-policy.mjs` adds the `ui/*`
  rules; the 498 findings that existed (including 70 `check:ui ignore`
  directives, now themselves ratcheted) were recorded in
  `styles/policy/ui-debt.json`, which may only shrink. Global layers moved to
  named utilities where the value already matched (`z-50` menus →
  `z-dropdown`, dialogs → `z-modal`, column chrome → `z-chrome`); `--z-modal`
  became 50, equal to `--z-dropdown`, so menus opened inside dialogs still
  paint above them.
- **Contrast contract.** `styles/policy/contrast-contract.json` declares every
  sanctioned foreground/background pairing; `contrast-contract.test.ts` checks
  them in both themes (WCAG 2.2; APCA was evaluated as an advisory measure only —
  WCAG 3 had not chosen a contrast algorithm).
- **Text ladder.** Dark `muted-fg` L44 → L54 (`#707070` → `#8A8A8A`): the old
  value was 3.25:1 on `bg2`, below AA for the metadata it carries. Light
  `fg2` / `fg3` / `muted-fg` L37 / 44 / 56 → L30.5 / 36 / 41, mirroring Dark's
  ≈ 9 / 7 / 5.5:1 ladder; Light `fg3` had been 4.15:1 and `muted-fg` 2.75:1 on
  raised surfaces.
- **Light status colors.** Lightness only (hue and saturation kept), solved so
  status text clears AA on rest AND hover fills: red L51 → 44, green L36 →
  25.5, yellow L60 → 28.5 (ochre — bright yellow cannot be readable text on
  white; the golden value moved to the new `--yellow-icon` for dots, icons and
  tints, and the vivid amber to `--yellow-wash` for search highlights), blue
  L53 → 48.5, brown L50 → 43, and the matching `-fg` values for red, green, and
  yellow. Dark status colors were already AA and are unchanged; equalizing them
  perceptually would have made red/violet pastel and reduced red/green
  separation for deuteranopia.
- **Diff inputs.** `--diff-addition` / `--diff-deletion` / `--diff-neutral`
  decouple diff rows from status text: Light pins its established diff palette
  (darker text anchors had dropped GitHub Light code on an added row from
  4.66:1 to 3.31:1), Dark aliases the unchanged status anchors.
- **Destructive hover.** `hover:bg-red-secondary/90` lightened the fill toward
  the surface and dropped white text to 4.37:1 in Light. Replaced by the solid
  `--red-secondary-hover`.
- **Control boundary experiment.** Checkbox, radio, switch-off track, and
  slider outlines temporarily gained a separate ≥3:1 token (removed after
  owner review on 2026-10-05). Light `border4` L83 → 78 made hover more visible.
  A checked radio gained keyboard focus through an opaque outline; the
  checked border used to win over the focus border. That improvement remains.
- **Menu metadata steps up.** Selected command, menu, context-menu, and select
  rows lift nested `text-muted-fg` to `fg3`, which the contract clears on hover
  fills.
- **Inactive panes** no longer veil their content with `bg0/30` (it pushed
  readable text below AA); they recede through the `bg0` window fill only.
- **`text-xs` line height** is now 18px. Overriding only the font size had kept
  Tailwind's 12px ratio, so 13px text sat on a 17.33px line and rows measured
  25.33/29.33px.
- **Button `compact`** (24px) and `icon-compact` sizes joined the standard 28px
  control; mixed-height rows (ReviewSelectionToolbar) were unified.
- **Docs.** `styles/zeros-foundation.md` and `styles/theme-system-tour.md` were
  replaced by `docs/design-system.md` (rules), the generated
  `docs/design-tokens.md` (values), and this file (history). Agent skills for
  Claude, Codex, and Cursor are generated from the agent brief in the guide.

## 2026-09-15 — One button height

Button `sm` / `default` / `lg` (formerly 24 / 28 / 32px) were unified at 28px
to match the Select trigger, so a button and a dropdown in one row are the same
object. Secondary moved to a transparent fill with the trigger's `border3` →
`bg2-highlight` hover.

## 2026-09-14 — Orka black retired; prompt surface radius

The opt-in warm "Orka black" dark palette was retired; saved preferences
migrate to Dark. Prompt surfaces (composer, inline edit, sent user message)
shared a 12px radius (`PROMPT_SURFACE_RADIUS`) so a prompt kept one shape from
typed to sent. On 2026-09-25 the create and workspace composers moved to 18px
(`COMPOSER_SURFACE_RADIUS`); sent messages and inline edits kept 12px.

## 2026-08 — Foreground tier consolidation

`--fg3` and `--muted-fg` had been byte-identical in Dark (L44), so the names were
used inconsistently (`fg3` ≈ 166 consumers, `muted-fg` ≈ 25). All former `fg3`
consumers moved to `muted-fg`, which adopted the former `fg3` value per palette
(Light `muted-fg` L68 → L56 fixed metadata at 2.24:1). `fg3` was then re-adopted
as a true middle tier (Dark L63, Light L44) for input placeholders and ignored
file-tree rows: a placeholder at `fg2` read as a filled value, and one at
`muted-fg` was a step too quiet. Alpha approximations (`placeholder:text-fg2/60`)
were removed because they composited below the intended tier.

## 2026-08-08 — Neutral Dark

The structural dark palette (backgrounds, foregrounds, borders, focus, inverted
pair) became achromatic while keeping the former warm palette's lightness, with
deliberate exceptions: `bg2` L12 → 13 (composer lift), `fg1` L92 → 94, `fg2`
L66 → 72, and `--highlighted-bg` aliased to `--bg2` so a sent message wears the
composer's fill. `bg1` stayed L7 (`#121212`) and `sidebar-bg` L9 (`#171717`).
The six status families stayed chromatic because they carry meaning.

## 2026-07-12 — Radius scale and audit-gap rules

Radii fixed to three steps (`rounded-sm` 4, `rounded-md` 6, `rounded-lg` 8);
`--radius-*: initial` removed `rounded-xs` / `xl` / `2xl` / `3xl` and bare
`rounded`, with derived surface radii (16px menus, 12px settings groups)
computed from `--radius-lg`. `check:ui` gained rules for hsl/oklch literals,
`*-white` / `*-black` classes, dead shadcn aliases, `bg3` fills, and stock
shadows on floating primitives. The hex comments in `zeros-tokens.css` are
checked against their HSL values after a stale comment nearly caused a contrast
regression (`fg2` `#8E8885` vs `#625D5B`).

## 2026-05-26 — color-mix to flat tokens

Component `color-mix()` calls were replaced by flat tokens: scrollbar thumbs →
`border3` / `border4`, the "Thinking…" shimmer → `bg1-hover`, markdown `<mark>`
→ `bg1-highlight` + `border1` (a neutral tag, not blue), and the global focus
outline → `highlighted-bright`. Tailwind opacity modifiers on surfaces remain
allowed; on text they are not (see the contrast contract).
