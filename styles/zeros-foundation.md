# Zeros Foundation — design language + usage rules

**Status:** Living reference. Canonical guidance for color, typography, spacing,
motion, and component recipes in the Zeros desktop app.

Every UI task under `apps/desktop/src/renderer/` follows this reference together
with the binding repository rules in `RULES.md`.

If you only want one thing: **§3 has the surface map** (which token paints what), **§4 has the component recipes**, **§5 has the anti-patterns most likely to slip**.

---

## §1 — File map

The Zeros design system is organized through these public files:

| #   | File                                    | Role                                                      |
| --- | --------------------------------------- | --------------------------------------------------------- |
| 1   | `styles/zeros-tokens.css`               | Primitive values, core aliases, and Tailwind theme wiring |
| 2   | `styles/semantic-tokens.css`            | Feature-specific aliases over primitives                  |
| 3   | `styles/globals.css` + `styles/global/` | Ordered cross-boundary cascade modules                    |
| 4   | `styles/zeros-foundation.md`            | **This document** — recipes and anti-patterns             |
| 5   | `styles/theme-system-tour.md`           | Runtime load order and maintenance tour                   |

`apps/marketing/` is out of scope and owns its own web design system.

---

## §2 — Token taxonomy

The token system has **one layer of primitives** (in `zeros-tokens.css`) plus a small set of **component aliases** that point at the primitives.

### 2.1 Primitives

**Backgrounds (9 surfaces):**

```
--bg1              default canvas / chat window / app body
--bg1-hover        hover state on bg1 surfaces (tool calls, tabs in canvas)
--bg1-highlight    "lifted" content above bg1 (highlighted blocks, callouts)
--bg2              composer surface (raised above bg1)
--bg2-hover        hover state on bg2 (icon buttons in composer)
--bg3              FLOATING popover / dropdown / menu surface ONLY — always on
                   TOP of a background, never a fill / chip / selected state.
                   Dark = --sidebar-bg, light = --bg1; lift = border2 + shadow.
--bg3-hover        hover state on bg3 (menu items inside popovers)
--bg4              rare — reserved for specific cases
--bg5              rare — reserved for specific cases
```

**Foregrounds (text + icons ONLY, never borders):**

```
--fg1              highlighted/selected text + icons. Markdown body output,
                   settings titles, active row labels.
--fg2              DEFAULT text + icon color across the app.
--fg3              MIDDLE tier — exactly ONE step quieter than fg2. For content
                   that must read secondary to the fg2 text BESIDE it while
                   staying comfortably legible: input placeholders (every one in
                   the app), .gitignore'd rows in the file tree.
--muted-fg         QUIETEST tier — two steps below fg2, for content incidental
                   to the surface itself: supplemental metadata (timestamps,
                   counts, SHAs), disabled content, empty-state icons.
```

**Repository navigation (not the settings sidebar):**

```
--sidebar-bg          sidebar background
--sidebar-bg-hover    row hover + selected state
```

**Borders (borders only, never text):**

```
--border1   default for bg1 surfaces
--border2   sidebar / composer focus / bg2 surfaces / floating popover panels
--border3   secondary button / dropdown TRIGGER / input field
--border4   highlighted state of border3 consumers (dropdown hover)
```

**Highlighted (interaction emphasis):**

```
--highlighted-bg              user-message bubble, some selected states
                              (text/icon on it: fg1/fg2)
--highlighted-bright          input focus and brighter interaction borders
```

**Inverted (polarity-flipping pair):**

```
--inverted-bg                 the ONE surface that is always the opposite of
                              bg1: near-white in dark, near-black in light
--inverted-fg                 text/icon ON --inverted-bg — the pair always
                              ships together
```

Consumers: the primary button (via the §2.2 aliases) and the Switch's ON track. Never paint `bg-inverted-bg` without using `text-inverted-fg` for the content on it — no other fg tier is guaranteed readable on a polarity-flipping fill.

### 2.2 Component aliases (declared in zeros-tokens.css)

```
--primary-button-bg     → var(--inverted-bg)  (filled focal CTA fill)
--primary-button-hover  own value per theme   (lifted from primary-button-bg)
--primary-button-fg     → var(--inverted-fg)  (text/icon on the filled CTA)
```

These are Tailwind utility classes too: `bg-primary-button-bg`, `text-primary-button-fg`, `hover:bg-primary-button-hover`.

### 2.3 Semantic status → color families

Semantic status is expressed through the **color families** (§2.4): error → red, success → green, warning → yellow, info → blue, done/merged → violet, file paths → brown. There are no standalone `--success`/`--warning`/`--info` tokens — use `text-green-primary`, `text-yellow-primary`, `text-blue-primary`, etc. (and `bg-<family>-bg` + `text-<family>-fg` for filled callouts).

### 2.4 Color palettes (6 families)

Six explicit HSL families beyond the neutral system: **red · green · yellow · blue · violet · brown**. Each has:

```
--<family>-primary   vivid accent — icons, borders, counts (−N/+N), standalone status text
--<family>-bg        dark tinted surface (containers / callouts)
--<family>-fg        light text/icon ON --<family>-bg
```

**RULE:** on a `--<family>-bg` surface, text + icons use `--<family>-fg` — never the vivid primary (keeps tinted containers from reading "all red/green"). `--red-secondary` (deep red 700) is the SOLID fill for delete buttons + delete icons; text/icon ON a solid `--red-secondary` fill uses `--red-secondary-fg` (theme-static white — `fg1` flips dark in the light theme and can't sit on the red fill). Utilities are verbatim: `text-red-primary`, `bg-red-bg`, `text-green-fg`, `border-violet-primary`. Semantic roles map onto families — error→red, success→green, warning→yellow, info→blue, done/merged→violet, file paths/warm accents→brown (rolling out per family; **red migrated first**).

**Anchors vs. raw ramps (enforced by `check:ui`).** The four anchors — `-primary` / `-secondary` / `-bg` / `-fg` — ARE the semantic layer; pages, elements, and components use them directly. The numeric ramp steps (`--red-50` … `--red-950`, i.e. `text-red-500`, `bg-blue-400`, `var(--green-600)`, …) are the **private palette** backing the anchors — **never reference a numeric step from component code**; snap to the nearest anchor. `scripts/check-ui-consistency.mjs` flags ramp classes + `var()`s and allows only the anchors.

### 2.5 Diff renderer (separate visual identity)

The `@pierre/diffs` renderer (Changes/Review tabs, file-tab diff mode, chat EditCards) is themed to the Zeros palette in `apps/desktop/src/renderer/shared/theme/diff-theme.ts`. Its shadow root gets a theme-adaptive structural surface (`--diffs-bg` → `--sidebar-bg` in the workbench, `--bg1` in chat EditCards) plus three base overrides: `--diffs-addition-color-override` → `--green-primary`, `--diffs-deletion-color-override` → `--red-primary`, `--diffs-modified-color-override` → `--highlighted-bright` (neutral — no navy selection). @pierre derives the row wash, changed-word emphasis, edge bars, and line numbers from those three bases; syntax colors come from the Shiki code theme.

---

## §3 — Surface map: which token paints what

### 3.1 Backgrounds

| Surface                   | Token             | Tailwind           | Used for                                                                                                                              |
| ------------------------- | ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas / chat window      | `--bg1`           | `bg-bg1`           | Main app body, markdown body, conversation pane                                                                                       |
| Canvas hover state        | `--bg1-hover`     | `bg-bg1-hover`     | Tool call row hover, tab hover on bg1                                                                                                 |
| Lifted content on bg1     | `--bg1-highlight` | `bg-bg1-highlight` | Callouts, highlighted blocks above bg1                                                                                                |
| Composer                  | `--bg2`           | `bg-bg2`           | Composer pill, raised pane above bg1                                                                                                  |
| Composer hover            | `--bg2-hover`     | `bg-bg2-hover`     | Icon button hover inside composer                                                                                                     |
| Popover / dropdown / menu | `--bg3`           | `bg-bg3`           | Floating menus/popovers ONLY (dark = `--sidebar-bg`, light = `--bg1`). Never a fill — dialogs/sheets use `--bg1`, hover-cards `--bg2` |
| Popover hover             | `--bg3-hover`     | `bg-bg3-hover`     | Menu item hover inside a popover                                                                                                      |
| Rare / reserved           | `--bg4`, `--bg5`  | `bg-bg4`, `bg-bg5` | Don't reach without a specific case                                                                                                   |

### 3.2 Repository navigation

| Surface                      | Token                | Tailwind              |
| ---------------------------- | -------------------- | --------------------- |
| Sidebar background           | `--sidebar-bg`       | `bg-sidebar-bg`       |
| Sidebar row hover / selected | `--sidebar-bg-hover` | `bg-sidebar-bg-hover` |

The **settings sidebar** is NOT this surface — it uses default tokens (`bg-bg1` or `bg-bg2`).

### 3.3 Foregrounds (text + icons)

| Tier        | Token        | Tailwind        | Used for                                                                                            |
| ----------- | ------------ | --------------- | --------------------------------------------------------------------------------------------------- |
| Highlighted | `--fg1`      | `text-fg1`      | Markdown body, settings titles, active row labels, focal text, icons on selected rows               |
| Default     | `--fg2`      | `text-fg2`      | All default text + icons across the app                                                             |
| Middle      | `--fg3`      | `text-fg3`      | One step below `fg2`: input placeholders, `.gitignore`'d file-tree rows                             |
| Quietest    | `--muted-fg` | `text-muted-fg` | Supplemental metadata (timestamps, counts, SHAs), disabled content, placeholders, empty-state icons |

**The default is `fg2`.** Reach for `fg1` only when text/icon should pop (selected, highlighted, output text).

### 3.4 Borders

| Tier                                | Token       | Tailwind         | Used for                                                                       |
| ----------------------------------- | ----------- | ---------------- | ------------------------------------------------------------------------------ |
| Default                             | `--border1` | `border-border1` | Default border on bg1 surfaces, composer at rest, user-message bubble          |
| Sidebar / composer / bg2 / popovers | `--border2` | `border-border2` | Sidebar borders, composer focus, dividers on bg2, floating popover/menu panels |
| Component default                   | `--border3` | `border-border3` | Secondary button, dropdown trigger, input field                                |
| Component highlighted               | `--border4` | `border-border4` | Highlighted state of border3 consumers                                         |

### 3.5 Highlighted (interaction emphasis)

| Token                  | Tailwind                                                                          | Used for                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--highlighted-bg`     | `bg-highlighted-bg`                                                               | User message bubble, anchor selected state (text on it: `text-fg1`/`text-fg2`); neutral Dark aliases it to `--bg2` |
| `--highlighted-bright` | `bg-highlighted-bright` / `border-highlighted-bright` / `ring-highlighted-bright` | Input focus, settings provider tab indicator, brighter accent borders                                              |

---

## §4 — Component recipes

### 4.1 Buttons

| Variant         | When                                       | Recipe                                                                                                       |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Primary**     | The ONE focal CTA per visible screen       | `bg-primary-button-bg text-primary-button-fg hover:bg-primary-button-hover`                                  |
| **Secondary**   | Most common variant — actions next to text | `bg-bg1 border border-border3 text-fg1 hover:bg-bg2 hover:border-border4` _(use `bg-bg2` if on bg2 surface)_ |
| **Tertiary**    | Subtle — toolbar actions on bg1            | `bg-bg1-hover text-fg2 hover:bg-bg2-hover` _(no border)_                                                     |
| **Ghost**       | Repeating toolbar / "More" triggers        | `text-fg2 hover:bg-bg2-hover hover:text-fg1`                                                                 |
| **Destructive** | Solid delete action                        | `bg-red-secondary text-red-secondary-fg hover:bg-red-secondary/90`                                           |

Default text/icon for all variants: `fg2`. Highlighted/active state: `fg1`.

### 4.2 Inputs

```
bg-bg1 (or bg-bg2 if on bg2 surface)
border-border3
text-fg1
placeholder:text-fg3
focus: border-highlighted-bright + ring-highlighted-bright/50
```

**Every placeholder in the app is `fg3`.** The shared primitives (`input.tsx`,
`textarea.tsx`, `command.tsx`) use `placeholder:text-fg3`, and the agent
composer's ProseMirror placeholder uses `var(--fg3)` — same tier, one weight
everywhere. Two rules worth knowing:

- **Never `fg2`.** A placeholder in the DEFAULT text color reads as a filled
  value. This was the old behaviour and it was wrong.
- **Never approximate with alpha.** `placeholder:text-fg2/60` composites to
  4.09:1 in Dark and 2.67:1 in Light — i.e. it was reaching for `muted-fg` the
  long way round, and landed below it in Light. Use a tier token.

Two inputs deliberately use `placeholder:text-muted-fg` instead: the inline
rename field in `repositories-panel.tsx` and the follow-up field in
`question-card.tsx`. Both are transient overlay affordances where the
placeholder is incidental rather than instructional.

### 4.3 Dropdowns

**Trigger:**

```
bg-bg1 (or bg-bg2 if on bg2 surface)
border-border3
text-fg1 (value) + text-fg2 (icon)
hover: bg-bg2-hover + border-border4
```

**Popover:**

```
bg-bg3 + border-border2   (outer border AND every separator: bg-border2)
items: 32px tall — px-2 py-1.5, idle text-fg1, hover bg-bg3-hover + text-fg1
separators: bg-border2 (h-px)
shortcut chips: <Kbd> — border-border1 + text-fg2 + text-2xxs (11px)
```

### 4.4 Composer

```
Outer pill:     bg-bg2 + border-border2 (focus state)
Icon buttons:   text-fg2 + hover:bg-bg2-hover + hover:text-fg1
Send button:    bg-primary-button-bg + text-primary-button-fg
Empty hint:     text-muted-fg
```

### 4.5 Repository navigation

```
Outer:        bg-sidebar-bg
Row idle:     text-fg2
Row hover:    bg-sidebar-bg-hover + text-fg1
Row selected: bg-sidebar-bg-hover + text-fg1
```

### 4.6 Tool call row / tab in canvas (lives on bg1)

```
Idle:     transparent bg + text-fg2
Hover:    bg-bg1-hover + text-fg1
Selected: bg-bg1-hover + text-fg1
```

### 4.7 Popovers / menus (floating surfaces)

`--bg3` is a **floating-surface-only** token — the panel always sits _on top of_
a background (dark = `--sidebar-bg`, one subtle step above `--bg1`; light =
`--bg1` itself). Its lift is `border-border2` + `--shadow-dropdown`, never a
heavier fill.

```
bg-bg3 + border-border2 + shadow-[var(--shadow-dropdown)]
Rows:          32px tall (px-2 py-1.5) — consistent across every dropdown
Separators:    bg-border2 (h-px) — same tone as the outer border
Header text:   text-fg1
Body / items:  text-fg2
Item hover:    bg-bg3-hover
Shortcut chip: <Kbd> — border-border1 + text-fg2 + text-2xxs (11px)
Hints:         text-muted-fg
```

**Menu chips (`<Kbd>`, `@/renderer/shared/ui/primitives`).** Every keyboard-shortcut chip
(`⌘T`, `⌘R`, `⌘1`) is ONE style: `border-border1` + `text-fg2` + `text-2xxs`
(11px) + `rounded-sm`. Use `<Kbd>` for shortcuts, and only for shortcuts —
non-shortcut small labels (`Beta`) match the same border/color tokens but stay
at `text-xxs` (10px).

**Not bg3:** dialogs / sheets are full modal surfaces on `--bg1` behind a
`bg-scrim` veil; hover-cards are raised cards on `--bg2` (+ `border-border2`).

### 4.8 Status messages

```
text-red-primary            (inline error label)
bg-red-bg text-red-fg        (filled error notice / callout)
text-green-primary / text-yellow-primary / text-blue-primary  (inline status labels)
```

Semantic status maps to the color families (§2.4): error→red, success→green, warning→yellow, info→blue, done→violet, file paths→brown.

### 4.9 Diff renderer

Separate identity for the `@pierre/diffs` renderer (Changes/Review tabs, file-tab diff mode, chat EditCards), themed via `apps/desktop/src/renderer/shared/theme/diff-theme.ts`: a theme-adaptive structural surface (`--diffs-bg` = `--sidebar-bg` in the workbench, `--bg1` in EditCards) + three `--diffs-*-color-override` bases (addition → `--green-primary`, deletion → `--red-primary`, modified/selection → `--highlighted-bright`). @pierre derives the row wash, word emphasis, edge bars, and line numbers; syntax colors come from the Shiki theme.

---

## §5 — Anti-patterns (rules most likely to slip)

1. **Never use a foreground token as a border.** `--fg*` are for text + icons only.
2. **Never use a background token as text.** `--bg*` are for surfaces only.
3. **Never use a border token for backgrounds or text.** `--border*` are for borders only.
4. **`bg3` is a FLOATING-SURFACE-ONLY token; hover states are SURFACE-SCOPED.** `bg-bg3` paints ONLY a floating panel (popover / dropdown / menu / select / command) that sits on top of a background with `border-border2` + `--shadow-dropdown` — **NEVER a fill, chip, selected state, or resting background on any surface, in EITHER theme.** In light `bg3 == bg1` (white) so a fill vanishes; in dark `bg3 == sidebar-bg` (barely above bg1) so a fill vanishes on bg1 and _inverts_ (goes darker) on bg2. Correct alternatives: hover on a bg1 surface → `bg-bg1-hover`; on bg2 → `bg-bg2-hover`; a menu item inside a popover → `bg-bg3-hover`; chips/pills → `bg-bg2-hover`; selected sidebar row → `bg-sidebar-bg-hover`; lifted content / callouts on bg1 → `bg-bg1-highlight`. Enforced by `check:ui` (`BG3_FILL_RE` for classes, `BG3_CSS_FILL_RE` for raw CSS `background:`); the only files allowed a `bg-bg3` fill are the floating panels listed in `BG3_SURFACE_FILES`.
5. **Selected state = the row's hover state.** "Selected" is the hover that doesn't go away.
6. **One primary button per visible screen.** If you find yourself reaching for a second `bg-primary-button-bg`, demote it to secondary or ghost.
7. **`--highlighted-bg` is for interaction anchor moments** (user messages, code-file-link highlights, selected states where the emphasis is load-bearing). Don't spray it across chrome.
8. **`--highlighted-bright` is the neutral focus / emphasis border.** It is NOT a button fill.
9. **Diff colors NEVER leak into chrome.** They live in `tool-edit.tsx` only.
10. **No inline hex / rgb / oklch / hsl values in components.** If a value isn't in `zeros-tokens.css`, add it there first.
11. **Don't compose your own `color-mix()`** in component code — the primitives already carry the L values you need. (Tailwind opacity modifiers like `bg-bg3/40` are fine — those produce color-mix automatically.)
12. **Default text/icon color is `fg2`, not `fg1`.** Reach for `fg1` only when something is selected, highlighted, or the focal output.
13. **`--diff-*` are immutable** — pixel-identical to GitHub Dark on purpose. Don't theme-aware them.
14. **No bare Tailwind color classes** (`bg-white`, `text-black`, `bg-gray-500`, etc.). Only the Zeros primitive utility classes.

---

## §6 — Color-mix → flat token migration (2026-05-26)

Previously the theme used `color-mix()` in a handful of places. As of 2026-05-26, these are flat tokens:

| Before                                                          | After                                     | Where                                                                  |
| --------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `color-mix(in oklch, var(--muted-foreground) 40%, transparent)` | `var(--border3)`                          | Scrollbar thumb                                                        |
| `color-mix(in oklch, var(--muted-foreground) 60%, transparent)` | `var(--border4)`                          | Scrollbar thumb hover                                                  |
| `color-mix(in oklch, var(--muted-foreground) 35%, transparent)` | `var(--border3)`                          | `scrollbar-color` shorthand                                            |
| `color-mix(in oklch, var(--muted) 30%, transparent)`            | `var(--bg1-hover)`                        | "Thinking…" shimmer overlay                                            |
| `color-mix(in oklch, var(--warning) 18%, transparent)`          | `var(--bg1-highlight)` + `var(--border1)` | Markdown `<mark>` highlight — now a neutral tag, not blue (2026-07-08) |
| `color-mix(in oklch, var(--ring) 50%, transparent)`             | `var(--highlighted-bright)`               | Global focus outline                                                   |

**Implicit color-mix from Tailwind opacity modifiers** (`bg-bg1/50`, `hover:bg-bg3/40`, etc.) is fine — Tailwind v4 handles those automatically with HSL token values. No need to migrate.

---

## §7 — Typography

Strict **12/14 scale** in chrome:

```
text-sm font-medium (14 px, weight 500): page/section/card titles, focal labels
text-sm             (14 px, weight 400): body text, descriptions, hints
text-xs             (12 px):             captions, timestamps, badges, numeric metadata (kbd chips are text-2xxs, 11px — §4)
text-xs tabular-nums:                    counts, timers, numeric metadata
```

Markdown body (`.zeros-agent-md`) uses its own scale — see
`styles/global/runtime-content.css`.

**Fonts**: `Geist Variable` (sans) and `Geist Mono Variable` (mono). These are Vercel-published typography assets, imported as npm packages; they are not the design system reference (which is **Zeros Foundation**).

---

## §8 — Spacing + radius + motion

**Spacing**: 4 px grid. Use `p-2` (8), `p-3` (12), `p-4` (16), `p-6` (24). No `p-3.5`, no `space-y-5`.

**Radius**: a fixed 3-step scale (2026-07-12) — `rounded-sm` **4** (ALL buttons + icon buttons, pills/chips/badges, kbd, checkboxes, menu items, inputs, user messages), `rounded-md` **6** (tabs + segmented tracks, model/composer pills, sidebar + settings nav rows, small cards, tool-call rows, markdown img/table, tooltips), `rounded-lg` **8** (composer shell, dialogs, popovers, menus, cards, code blocks, toasts). Plus `rounded-full` (true circles only: avatars, spinner, switch, slider, dots, scrollbars) and `rounded-none` (nested resets). `rounded-xl/2xl/3xl/xs` and bare `rounded` no longer compile — those tokens were removed. Nesting: inner radius = outer radius − inset (8px menu, 4px padding → 4px items).

**Motion**:

- Hover bg/color: `duration-120 ease-out`
- Popover / sidebar: `duration-180 ease-out`
- Dialog enter: `duration-240 cubic-bezier(0.16, 1, 0.3, 1)`

Only animate: `color`, `background-color`, `border-color`, `opacity`, `box-shadow`, `transform`. **Never `transition: all`.**

---

## §9 — Appearance themes

Settings exposes four modes:

| Mode       | Resolved appearance | Structural palette                                                                     |
| ---------- | ------------------- | -------------------------------------------------------------------------------------- |
| System     | macOS dark/light    | Neutral Dark when macOS is dark; Light when macOS is light                             |
| Light      | light               | Warm off-whites in `[data-theme="light"]`                                              |
| Dark       | dark                | Achromatic structural values in `:root`                                                |
| Orka black | dark                | The former warm-gray dark values in `[data-theme-palette="orka-black"]` on a dark root |

`data-theme` remains strictly `dark` or `light`; it is an appearance-polarity
contract for Tailwind, native controls, code-theme filtering, and embedded
surfaces. The separate `data-theme-palette` attribute selects Orka black without
pretending it is a third polarity. Dark and Orka black therefore share the dark
syntax-theme preference; Light retains its own preference.

### 9.1 Neutral Dark contract

Neutral Dark removes hue and saturation only from **structural primitives**:
backgrounds, foregrounds, repository navigation, borders, highlighted/focus,
the inverted pair, and the primary-button hover. Most keep the former dark
palette's HSL lightness; the deliberate divergences are listed below, and one
primitive becomes an alias. Orka black is otherwise preserved byte-for-byte —
its only two intentional moves are the foreground-tier consolidation (§9.1.1):

| Primitive          |     Neutral Dark | Orka black | Propagation                                                                                         |
| ------------------ | ---------------: | ---------: | --------------------------------------------------------------------------------------------------- |
| `--bg2`            |              L13 |        L12 | Composer, raised cards, hover cards, active canvas tabs — **and neutral Dark's `--highlighted-bg`** |
| `--highlighted-bg` | `var(--bg2)` L13 |        L12 | User-message bubble, anchor selected states                                                         |
| `--fg1`            |              L94 |        L92 | Highlighted/selected text + icons                                                                   |
| `--fg2`            |              L72 |        L66 | Default text + icons app-wide                                                                       |
| `--fg3`            |              L60 |        L57 | **Reserved — zero consumers** (§9.1.1)                                                              |

`--bg1` (L7 → `#121212`) and `--sidebar-bg` (L9 → `#171717`) are the achromatic
equivalents of the warm palette's own lightness, so the canvas and repository
navigation sit exactly where they always have.

Aliases such as `--pane-bg`, `--bg3`, `--bg3-hover`,
`--primary-button-bg`, and `--primary-button-fg` are not duplicated; they
resolve lazily from the primitives. There is no `--bg2-highlight`
token: the existing lifted-content primitive is `--bg1-highlight` and remains
L9.

`--highlighted-bg` is the only structural primitive neutral Dark declares as a
`var()` alias rather than a literal triple: a sent user message then wears the
same fill as the composer it was typed in, so the prompt/composer pair reads as
one surface family. Orka black and Light each keep their own literal bubble
value, and because both re-declare the token the alias cannot leak into them.

The neutral ramp now has these intentional relationships:

- `--bg1` is L7, `--bg1-hover` is L12, and `--bg2` / `--highlighted-bg` are L13.
- `--muted-fg` is L44 — the lowest value that still clears the 3:1 non-text
  floor on `bg1`, `bg2`, AND `bg2-hover`. It is the app-wide quietest tier.
- `--fg3` is L60 — the middle tier, ~60% of the way from `--muted-fg` up to
  `--fg2` in log-contrast space. Orka black (L57) and Light (L44) re-derive that
  same RELATIVE position inside their own bands instead of copying the number —
  in Light a higher L means LESS contrast, so a copied `60` would invert the tier
  order. A palette test asserts the ladder in all three palettes.
- `--bg1-highlight`, `--sidebar-bg`, and `--bg3` are all L9.
- `--bg2-hover`, `--sidebar-bg-hover`, and `--bg3-hover` share L15.

These tokens are separated by context. The deliberate `--bg2` lift, the
`--highlighted-bg` alias, Orka black's preservation (minus the two changes in
§9.1.1), and the four-tier foreground ladder are regression-tested theme
contracts.

#### 9.1.1 Foreground tier consolidation

`--fg3` and `--muted-fg` used to be **the same color**: both L44 in neutral Dark
(byte-identical `#707070`), and L44 in Orka black differing only by 3% saturation.
Only Light distinguished them. The two names were used inconsistently as a
result — `--fg3` accumulated ~166 consumers app-wide while `--muted-fg` survived
as a ~25-consumer pocket in the Review/Changes surfaces — and the docs described
`--muted-fg` as the third tier while the code had converged on `--fg3`.

They are now one tier. Every former `--fg3` consumer moved to `--muted-fg`, and
`--muted-fg` **adopted the former `--fg3` value in each palette** so the ~191
migrated sites stayed pixel-identical:

| Palette      | `--muted-fg` before | after (former `--fg3`) | Effect on the 25 pre-existing consumers |
| ------------ | ------------------- | ---------------------- | --------------------------------------- |
| Neutral Dark | L44 `#707070`       | L44 `#707070`          | identical                               |
| Orka black   | `15 4% 44%`         | `15 1% 44%`            | ~3/channel — imperceptible              |
| Light        | L68 `#B1ACAA`       | L56 `#938D8A`          | 2.24:1 → 3.26:1 (intended fix)          |

`--fg3` is now the **adopted middle tier**, sitting exactly one step below
`--fg2`. The split that motivated it: some content must read quieter than the
`fg2` text _beside_ it, which is a different job from content that is incidental
to the surface. Pick by **reference point** — `fg3` when you are stepping down
from `fg2`, `muted-fg` when the content is merely supplemental.

| Adopted                                                                                                      | Was                    | Why                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input placeholders (`input.tsx`, `textarea.tsx`, `command.tsx`, `command` bars, browser + dispatcher fields) | `placeholder:text-fg2` | A placeholder in the DEFAULT text color reads as a filled value. In Light `fg3` is 4.95:1, which clears AA where `muted-fg` (3.26:1) does not.                                    |
| Composer placeholder (`composer-editor.css`)                                                                 | `var(--muted-fg)`      | Same case from the other side — it was one step too quiet. Both ends now meet at `fg3`, so every placeholder in the app is one weight.                                            |
| `.gitignore`'d rows + their folder glyph (`workspace-file-tree.tsx`)                                         | `var(--muted-fg)`      | Ignored rows read ONE step back from the `fg2` rows around them; `muted-fg` was two steps back. The glyph mask must track the row color or the mismatch reads as a rendering bug. |

Deliberately **left on `muted-fg`**, having been evaluated:

- **Review/Changes metadata** (timestamps, SHAs, counts, durations) and the
  `size-10` **empty-state icons** — genuinely incidental to their surface.
- **`--loader-rest`** — the spinner wants a WIDE gap from `--loader-active`
  (`fg2`), so the faintest tier is correct; `fg3` would flatten the sweep.
- **Two transient overlay inputs** — the inline rename in `repositories-panel.tsx`
  and the follow-up field in `question-card.tsx`. Both previously approximated a
  quiet placeholder with alpha (`text-fg2/60`, `text-fg2/50`, composing to
  4.09:1 and 3.20:1 in Dark), which is `muted-fg`'s range, not `fg3`'s — so they
  moved to the token rather than up a tier.
- **`--trees-fg-muted-override`** — it looks like a text knob but the library
  uses it for item ICONS and, at 25% alpha, the indent guides. One override,
  two very different jobs; changing it to brighten icons would also brighten
  every guide line. Left alone pending a look at the guides on their own.

The six status families remain chromatic: error/red, success/green,
warning/yellow, info/blue, merged/violet, and file-path/brown. Desaturating them
would erase useful semantic redundancy and flatten diff states. Syntax themes,
agent brand colors, file-type icons, and user/runtime colors are likewise
independent color systems and remain unchanged. The semantic-token layer needs
no Orka-specific values: its dark aliases resolve through the active primitives,
while status aliases deliberately keep their meaning-bearing families.

HSL lightness is not WCAG relative luminance, so “same L” is not assumed to mean
“same contrast.” The palette regression test verifies the authored H/S/L
contract, and UI review must still check text, focus, controls, selection,
translucent composites, and canvas-rendered surfaces.

The rendered-sRGB audit found no text or focus failure from the adjusted neutral
surfaces:

| Pair                             | Orka black | Neutral Dark |
| -------------------------------- | ---------: | -----------: |
| `fg1` / `bg1`                    |    15.69:1 |      16.41:1 |
| `fg2` / `bg1`                    |     7.91:1 |       9.41:1 |
| `fg3` / `bg1`                    |     5.98:1 |       6.58:1 |
| `muted-fg` / `bg1`               |     3.80:1 |       3.80:1 |
| `fg1` / `bg2`                    |    13.80:1 |      14.07:1 |
| `fg2` / `bg2`                    |     6.96:1 |       8.07:1 |
| `muted-fg` / `bg2`               |     3.34:1 |       3.26:1 |
| `muted-fg` / `bg2-hover`         |     3.04:1 |       3.05:1 |
| `highlighted-bright` / `bg1`     |     7.72:1 |       7.68:1 |
| inverted foreground / background |    16.28:1 |      16.27:1 |

Because `--highlighted-bg` now resolves to `--bg2`, the `fg1`/`bg2` and
`fg2`/`bg2` rows are also the user-message bubble's text contrast.

Light, for the same pairs: `fg1` 14.63:1, `fg2` 6.48:1, `fg3` 4.97:1,
`muted-fg` 3.26:1 — all against `bg1`.

`border3` and `border4` remain deliberately low-tonal against `bg1` (1.73:1
and 2.20:1 in neutral Dark). They are quiet separators, not the sole cue for a
control or state; interactive components must retain visible labels/icons and
the much stronger `highlighted-bright` focus treatment.

`muted-fg` is 3.80:1 against `bg1` and 3.26:1 against `bg2`, so it remains
appropriate only for supplemental metadata, disabled content, or decorative
empty-state treatment. Use `fg2` (9.41:1 on `bg1`, 8.07:1 on `bg2`) whenever
small text is required to understand or operate the interface. L44 is the
FLOOR for `muted-fg`, not a preference: it is the lowest lightness that still
clears 3:1 on `bg1`, `bg2`, and `bg2-hover` in both dark palettes, and a
palette test locks that in. In Light, `muted-fg` clears 3:1 on `bg1` (3.26:1)
but sits just under it on raised surfaces (2.93:1 on `bg2`) — a long-standing
shortfall inherited unchanged from the former `--fg3`, called out here rather
than asserted, so nobody "fixes" it by dimming the token further.

Two very quiet boundaries deserve deliberate treatment. `--bg1-highlight` over
`--bg1` is 1.05:1, so it is a grouping wash rather than a control/state cue;
components add spacing, dividers, or a stronger border when a boundary matters.
`--border1` over `--bg2` is 1.03:1, but raised cards are already distinguished
from `--bg1` by their L13 fill and geometry (1.17:1 — the cue that separates
both the composer and the user-message bubble from the canvas); interactive
composer focus moves to `--border2`, and selectable cards move to stronger
border/focus tokens. Do not use either quiet pairing as the only required
visual indicator.

### 9.2 Light-specific shape

- **`bg3` is floating-only and re-anchors per theme.** In light `bg3 == bg1` (pure white); in dark `bg3 == sidebar-bg` (one subtle step above bg1). Either way a floating panel gets its lift from `--shadow-dropdown` + `border-border2`, not a heavier fill — which is why §5.4 bans `bg-bg3` as any kind of fill (it vanishes or inverts in one theme or the other).
- **`bg4`/`bg5` continue the neutral ramp** as deeper chip greys (#F0F0F0 / #E0E0E0) — fg text stays readable on every bg step in both themes. The **inverted pair** (§2.1) is the only polarity-flipping surface.
- **The 50–950 color ramps are theme-static** — only the family anchors (`-primary`/`-secondary`/`-bg`/`-fg`) re-theme.

### 9.3 Non-CSS consumers and first paint

- The inline stamp in `index.html` restores both theme attributes before bundle evaluation, preventing an incorrect first frame.
- The Electron window's pre-paint `backgroundColor` tracks resolved `--bg1` via `window_set_background` and persists for the next launch. Every dark first-frame color the app has persisted (`#121212`, `#131111`, `#0e0c0c`, and the short-lived `#141414`) re-resolves against the active palette before the first frame. Native `themeSource` maps Orka black to dark while persisting the distinct app mode.
- xterm and canvas renderers resolve CSS variables to concrete colors. They subscribe to the concrete theme id (`dark` / `light` / `orka-black`), not only the dark/light variant.
- Cross-window storage sync, the durable userData fallback, and transition suppression all include palette-only changes.

---

## §10 — Workflow

When you tell Claude "build me a new card" or "polish this surface":

1. Open `styles/zeros-foundation.md` (this doc); skim §3 (surface map), §4 (recipes), §5 (anti-patterns).
2. Open the surface you're editing.
3. Apply the recipe; check anti-patterns.
4. Run `pnpm vite build` to catch typecheck or className errors.

When you tell Claude "change a token value": edit `zeros-tokens.css`. Don't sprinkle inline values.

When you tell Claude "introduce a new pattern": think first — does an existing primitive cover this? If not, add it to `zeros-tokens.css` then document the usage rule here.
