# Zeros design system

The normative guide for renderer UI (`apps/desktop/src/renderer/`) and the
shared stylesheets in `styles/`. Code, tokens, and checks are authoritative.
Every hard rule below names the check that enforces it; anything without a check
is labelled **judgment**.

- Token values, contrast results, and scales: [design-tokens.md](design-tokens.md)
  (generated — never edit by hand).
- Why things are the way they are: [design-system-history.md](design-system-history.md).
- Binding repository policy: [RULES.md](../RULES.md) §3.

"Zeros Design" (the product's Design directories, `design.toml`) is a separate
feature documented in [design-mode-roadmap.md](design-mode-roadmap.md). Zeros's
own mockups use it; see §11.

<!-- agent-brief:start -->
## Agent brief: UI work in Zeros

You are changing Zeros renderer UI (`apps/desktop/src/renderer/`) or `styles/`.
The full guide is `docs/design-system.md`; token values are in
`docs/design-tokens.md`; the current direction is its §0.

1. **Follow the direction (§0).** Few, quiet words: a title and at most one
   line of description, sentence case. Rows in grouped cards, not boxes in
   boxes. One banner, one message row and one empty state. One height per
   row. Color only for meaning. Selection is a fill, never an edge. Keyboard
   focus only for the keyboard. Each
   page's approved boards are exported to `docs/design-implementation/`; read
   the page's file before changing it.
2. **Compose, don't restyle.** Use the shared primitives in
   `apps/desktop/src/renderer/shared/ui/primitives/` (Button, IconButton,
   SplitButton, Toolbar, Field, Input, Textarea, Select, Checkbox, RadioGroup,
   Switch, Slider, Tabs, DropdownMenu, ContextMenu, Command, Popover, Dialog,
   Tooltip, Kbd, Badge, Pill, PanelHeader, ListRow, Card, …), the layout blocks
   in `shared/ui/layout/` (`Inline`, `Stack`, `Surface`) and `WorkbenchTabFrame`
   for every tab body. Missing a variant? Extend the primitive in `shared/ui/`
   with a test; never hand-build a `<button>`, `<input>`, `<select>` or
   `<textarea>` in feature code, and never restyle a primitive from a caller.
3. **Tokens only.** Color comes from token utilities (`bg-bg1`, `text-fg2`,
   `border-border1`, `text-red-primary`, …). No hex/rgb/hsl, no Tailwind palette
   colors (they do not compile), no arbitrary values such as `text-[14px]`,
   `z-[1000]` or `rounded-[18px]`; a derived value is written from a token
   (`rounded-[calc(var(--radius-lg)*1.5)]`). Token values live in
   `styles/tokens/*.tokens.json`; the CSS token blocks are generated.
4. **Surfaces decide hovers.** On `bg-bg1` hover with `hover:bg-bg1-hover`, on
   `bg-bg2` with `hover:bg-bg2-hover`, in the sidebar with
   `hover:bg-sidebar-bg-hover`; inside a `Surface`, `hover:bg-(--surface-hover)`.
   Floating surfaces (menus, popovers, tooltips, hover cards, toasts) are
   `bg-bg3` + `border-border2`, 12px corners, the dropdown shadow, a 4px inset
   and 28px rows with 8px corners; only they use `bg-bg3`. Navigation
   selection (sidebar, trees, layers) is `bg-bg2-highlight` with `text-fg1`, a
   step above hover. A pressed toggle, the active tab or segment, and a chosen
   chip or option fill with `bg-selected-bg`; no selected, pressed, active or
   current state adds a border, ring, outline or shadow.
5. **Text tiers:** `text-fg1` emphasis/selected, `text-fg2` default, `text-fg3`
   secondary and placeholders, `text-muted-fg` metadata. Never fake a tier with
   opacity (`text-fg2/60`). On a tinted `bg-<family>-bg`, text is
   `text-<family>-fg`.
6. **Scales:** text `text-xxs` 10 · `text-2xxs` 11 · `text-3xxs` 12 · `text-xs`
   13/18 · `text-sm` 14/20. Controls are 28 standard, 24 compact or 20 inline
   (IconButton), with 14, 12 and 12px glyphs; never mix heights in one row.
   Radius `rounded-sm` 4 (inline controls, pills, badges, kbd, checkboxes) ·
   `rounded-md` 6 (buttons, fields, tabs, tooltips, tools) · `rounded-lg` 8
   (menu rows, code blocks) · 12 derived (floating surfaces, dialogs, cards) ·
   10 derived (toolbars). Spacing steps 0–12 (half steps belong inside
   controls). Global layers `z-panel` · `z-chrome` · `z-dropdown` · `z-modal` ·
   `z-toast`; only `z-0`…`z-2` locally.
7. **States are the primitive's.** Hover, open, pressed (`aria-pressed`),
   keyboard focus (`highlighted-bright` with the 3px halo; fields ring only on
   keyboard focus), disabled (50%; `aria-disabled` keeps the reason tooltip)
   and loading (`loading` on Button and SplitButton). One choice in a menu is
   a check at the row's end, several a left check column; destructive rows
   are red and last; shortcuts are Kbd chips.
8. **Never** use `dark:` variants, `transition-all`, stock shadows such as
   `shadow-lg`, or a color as the only signal. Don't build class names at
   runtime (`text-${tone}`): map states to complete class strings. Persistent
   workbench failures use `WorkbenchTabFrame`'s one 32px banner; action
   outcomes use toasts; cloud lifecycle and connection messages never enter
   the banner (§7, Feedback).
9. **Verify:** run `pnpm check:ui` (compiles every class, enforces the policy
   ratchet) plus `pnpm typecheck`, `pnpm lint`, and the nearby tests. Fix
   findings; never raise `styles/policy/ui-debt.json`, add a `check:ui ignore`
   comment, or loosen `styles/policy/contrast-contract.json` to get green.
   Token or contract changes: run `pnpm design:docs`. Interaction, overlay,
   focus or popover work also runs `pnpm test:ui-smoke` and `pnpm build:ui`.
   State, navigation, loading, tab, panel or list work follows
   `docs/ui-interaction-performance.md`. Look at the result in both themes.
10. **Local and cloud:** every surface renders correctly for Local and
    organization workspaces with local and cloud placement, including each
    cloud VM state. Follow RULES.md §8 (the `zeros-workspaces` skill) and state
    both impacts in the PR.
11. **Learn the direction.** When the user corrects or decides a look, it is a
    direction, not a one-off: change the primitive or token that owns it,
    record it in §0 with a check where one can enforce it, and route the
    lesson through `zstack-learn` (§10). Mockups of Zeros live in
    `Zeros - Design/`; implement a frame by mapping its values to utilities
    and its controls to the shared primitives, never by copying its CSS.
<!-- agent-brief:end -->

## 0. Direction

The decisions the Zeros Design rounds converged on. They are the bar for every
new surface; the ones a check can enforce say so below, the rest are
**judgment**. The approved boards live in the Zeros Design canvas and are
exported page by page to [design-implementation/](design-implementation/README.md).

1. **Few, quiet words.** A title and at most one line of description. A hint
   only when it adds something the label and value don't. Sentence case,
   tabular numbers, no `Error:` prefixes or transport detail.
2. **Rows in cards, not boxes in boxes.** Lists are grouped cards: `bg1-bright`,
   `border1`, 12px corners, 12 × 14 rows, 13/18 medium names, 12/16 `fg3` hints,
   28px controls right-aligned, one ⋯ menu for secondary actions. Status shows
   only when something needs the person.
3. **One banner, one message row, one empty state.** A banner is a 32px row on
   the panel's own background with a `border1` rule below; its 16px icon
   carries the tone (red error, yellow warning, a spinner or `fg3`); one line
   that ends in an ellipsis; 24px Ghost actions. A message inside content uses
   the same anatomy. An empty state is a 32px `fg3` icon and one 13/18 `fg2`
   line, plus one action only when it creates or configures something.
4. **One surface language.** Canvas `bg1`; raised `bg2` or `sidebar-bg`;
   floating menus, popovers, tooltips, hover cards and toasts share `bg3` with
   `border2`, 12px corners, the dropdown shadow, a 4px inset and 28px rows with
   8px corners (`shared/ui/menu-surface.ts`, `Surface kind="floating"`). The
   chat composer, user messages and everything docked above the composer
   (dock cards and the @, / and # pickers) share `sidebar-bg` with `border2`
   and no shadow, 8px apart.
5. **One height per row.** 28 standard, 24 compact, 20 inline; glyphs 14, 12
   and 12. Controls in one row share a height; toolbars are 36px bars of 28px
   tools.
6. **Color carries meaning, never decoration.** Status families keep one
   meaning each; errors are a true red; the selection blue belongs to the
   Design canvas and a toolbar's active tool; everything else is neutral.
   Color is never the only signal.
7. **Keyboard focus is opaque and only for the keyboard.** Tab shows
   `highlighted-bright` with the 3px halo; a click or typing shows the caret
   (`FIELD_FOCUS` reads the focus tracker's `data-zeros-keyboard-focus`).
8. **Hover belongs to the surface; selected is a fill a step above it, never
   an edge.** Rows use their surface's hover; sidebar, tree and layer selection
   is `bg2-highlight` with `fg1`. A pressed toggle, the active tab or segment,
   and a chosen chip or option fill with `selected-bg` and hold it under the
   pointer. A control's resting edge stays as it is; selection never adds a
   border, ring, outline or shadow. Only keyboard focus rings, and objects on
   the Design canvas keep the selection stroke. `ui/selection-edge` enforces
   it in class names and the renderer's stylesheets.
9. **Two tab styles.** A segmented control switches a view; one strip tab
   serves chrome, workbench and chat. A closable tab shows ✕ on hover or focus
   over a fade in its own fill, so it never changes width.
10. **Menus say what kind of choice they are.** One choice: a check at the end
    of the chosen row. Several: a check column on the left. Destructive items
    last, in `red-primary`. Shortcuts are Kbd chips, one per key.
11. **Motion is color, opacity and transform**, 120ms ease-out, with reduced
    motion respected.
12. **Local and cloud are both first class.** Every surface states its Local
    and cloud behavior; cloud lifecycle never enters a tab banner.

### How the direction changes

The direction is expected to move. A change lands once, at its owner, so the
next agent inherits it instead of rediscovering it:

1. **Source.** An approved board in the Zeros Design canvas, or an explicit
   correction from the user. A one-off request for one screen is still a
   direction when it would look wrong anywhere else.
2. **Owner.** Change the token (`styles/tokens/`), the primitive
   (`shared/ui/primitives/`, with a test) or the shared pattern that owns the
   look, then migrate its callers. Never encode a direction as a caller
   override.
3. **Check.** Make it enforceable where possible: a `scripts/design-system/ui-policy.mjs`
   rule, a contrast pairing, a primitive test or a ui-smoke assertion.
   Otherwise mark it **judgment** in this guide.
4. **Record.** Update this section, the rule's own section, and the page's
   spec in `docs/design-implementation/` when it changes a page.
5. **Teach.** Run `pnpm design:docs`, which regenerates the `zeros-ui` skills
   from the agent brief above, and route the lesson through `zstack-learn`
   (an `agents/zstack/changes/` fragment for guidance, an eval case when an
   escaped mistake has a check).
6. **Retire.** Remove the superseded variant or prop and prune paid debt with
   `pnpm check:ui --prune-debt`, so two directions never coexist.

## 1. Workflow

1. Find the owning component. Reuse a primitive from `shared/ui/primitives/`
   or a feature kit (`features/settings/settings-ui.tsx`,
   `features/design-workspace/design-inspector-kit.tsx`). Extend a primitive
   when the behavior is genuinely shared.
2. Choose tokens from the tables below. Add a token only with its first real
   caller (§10).
3. Run `pnpm check:ui`. It compiles every class against the app's Tailwind
   entry, enforces the policy rules in §2, and checks that generated docs are
   fresh. Then `pnpm typecheck`, `pnpm lint`, the adjacent `__tests__` suites,
   and `pnpm build:ui` when the cascade or entrypoints could be affected.
4. Visual changes: look at the result in both themes (Settings → Appearance)
   before handoff (**judgment**).

## 2. Hard rules and their checks

| Rule | Enforced by |
| --- | --- |
| Every statically readable class compiles to CSS (no `text-error`, `bg-sidebar`, `rounded-xl`) | `check:ui` · `scripts/design-system/check-compiled-classes.mjs` |
| Only Zeros colors exist; Tailwind's palettes are reset | `--color-*: initial` in `styles/zeros-tokens.css` + the compile check |
| Token values come from DTCG JSON; generated CSS declarations are fresh | `check:ui` · `scripts/design-system/build-tokens.mjs` |
| No hex / rgb / hsl / oklch literals in components | `check:ui` line rules |
| No numeric palette steps (`text-red-500`, `var(--red-500)`) | `check:ui` line rules |
| No arbitrary visual values (`text-[14px]`, `leading-[1.6]`, `z-[1000]`) | `ui/arbitrary-value` |
| Global stacking through `z-panel` … `z-toast` | `ui/numeric-z` |
| Floating lift through `--shadow-dropdown`, not stock shadows | `ui/stock-shadow` |
| Text tiers are tokens, never opacity (`/60`, `/[.6]`, `/20.5`) | `ui/text-alpha` |
| Spacing and type stay on their scales | `ui/off-scale-spacing`, `ui/off-scale-text` |
| No `transition-all`; no `dark:` in components | `ui/transition-all`, `ui/dark-variant` |
| `-fg` on `-bg` for tinted containers | `ui/status-pairing` |
| Selected, pressed, active and current states draw no edge (border colour, ring, outline, shadow); keyboard focus and checked form controls are exempt | `ui/selection-edge` (class variants and the renderer's stylesheets) |
| No raw `<button>` / `<input>` / `<select>` / `<textarea>` outside `shared/ui/` | `ui/raw-control` |
| A quiet icon-only action is `IconButton` (a ghost `Button` at an icon size is not) | `ui/icon-only-button` |
| `bg-bg3` only on floating panels | `check:ui` (`BG3_SURFACE_FILES`) |
| Every declared pairing meets its role's contrast floor in both themes (AA text, focus, and reviewed supplemental/boundary floors) | `shared/theme/__tests__/contrast-contract.test.ts` · `styles/policy/contrast-contract.json` |
| No new `check:ui ignore` directives | `ui/ignore-directive` |
| Existing policy debt only shrinks | `styles/policy/ui-debt.json` ratchet (`pnpm check:ui --prune-debt` after paying debt) |
| Generated docs and agent files are fresh | `check:ui` (`pnpm design:docs` regenerates) |

`ui/*` rules live in `scripts/design-system/ui-policy.mjs`; they apply to
product UI (harness pages and tests are out of scope). A reviewed, intentional
deviation goes in the ledger's `exceptions` list with a reason, never as raised
debt. What the checks read: `className` / `*ClassName`, `cn` / `clsx` / `cva`,
`[…].join(" ")`, and the constants those reference (local, module, or named
imports, following property paths such as `chip.cls`). The ledger counts
`(rule, file, key)`; edits to it are owner-reviewed through CODEOWNERS.

## 3. Surfaces

| Surface | Fill | Hover / selected | Border | Notes |
| --- | --- | --- | --- | --- |
| Canvas, active chat, dialogs, sheets | `bg-bg1` | `bg-bg1-hover` | `border-border1` | Dialogs sit on `bg-scrim` |
| Inactive chat pane | `bg-(--pane-bg)` (= `bg0`) | — | — | Dims the fill only; text keeps full contrast |
| Raised: tiles | `bg-bg2` | `bg-bg2-hover` | `border-border2` | `bg-bg1-bright` for cards and settings groups |
| Chat composer, user messages and what docks above the composer | `bg-sidebar-bg` | `bg-sidebar-bg-hover` | `border-border2` | No shadow; 18px composer corners, 12px elsewhere. Dock cards use `DOCK_CARD_CLS`; the docked pickers use `PopoverContent surface="composer"` |
| Floating: menus, selects, command, popovers, tooltips, hover cards, toasts | `bg-bg3` | `bg-bg3-hover` | `border-border2` | 12px corners, 4px inset, lift = `shadow-[var(--shadow-dropdown)]`; feature panels take the fill from `FLOATING_SURFACE` |
| Repository sidebar | `bg-sidebar-bg` | `bg-sidebar-bg-hover` | `border-border2` | Settings navigation uses the default surfaces |
| Grouped content on canvas | `bg-bg1-highlight` | — | — | A wash, never the only boundary |
| Primary action | `bg-primary-button-bg` | `bg-primary-button-hover` | — | Text `text-primary-button-fg`; one per view |
| Selected control: pressed toggle, active tab or segment, chosen chip or option | `bg-selected-bg` | holds `bg-selected-bg` | never an edge; a resting edge is unchanged | One step above hover in Dark; equal to `bg2-highlight` in Light, where status text needs AA |

- Hover is **surface-scoped**: use the hover of the surface the element sits on.
- **Selected is a step above hover** for navigation: sidebar, tree and layer
  rows use `bg-bg2-highlight` with `text-fg1`; a chrome strip's active tab is
  `bg-bg2`; a menu's focused row keeps its hover.
- **Selection is a fill, never an edge.** Pressed (`aria-pressed`), active
  (`data-[state=active]`), on and chosen controls fill with `bg-selected-bg`
  and keep their resting edge. The primitives own it: Button (Secondary,
  Ghost), IconButton, Pill, Tabs and the Design inspector's segments and
  tools; a checked RadioGroup card fills to `bg1-hover` and keeps `border1`.
- `bg-bg3` is never a fill, chip, or selected state: it equals `bg1` in Light and
  the sidebar fill in Dark, so it vanishes or inverts on other surfaces.
- `--inverted-bg` always pairs with `--inverted-fg`.

## 4. Text

| Tier | Utility | Use | Contrast at rest |
| --- | --- | --- | --- |
| Emphasis | `text-fg1` | Selected rows, titles, transcript body | ≥ 12:1 |
| Default | `text-fg2` | Everyday text and icons | ≥ 7:1 |
| Secondary | `text-fg3` | Placeholders, secondary labels, ignored files | ≥ 5.6:1 |
| Supplemental metadata | `text-muted-fg` | Timestamps, counts, SHAs, empty-state icons | ≥ 3:1; steps up to fg3 on hover/selection |

- `fg1`–`fg3` meet WCAG AA on every rest and hover surface in both themes.
  `muted-fg` is the quietest supplemental tier: neutral `#6B6B6B` in both
  themes, with an owner-chosen 3:1 floor at rest, below AA by design.
  Hovered or selected rows step text **up** one
  tier (labels `text-fg2` → `text-fg1`, metadata `text-muted-fg` →
  `text-fg3`); menu, command, and select rows from `shared/ui/primitives/` do
  this for nested `text-muted-fg` automatically.
- Disabled controls use the control's `disabled:opacity-50` (WCAG-exempt). Do
  not reuse a disabled treatment for information people need to read.
- Placeholders are `placeholder:text-fg3`.

**Type scale** (chrome): `text-xxs` 10px · `text-2xxs` 11px · `text-3xxs` 12px ·
`text-xs` 13px on 18px · `text-sm` 14px on 20px · `text-dialog-title` 15px.
Page titles use `text-base` / `text-lg`. Agent markdown (`.zeros-agent-md`) has
its own scale in `styles/global/runtime-content.css`.

**Weights** are one notch lighter than Tailwind's: `font-normal` 400,
`font-medium` 450, `font-semibold` 500, `font-bold` 600. Hand-written CSS uses
`var(--weight-medium)` etc., never a bare number.

**Text selection:** desktop chrome is non-selectable by default, including
sidebar labels, tabs, settings copy, and portalled dialogs/menus. Native inputs,
textareas and editable content keep selection. Readable user/provider content
opts in with `select-text` at its owning surface: messages, thinking, tool
details, pending questions, queued prompts, source, diffs and logs. Keep actions
and line-number gutters non-selectable inside those surfaces. A read-only code
view is still readable content; do not rely only on `contenteditable=true`.
Native link/image drags are disabled unless explicitly `draggable=true`;
application tab drag-and-drop and selected-text dragging remain available.
`scripts/ui-smoke-text-selection.mjs` verifies real pointer selection, Select
All, editing, portals and vendor surfaces across owners, placements and themes.

## 5. Status color

| Family | Meaning |
| --- | --- |
| red | error, −N, destructive |
| green | success, +N |
| yellow | warning, modified, in progress |
| blue | info, links |
| violet | done, merged |
| brown | file paths, warm accents |

| Role | Utility | Use |
| --- | --- | --- |
| Status text, counts, icons | `text-<family>-primary` | On any app surface, rest or hover (AA) |
| Tinted container | `bg-<family>-bg` | Callouts, failed rows, chips |
| Text on that container | `text-<family>-fg` | Never `-primary` on `-bg` |
| Solid destructive | `bg-red-secondary` + `text-red-secondary-fg`, hover `bg-red-secondary-hover` | Delete buttons, destructive badges |
| Yellow graphics | `bg-yellow-icon`, `border-yellow-icon/40` | Dots, icons, tints — in Light `--yellow-primary` is ochre text |
| Highlight wash | `--yellow-wash` at 35% / 54% | Code-editor search matches |

- Color is never the only signal: pair it with an icon, a sign (+/−), or text.
- Diffs have their own inputs (`--diff-addition`, `--diff-deletion`,
  `--diff-neutral`, read by `shared/theme/diff-theme.ts`), so tuning status
  text never re-tints diff rows.
- Numeric ramps (`--red-500`, `bg-blue-400`) are private to
  `styles/zeros-tokens.css`.
- Syntax themes, agent brand marks, file-type icons, and user colors are
  separate color systems at real boundaries; they are not app tokens.

## 6. Borders, focus, elevation, layers, motion

- **Borders** `border-border1` (default on `bg1`) → `border-border2` (raised,
  floating, sidebar) → `border-border3` (control outline at rest: inputs,
  secondary buttons, triggers, radios) → `border-border4` (hover/open; also
  unchecked checkbox and switch outlines). Resting outlines are subtle by
  design: a reviewed decision below WCAG 1.4.11's 3:1. The contract enforces
  perceptibility floors of 1.45:1 for border3 and 1.6:1 for border4 on every
  surface controls sit on, and a ≥1.15× hover step on bg2. The user-message
  bubble is excluded because controls do not sit on it. Focus is the strong cue.
- **Focus** is an opaque `border-highlighted-bright`, `ring-highlighted-bright`,
  or `outline-highlighted-bright` (the radio uses an outline so its checked
  border cannot override it); the `ring-highlighted-bright/50` halo is
  decoration on top, never the only cue. `highlighted-bright` is reserved for
  focus, never hover.
  Desktop chrome shows this cue for deliberate Tab/Shift-Tab or a composite
  widget's navigation keys. Ordinary typing, modifiers, shortcuts and pointer
  focus do not promote a button into keyboard-navigation styling. Fields
  (Input, Textarea, InputGroup, the Select trigger) ring only when focus
  arrived by keyboard: the tracker marks that focus `data-zeros-keyboard-focus`
  and `FIELD_FOCUS` (`shared/ui/primitives/field.tsx`) reads it, so a click
  or typing shows only the caret. Use the shared `focus-visible:` variant (including
  `group-has-focus-visible`); raw and shadow-root selectors must respect
  `data-zeros-focus-visible="false"`. The renderer's
  `apps/desktop/src/renderer/shared/ui/focus-navigation.ts` observes intent
  without blurring controls or intercepting their keys.
- **Elevation** `shadow-[var(--shadow-dropdown)]` for floating surfaces
  (re-themes for Light).
- **Layers** `z-panel` < `z-chrome` < `z-modal` = `z-dropdown` < `z-toast`
  (values in `styles/global/platform.css`). Modal and dropdown share one layer
  on purpose: a menu, select, or tooltip opened from a dialog is portaled after
  it and so paints above it. `z-0`…`z-2` are free inside one component.
  Overlays use the shared primitives; never fix stacking with a big number.
- **Motion** animate only color, background, border, opacity, shadow, and
  transform: `transition-colors duration-120 ease-out` for hovers. Anchored menus,
  pickers, popovers, tooltips and hover cards use the shared entry motion and
  disappear immediately on close: their anchor can hide or unmount in that same
  commit. Dialogs and sheets retain their own viewport-based motion. Respect
  reduced motion.

## 7. Controls, radius, spacing

| Control height | Use | How |
| --- | --- | --- |
| 28px standard | Buttons, Select triggers, inputs, tabs, toolbar tools | `Button` default (`sm`/`default`/`lg` are the same control); `IconButton size="standard"` |
| 24px compact | Dense rows: section actions, trailing row actions, dialog close | `Button size="compact"`, `IconButton size="compact"`, `Input size="compact"`, `SelectTrigger size="compact"` |
| 20px inline | Actions embedded in rows and tabs, inline pills, badges | `IconButton` default, `Pill`, `Badge` |

- One height per row (**judgment**, enforced by component APIs where possible).
- Icons are 14px in standard controls and 12px in compact and inline ones (the
  primitive sizes them); empty states use a 32px `fg3` icon.
- Primary (`variant="primary"`) is the single focal action of a view; Secondary
  is the default button; Ghost for quiet text actions and a dialog's Cancel;
  icon-only actions are `IconButton`. Toggles use `aria-pressed` on Secondary,
  Ghost or IconButton, which press to the `selected-bg` fill with no edge; a
  toolbar's active tool is `pressedTone="tool"`.

**Radius:** `rounded-sm` 4px (inline icon buttons, pills, badges, kbd,
checkboxes, the inline-rename field) · `rounded-md` 6px (buttons, fields, tabs,
tooltips, toolbar tools, rows) · `rounded-lg` 8px (menu rows, code blocks) ·
`rounded-full` (true circles). Derived surface recipes: `MENU_SURFACE_RADIUS`
12px (`shared/ui/menu-surface.ts`) for every floating surface and dialog, the
same 12px for cards, tiles, `SETTINGS_GROUP_RADIUS` and `PROMPT_SURFACE_RADIUS`,
`TOOLBAR_RADIUS` 10px, `COMPOSER_SURFACE_RADIUS` 18px. Inner radius = outer
radius − inset.

**Spacing** steps (×4px): 0 · 0.5 · 1 · 1.5 · 2 · 2.5 · 3 · 3.5 · 4 · 5 · 6 · 7 ·
8 · 10 · 12, plus `px`. Half steps (2/6/10/14px) belong inside controls and dense
rows; layout gaps prefer `gap-1` `gap-2` `gap-3` `gap-4` `gap-6`.

**Tooltips:** use the shared `Tooltip` only when it adds useful information:
an unfamiliar icon, a shortcut, a disabled-action reason, or hidden/truncated
content. Visible labels, repository row actions, Design layers and property
add/remove buttons, routine plus/close/overflow controls, and standard browser
navigation stay quiet. Keep accessible names and keyboard shortcuts on controls
even when removing their hover hint. Inspector icon buttons opt in with
`tooltip`; a `label` alone supplies their accessible name.

A tooltip is a solid floating chip: `bg-bg3`, `border-border2`, the dropdown
shadow, `rounded-md` (6px), 8 × 3 padding and `text-3xxs` (12/16) in `fg1`; a
`shortcut` renders as Kbd chips. Ordinary hints wait 1000ms; retained menu/popover hints
wait 1500ms and are suppressed while the popup is open. Each hint owns its hover
delay so moving between neighbors never warms an instant-open group. Keyboard
focus still exposes help, Escape dismisses it, and pointer-driven focus does
not open it. Prefer one or two words in sentence case; preserve meaningful
paths, values and failure explanations rather than shortening away information.
`scripts/ui-smoke-tooltips.mjs` checks timing, geometry in both themes, focus,
surface replacement, and Local/organization-local/cloud composer behavior.

**Feedback:** outcomes of user actions (save, discard, merge, fork) use the
single app-wide toast surface — `toast` / `toast.error` / `toast.success` from
`shared/ui/primitives/elements`. Persistent state stays with its owner: a form
error beside its field, or a workbench content load failure in its
tab's status banner. Never toast that same load failure while its frame is
visible. Local engine rejection keeps its original app-level toast when no
affected workbench frame is visible; the passive frame visibility registry
dismisses it as soon as a frame represents the condition. Cloud connect/open
failures keep their existing app-level toast regardless of frame visibility.
Engine rejection banners preserve the reason-specific update/sign-in headline.

Every workbench body, including retained Design, Setup, terminal tabs and the
bottom Terminals panel, uses one `WorkbenchTabFrame`. Its persistent full-width
banner follows all of the tab's own toolbar rows. Local engine availability wins
over persistent primary data failure, then secondary reads (comments, history, ignored
entries). It has no close button or timer and clears after successful recovery.
Cloud lifecycle and connection conditions never appear in this banner, including
connection failures returned through a tab's read. Filter those before choosing
the primary/secondary failure so they cannot hide a separate file, Git or review
error. Cloud lifecycle remains in workspace details; failed connect/open actions
use their existing toast. Feature notices such as shallow history and unsupported
features remain eligible for the banner.
Confirmed content for the exact workspace/target stays visible during refresh
and failure. Without confirmed content and with a persistent status, show the tab icon (`size-8`,
`text-fg3`) and one neutral sentence of about eight words or fewer
(`text-fg2 text-xs`), centred with no buttons or repeated error text.
Legitimate non-error empty states may retain their creation/configuration action.
Every tab's adapter defines pending, retryable and unavailable empty copy.
Pending copy explains that content appears when the workspace is ready; Retry
copy is reserved for a banner offering Retry. Cold cloud availability keeps
the neutral fallback without a banner or an orphan Retry instruction.
Archived or non-retryable states
say the content is unavailable. A single-file viewer says “this file”. Terminal
reconnections after a confirmed connection say “Terminal reconnects automatically.”

**Transient** means a brief connection gap, a read
that fails once and succeeds on one silent automatic retry after about 1.5
seconds, or a revalidation failure with confirmed content that recovers on the
next automatic attempt. These conditions have no banner and no error empty
state. Keep confirmed exact-key content mounted and visible, including Design's
canvas or confirmed start surface. No extra indicator is needed: continuity
keeps normal recovery quiet and avoids layout movement or status flashes.

**Persistent** tab failures still fail after that one silent retry and show
the shared banner when confirmed. Local engine startup and reconnection
never show a pending connection banner;
keep confirmed content in place while the on-device engine becomes ready.
A Local gap lasting 45 seconds still exposes “Can't reach the Zeros engine.”
with Retry, and terminal rejections remain immediate. Cloud setting up,
starting/waking, stopping, sleeping, archived, failed, and connection states
remain absent from the banner at every duration. The shared cloud availability
clock still selects quiet cold-content placeholders after 10 seconds and
unavailable placeholders after 45 seconds; confirmed content stays visible.

Availability has one decision and clock per Local engine or cloud VM; all its
tabs observe the same thresholds. Silent read retries belong to the exact
source/target, share one flight, and keep confirmed content through revalidation.
Known transport gaps pause silent read retries; an offline rejection does not
consume the recovery attempt or flash a read banner when the connection returns.
Persistent informational notices (such as shallow Git history) appear immediately
in the existing banner slot. These failure thresholds do not delay information;
any availability/read failure hides the notice, including a silent first failure.
Successful automatic recovery cancels the retry and clears the condition;
failed retries remain visible until recovery. Hidden tabs and hidden documents
run no status/retry timers; activation uses the original timestamp. Passive
reads and connection admission never wake a cloud computer.

The banner is one 32px row on the panel's own background with a `border1`
rule below. Its 16px icon alone carries the tone: a `red-primary` error icon
for failures, the shared spinner for self-resolving Local availability (with
reduced-motion support), and an `fg3` info icon for informational notices. Visible copy is short, human and sentence case; enum values, stack
traces, `Error:` prefixes and transport details belong only in sanitised title
diagnostics. Copy describes the workspace condition or “Couldn't load files” /
“Files took too long to load”, never a false unconfigured/empty result.

The banner message is one line that ends in an ellipsis, with full copy in its
title. A single 24px Ghost action stays visible at narrow widths; Retry has a tab-specific
accessible name, shares one flight across failed sources, and says “Retrying…”
until settled, bounded to 30 seconds even if a source never settles. When
retrying cannot fix a named condition (a refused GitHub connection), the action
opens where it is fixed instead, such as “Open GitHub settings”, and the centre
says the content isn't available; the tab still reloads when it is shown again. Keep the
banner element/live region stable through retry and tone changes; announce
message changes once without moving focus. Hidden retained tabs
are inert and do not announce, animate, poll or run status timers.
Cloud connection/lifecycle copy must not leak into the banner's live region or
title, including after retry or an owner/placement switch.

## 8. Building blocks

Compose recurring structure from shared blocks instead of re-writing class
recipes. Keep semantic element types, and keep feature behavior (handlers,
state, `aria-*`, `data-*` hooks) at the caller.

| Need | Use | Contract |
| --- | --- | --- |
| A surface that owns its descendants' hover/selected fill | `Surface` (`shared/ui/layout/surface.tsx`) | `kind="canvas" \| "raised" \| "floating" \| "sidebar"`, optional semantic `as`. Paints the surface fill and binds `--surface-hover` / `--surface-border` for descendants. `floating` is for real menus and popovers. |
| Horizontal layout on the spacing scale | `Inline` (`shared/ui/layout/inline.tsx`) | `gap`, `align`, `justify`, `wrap`, `as`; flex with no implicit constraints. |
| Vertical layout on the spacing scale | `Stack` (`shared/ui/layout/stack.tsx`) | Same props; adds `flex-col`. |
| An icon-only action | `IconButton` | Required `label` (its accessible name); `size="inline"` 20px (4px corners) inside a row or tab, `"compact"` 24px, `"standard"` 28px; the glyph size belongs to the size. One `bg2-highlight` hover, the keyboard ring at every size, `aria-pressed` as the `selected-bg` fill with no edge or `pressedTone="tool"` for a toolbar's active tool; `asChild` keeps link semantics. Inside a `Toolbar` or `PanelHeader` the default size is standard (`IconButtonSizeContext`). |
| A group of tools | `Toolbar` (+ `ToolbarSeparator`, `ToolbarText`) | One 36px bar of 28px tools: `bg2`, `border2`, 10px corners, `elevation="floating"` (dropdown shadow) or `"docked"`, `orientation`. One Tab stop: arrow keys, Home and End move between enabled tools. |
| An action with related choices | `SplitButton` / `splitButtonClasses` | Two bordered halves, each with Button's focus ring; `variant="primary" \| "secondary"`, `size`, `loading` (the menu waits). |
| A form field | `Field` around `Input`, `Textarea` or a Select trigger | One label (13/18 medium), one hint (12/16 `fg3`) that an error replaces (12/16 `red-primary`); wires `id`, `aria-describedby` and `aria-invalid`. `Input` has `size="compact"`, `appearance="inline"` (rename) and `mono`. |
| A reference chip or a status tag | `Pill` · `Badge` | `Pill` is an interactive reference: `size="inline"` 20px or `"control"` 24px, `tone` neutral / failed / mode / gone / invalid. `Badge` is inert state: one 20px size, tinted `neutral` / `outline` / `success` / `failure` / `warning` / `info` / `merged`. |
| A shortcut | `Kbd` · `KbdKeys` | An 18px `border2` chip on `bg2`; `KbdKeys keys="⌘⇧T"` draws one chip per key. Menus, tooltips and the command palette all use it. |
| Window chrome or a panel heading | `PanelHeader` (+ `PanelHeaderTitle`, `PanelHeaderActions`) | Required `size="window"` (40px, gap-1, px-2, `bg-bg1`) or `size="panel"` (36px, gap-2, px-3); border1 bottom divider; a 13 medium `fg1` title that truncates; actions 2px apart. |
| A compact tool disclosure or hover trigger | `ListRow` | 28px button row on `bg1-hover` with the keyboard ring; expanded adds no fill. The caller owns `aria-expanded`, `aria-controls`, labels, state, and events. |
| A tool row whose file or link targets sit beside its name | `ListRowGroup` with a `ListRow` disclosure (`data-list-row-disclosure`, `LIST_ROW_IN_GROUP`) | The same 28px row with 8px sides and 6px corners: the group hovers, shows the keyboard ring and toggles on a click in its gaps; the targets keep their own clicks. |
| A message inside content | `MessageRow` (`shared/ui/primitives/message-row.tsx`) | The banner anatomy without the bar: a 32px row, the 16px icon carries `tone` (`error` / `warning` / `success` / `neutral` / `pending`), one 13/18 `fg2` line that truncates, 24px Ghost `actions`. `bar` adds the `border1` rule under a toolbar; `flush` drops the side padding inside a padded card. The caller sets `role="alert"` for errors. |
| A settings list | `SettingsGroup` · `SettingsList` · `SettingsRow` · `SettingsField` (`features/settings/settings-ui.tsx`) | The grouped card: `bg1-bright`, `border1`, 12px corners, 12 × 14 rows, 13/18 medium names, 12/16 `fg3` hints, controls right-aligned. `SettingsRow` takes `leading` for an avatar or icon; secondary actions go in one ⋯ menu; trailing selects use `width="fixed"` (160px). |
| The last row of a list card, adding an item | `SettingsAddRow` | The whole 44px row is the target: a 14px `fg3` plus and 13/18 `fg2` text that lifts to `fg1`. |
| A configured server or similar list row | `McpServerRow` (`features/agent-extensions/mcp-server-row.tsx`) | A 48px `Badge mono` transport column so names share an edge, the name and one 12px hint, then status only when it needs the person, one action, the switch and one ⋯ menu, all 24px. `McpToolList` puts its tools under the name. |
| Content still loading in a list | `SkeletonLine` (`shared/ui/primitives/skeleton.tsx`) | An 8px `bg2` bar with 4px corners, no shimmer; the region carries `aria-busy`. Two rows for a list. |
| A card or a tile | `Card` · `Tile` | `bg1-bright` / `bg2`, `border1`, 12px corners, 16 padding; a Tile's hover is `bg2-highlight` with `border3`. |
| Every workbench tab body | `WorkbenchTabFrame` + `WorkbenchTabToolbar` (`shell/workbench/tab-status.tsx`) | Structural single status slot under portalled toolbar rows; preserves confirmed content. Supplies `WorkbenchEmptyState` only for a persistent condition without confirmed content; raw child fallbacks follow that same decision. The exhaustive `WorkbenchTabType` adapter requires copy/icon for future tabs. |
| A tab's persistent read status | `useWorkbenchStatusSource` + `describeWorkbenchFailure` | Exact-owner primary/secondary errors get one silent automatic retry before feeding `WorkbenchTabBanner`; Local availability has priority and cloud connection/lifecycle errors are excluded. Action outcomes remain toasts. |

- `Inline` / `Stack` accept only the gap steps `0`, `0.5`, `1`, `1.5`, `2`,
  `2.5`, `3`, `4`, `6`, `8`. Their `className` is for outer layout (sizing,
  shrinking, positioning), never visual styling or extra gap/alignment classes.
- Put repository navigation inside `Surface kind="sidebar"` and use
  `hover:bg-(--surface-hover)` for hover, selected, and focus-within fills; a
  standalone preview of a sidebar row needs the same Surface. Settings
  navigation keeps its own surface. Don't override a Surface's fill while its
  contextual tokens still describe another surface.
- New callers use the defaults. Window-header `h-9` / `gap-2` overrides exist
  only on pages not yet moved to the Zeros Design and are deprecated.
- Don't add wrapper elements just to adopt a block. A new pattern component
  needs a real caller and a permanent markup contract; migrations prove the
  rendered tag and complete class set are unchanged (see
  `shared/ui/primitives/__tests__/`).

## 9. Theming runtime

```
styles/zeros-tokens.css      Tailwind import, @source allowlist, @theme wiring,
                             :root (Dark) + [data-theme="light"] primitives,
                             named z utilities, base border/outline defaults
styles/semantic-tokens.css   feature aliases (switch, loader, PR island, design)
styles/globals.css           ordered cross-boundary modules in styles/global/
```

`apps/desktop/src/renderer/main.tsx` imports them in that order; the order is a
cascade contract. `<html data-theme="dark|light">` is the resolved appearance
(System follows macOS). The store in `shared/theme/store.ts` applies it,
`index.html` stamps it before first paint, and Electron receives the resolved
`--bg1` for the native window background. JS-painted surfaces (xterm, canvas)
read tokens through `shared/theme/resolve-tokens.ts` and repaint on the theme id.

Three other consumers use these tokens. The marketing site (`apps/marketing`)
clones 26 public tokens, generated from the same sources and guarded by
`apps/marketing/src/lib/__tests__/marketing-tokens.test.ts`; `apps/web` slices
`styles/zeros-tokens.css` at build time for the dashboard; and the repository's
Design directory imports the app's stylesheets as style sources and previews
`styles/tokens/` edits live (§11).

## 10. Changing the system

- **New token:** add a DTCG token to `styles/tokens/base.tokens.json` and its
  Light override to `styles/tokens/light.tokens.json` when needed. Put the
  existing CSS name, declaration section, and optional utility wiring in
  its `org.zeros` extension (see [token source guide](../styles/tokens/README.md)).
  Add pairings to `styles/policy/contrast-contract.json`, then run
  `pnpm design:docs` to regenerate CSS, docs, and agent files. Feature-only
  aliases go in `styles/semantic-tokens.css`.
- **Token value change:** edit `styles/tokens/*.tokens.json`, run
  `pnpm design:docs` to regenerate app and marketing declarations, and pass
  the contrast contract. The Design tab previews the edit before that.
  Hue changes to a status family need design approval. CSS declarations inside
  `@generated` markers are generated; imports, explanations, type/radius/weight
  wiring, native appearance hints, named utilities and base rules stay authored.
  `styles/tokens/zeros.resolver.json` defines the base set followed by the
  appearance modifier; CSS names and cascade order remain compatibility contracts.
- **Primitive change:** in `shared/ui/primitives/` with a test in
  `shared/ui/primitives/__tests__/`; keep the API compatible, or migrate every
  caller in the same change and retire the old name.
- **Direction change:** follow §0, "How the direction changes": owner first,
  then a check, the record, `pnpm design:docs` and `zstack-learn`.
- **Paying debt:** fix the finding, then `pnpm check:ui --prune-debt`.
- Owner review (`.github/CODEOWNERS`): `styles/`, `shared/ui/`,
  `scripts/design-system/`, and the docs in this family.

## 11. Designing Zeros in its Design directory

Mockups of Zeros itself live in `Zeros - Design/`, the repository's registered
Design directory, and open in the Design tab. Its `rules.md` adapts this guide
to frames; [design-mode-roadmap.md](design-mode-roadmap.md) documents the
feature. The older standalone mockups in `styles/Artifacts/` hand-copied token
values and most no longer match the palette; treat them as historical
references, not as a template.

- The directory imports the app's own stylesheets as style sources
  ([imported style sources](design-mode-roadmap.md#imported-style-sources)),
  read live from the checkout: `styles/zeros-tokens.css` as a `tailwind`
  source, compiled for each frame's classes (Tailwind emits the font, type and
  radius scales a frame reads with `var()`), and `styles/semantic-tokens.css`
  as a `css` source. The `styles/global/*.css` modules that `styles/globals.css`
  imports (1px lucide strokes, agent markdown, scrollbars, keyframes), the
  renderer's component stylesheets and the sonner and xterm vendor CSS are
  `css` sources too, declared one per file because a `css` source does not
  follow `@import`. Frames therefore use the app's utilities (`bg-bg2`, `p-3`,
  `rounded-md`, `text-xs`) and its tokens, including uncommitted edits. An edit
  to `styles/tokens/*.json` reaches frames once `pnpm design:docs` regenerates
  `styles/zeros-tokens.css`.
- `Zeros - Design/meta/canvas.json` names the themes: Dark is the default theme (`dark`,
  whose values are `:root`) and Light is `light`; the app source maps
  `[data-theme="dark"]` and `[data-theme="light"]` onto them.
- `Zeros - Design/tokens.css` keeps only Design-only tokens: spacing steps
  (`--space-<step>`), control heights and a 14px text size. A Manual token that
  redeclares a product token would override the app's value; the theme editor
  marks any that do.
- A product token change goes to `styles/tokens/*.tokens.json`, never into
  `tokens.css` or the theme editor. An unadopted proposal stays in its
  frame's own `<style>` and is labelled as a proposal.
- Implementing a frame maps its values to utilities (`var(--bg2)` is `bg-bg2`,
  `var(--radius-md)` is `rounded-md`, and a `--space-<step>` value is that
  Tailwind step, such as `p-3` or `gap-3`) and its controls to the shared
  primitives. A frame written with the app's utilities keeps those class
  strings. Copying a frame's custom CSS into a component is a policy
  violation, not an implementation.
- Frames render Geist and Geist Mono through the `app` style source, whose
  Tailwind entry imports the installed `@fontsource-variable` packages; without
  installed dependencies they fall back to the system UI font. Native capture
  shows the default (Dark) theme unless given a theme id; capture `light` as
  well (**judgment**). `design styles` reports the sources' status.
