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
feature documented in [design-mode-roadmap.md](design-mode-roadmap.md).

<!-- agent-brief:start -->
## Agent brief: UI work in Zeros

You are changing Zeros renderer UI (`apps/desktop/src/renderer/`) or `styles/`.
The full guide is `docs/design-system.md`; token values are in
`docs/design-tokens.md`.

1. **Compose, don't restyle.** Use the shared primitives in
   `apps/desktop/src/renderer/shared/ui/primitives/` (Button, IconButton,
   Input, Textarea, Select, Checkbox, Switch, Tabs, DropdownMenu, Popover,
   Dialog, Tooltip, Kbd, Badge, Pill, PanelHeader, ListRow, …) and the layout
   blocks in `shared/ui/layout/` (`Inline`, `Stack`, `Surface`). Missing a
   variant? Extend the primitive in `shared/ui/` — never hand-build a
   `<button>`, `<input>`, `<select>`, or `<textarea>` in feature code.
2. **Tokens only.** Color comes from token utilities (`bg-bg1`, `text-fg2`,
   `border-border1`, `text-red-primary`, …). No hex/rgb/hsl, no Tailwind palette
   colors (they do not compile), no arbitrary values such as `text-[14px]`,
   `z-[1000]`, or `rounded-[18px]`. Token values live in
   `styles/tokens/*.tokens.json`; the CSS token blocks are generated.
3. **Surfaces decide hovers.** On `bg-bg1` hover with `hover:bg-bg1-hover`, on
   `bg-bg2` with `hover:bg-bg2-hover`, in a menu with `hover:bg-bg3-hover`, in
   the sidebar with `hover:bg-sidebar-bg-hover`. Inside a `Surface`, use
   `hover:bg-(--surface-hover)` and the surface picks the right one. `bg-bg3`
   is only for floating menus and popovers. Selected = the hover state that
   stays.
4. **Text tiers:** `text-fg1` emphasis/selected, `text-fg2` default, `text-fg3`
   secondary and placeholders, `text-muted-fg` metadata. Never fake a tier with
   opacity (`text-fg2/60`). On a tinted `bg-<family>-bg`, text is
   `text-<family>-fg`.
5. **Scales:** text `text-xxs` 10 · `text-2xxs` 11 · `text-3xxs` 12 · `text-xs`
   13/18 · `text-sm` 14/20. Controls are 28px (standard) or 24px (Button
   `size="compact"` / `"icon-compact"`) — never mix heights in one row. Radius
   `rounded-sm` 4 · `rounded-md` 6 · `rounded-lg` 8. Spacing steps 0–12 (half
   steps belong inside controls). Global layers `z-panel` · `z-chrome` ·
   `z-dropdown` · `z-modal` · `z-toast`; only `z-0`…`z-2` locally.
6. **Never** use `dark:` variants, `transition-all`, stock shadows such as
   `shadow-lg` (floating surfaces use `shadow-[var(--shadow-dropdown)]`), or a
   color as the only signal (pair status color with an icon or text). Don't
   build class names at runtime (`text-${tone}`): the checks can't see them —
   map states to complete class strings instead.
   Workbench content load/availability failures use `WorkbenchTabFrame`'s
   single persistent banner and neutral icon/line empty state. Action outcomes
   use toasts. Connection failures fall back to their existing app toast only
   while no affected frame is visible. Report each read with
   `useWorkbenchStatusSource`; retain confirmed exact-key content and never add
   a second error paragraph or Retry button.
7. **Verify:** run `pnpm check:ui` (compiles every class, enforces the policy
   ratchet) plus `pnpm typecheck`, `pnpm lint`, and the nearby tests. Fix
   findings; never raise `styles/policy/ui-debt.json`, add a `check:ui ignore`
   comment, or loosen `styles/policy/contrast-contract.json` to get green.
   Token or contract changes: run `pnpm design:docs` and say so in the handoff.
8. **Local and cloud:** every surface renders correctly for Local and
   organization workspaces with local and cloud placement, including each cloud
   VM state (setting up, starting, sleeping, stopped, failed, archived). Follow
   RULES.md §8 (the `zeros-workspaces` skill) and state both impacts in the PR.
<!-- agent-brief:end -->

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
| No raw `<button>` / `<input>` / `<select>` / `<textarea>` outside `shared/ui/` | `ui/raw-control` |
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
| Raised: composer, cards, hover cards | `bg-bg2` | `bg-bg2-hover` | `border-border2` | `bg-bg1-bright` for settings groups |
| Floating: menus, popovers, selects, command | `bg-bg3` | `bg-bg3-hover` | `border-border2` | Lift = `shadow-[var(--shadow-dropdown)]` |
| Repository sidebar | `bg-sidebar-bg` | `bg-sidebar-bg-hover` | `border-border2` | Settings navigation uses the default surfaces |
| Grouped content on canvas | `bg-bg1-highlight` | — | — | A wash, never the only boundary |
| Primary action | `bg-primary-button-bg` | `bg-primary-button-hover` | — | Text `text-primary-button-fg`; one per view |

- Hover is **surface-scoped**: use the hover of the surface the element sits on.
- **Selected = hover that stays** (sidebar rows, tabs, tool rows).
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
| Highlight wash | `--yellow-wash` at 35% / 55% | Code-editor search matches |

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
- **Elevation** `shadow-[var(--shadow-dropdown)]` for floating surfaces
  (re-themes for Light).
- **Layers** `z-panel` < `z-chrome` < `z-modal` = `z-dropdown` < `z-toast`
  (values in `styles/global/platform.css`). Modal and dropdown share one layer
  on purpose: a menu, select, or tooltip opened from a dialog is portaled after
  it and so paints above it. `z-0`…`z-2` are free inside one component.
  Overlays use the shared primitives; never fix stacking with a big number.
- **Motion** animate only color, background, border, opacity, shadow, and
  transform: `transition-colors duration-120 ease-out` for hovers; overlays use
  their primitive's enter/exit animation. Respect reduced motion.

## 7. Controls, radius, spacing

| Control height | Use | How |
| --- | --- | --- |
| 28px standard | Buttons, Select triggers, inputs, tabs | `Button` default (`sm`/`default`/`lg` are the same control); `size="icon"` for icon-only |
| 24px compact | Dense rows: inline toolbars, trailing row actions, chips | `Button size="compact"` / `size="icon-compact"` |

- One height per row (**judgment**, enforced by component APIs where possible).
- Icons are 14px in standard controls and 12px in compact ones (Button sizes
  them); empty states use `size-10`.
- Primary (`variant="default"`) is the single focal action of a view; Secondary
  is the default button; Ghost for icon-only and toolbar actions.

**Radius:** `rounded-sm` 4px (chips, badges, kbd, checkboxes) · `rounded-md` 6px
(buttons, inputs, tabs, rows) · `rounded-lg` 8px (cards, dialogs, code blocks,
toasts) · `rounded-full` (true circles). Derived surface recipes:
`MENU_SURFACE_RADIUS` 16px (`shared/ui/menu-surface.ts`),
`SETTINGS_GROUP_RADIUS` and `PROMPT_SURFACE_RADIUS` 12px,
`COMPOSER_SURFACE_RADIUS` 18px. Inner radius = outer radius − inset.

**Spacing** steps (×4px): 0 · 0.5 · 1 · 1.5 · 2 · 2.5 · 3 · 3.5 · 4 · 5 · 6 · 7 ·
8 · 10 · 12, plus `px`. Half steps (2/6/10/14px) belong inside controls and dense
rows; layout gaps prefer `gap-1` `gap-2` `gap-3` `gap-4` `gap-6`.

**Feedback:** outcomes of user actions (save, discard, merge, fork) use the
single app-wide toast surface — `toast` / `toast.error` / `toast.success` from
`shared/ui/primitives/elements`. Persistent state stays with its owner: a form
error beside its field, or a workbench content load/availability failure in its
tab's status banner. Never toast that same load failure while its frame is
visible. Engine rejection and cloud connect/open failures keep their original
app-level toast when no affected workbench frame is visible; the passive frame
visibility registry dismisses it as soon as a frame represents the condition.
Engine rejection banners preserve the reason-specific update/sign-in headline.

Every workbench body, including retained Design, Setup, terminal tabs and the
bottom Terminals panel, uses one `WorkbenchTabFrame`. Its persistent full-width
banner follows all of the tab's own toolbar rows. Workspace availability wins
over primary data failure, then secondary reads (comments, history, ignored
entries). It has no close button or timer and clears after successful recovery.
Confirmed content for the exact workspace/target stays visible during refresh
and failure. Without confirmed content, show the tab icon (`size-10`,
`strokeWidth={1}`, `text-muted-fg`) and one neutral sentence of about eight words
or fewer (`text-fg2 text-xs`), centred with no buttons or repeated error text.
Legitimate non-error empty states may retain their creation/configuration action.
Every tab's adapter defines pending, retryable and unavailable empty copy.
Pending copy explains that content appears when the workspace is ready; Retry
copy is reserved for a banner offering Retry. Archived or non-retryable states
say the content is unavailable. A single-file viewer says “this file”. Terminal
reconnections after a confirmed connection say “Terminal reconnects automatically.”

Failures use `bg-red-bg text-red-fg` and a leading error icon. Self-resolving
availability (setup, starting, reconnecting) uses `bg-yellow-bg text-yellow-fg`
and a calm spinner with reduced-motion support. Archived workspaces use a neutral
info tone. Visible copy is short, human and sentence case; enum values, stack
traces, `Error:` prefixes and transport details belong only in sanitised title
diagnostics. Copy describes the workspace condition or “Couldn't load files” /
“Files took too long to load”, never a false unconfigured/empty result.

The banner message wraps to two lines with full copy in its title. A single
compact ghost action stays visible at narrow widths; Retry has a tab-specific
accessible name, shares one flight across failed sources, and says “Retrying…”
until settled, bounded to 30 seconds even if a source never settles. Keep the
banner element/live region stable through retry and tone changes; announce
message changes once without moving focus. Hidden retained tabs
are inert and do not announce, animate, poll or run status timers. Reconnect
grace (2 seconds, including the first connection) and escalation (20 seconds) use
connection timestamps on activation. Passive reads/Retry admission never wake a
cloud computer.
Before a successful connection, use “Connecting”; reserve “Reconnecting” for
a lost confirmed connection. Stopping and stopped have distinct pending copy.

## 8. Building blocks

Compose recurring structure from shared blocks instead of re-writing class
recipes. Keep semantic element types, and keep feature behavior (handlers,
state, `aria-*`, `data-*` hooks) at the caller.

| Need | Use | Contract |
| --- | --- | --- |
| A surface that owns its descendants' hover/selected fill | `Surface` (`shared/ui/layout/surface.tsx`) | `kind="canvas" \| "raised" \| "floating" \| "sidebar"`, optional semantic `as`. Paints the surface fill and binds `--surface-hover` / `--surface-border` for descendants. `floating` is for real menus and popovers. |
| Horizontal layout on the spacing scale | `Inline` (`shared/ui/layout/inline.tsx`) | `gap`, `align`, `justify`, `wrap`, `as`; flex with no implicit constraints. |
| Vertical layout on the spacing scale | `Stack` (`shared/ui/layout/stack.tsx`) | Same props; adds `flex-col`. |
| An icon-only action | `IconButton` | Required `label` (its accessible name); `size="inline"` = 20px action inside a row or tab, `size="standard"` = 28px chrome action (Button `icon-sm` geometry). Defaults: raised hover, 120ms color motion, `type="button"`; `asChild` keeps link semantics. |
| Window chrome or a panel heading | `PanelHeader` | Required `size="window"` (40px, gap-1, px-2, `bg-bg1`) or `size="panel"` (36px, gap-2, px-3); border1 bottom divider; optional `div` / `section` / `header`. |
| A compact tool disclosure or hover trigger | `ListRow` | Width-fit button row; the caller owns `aria-expanded`, `aria-controls`, labels, state, and events. |
| Every workbench tab body | `WorkbenchTabFrame` + `WorkbenchTabToolbar` (`shell/workbench/tab-status.tsx`) | Structural single status slot under portalled toolbar rows; preserves confirmed content, otherwise supplies `WorkbenchEmptyState`. The exhaustive `WorkbenchTabType` adapter requires copy/icon for future tabs. |
| A tab's persistent read status | `useWorkbenchStatusSource` + `describeWorkbenchFailure` | Exact-owner primary/secondary errors and awaitable retries feed one `WorkbenchTabBanner`; availability has priority. Action outcomes remain toasts. |

- `Inline` / `Stack` accept only the gap steps `0`, `0.5`, `1`, `1.5`, `2`,
  `2.5`, `3`, `4`, `6`, `8`. Their `className` is for outer layout (sizing,
  shrinking, positioning), never visual styling or extra gap/alignment classes.
- Put repository navigation inside `Surface kind="sidebar"` and use
  `hover:bg-(--surface-hover)` for hover, selected, and focus-within fills; a
  standalone preview of a sidebar row needs the same Surface. Settings
  navigation keeps its own surface. Don't override a Surface's fill while its
  contextual tokens still describe another surface.
- New callers use the defaults. `IconButton` `hover="subtle"`, its
  `motion="colors" | "colors-hover" | "none"` options, window-header `h-9` /
  `gap-2` overrides, and `ListRow` `transition-colors` overrides exist only to
  keep migrated recipes identical; they are deprecated until the UI iteration
  unifies them.
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

Two other apps consume these tokens. The marketing site (`apps/marketing`)
clones 26 public tokens, generated from the same sources and guarded by
`apps/marketing/src/lib/__tests__/marketing-tokens.test.ts`; `apps/web` slices
`styles/zeros-tokens.css` at build time for the dashboard.

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
  the contrast contract.
  Hue changes to a status family need design approval. CSS declarations inside
  `@generated` markers are generated; imports, explanations, type/radius/weight
  wiring, native appearance hints, named utilities and base rules stay authored.
  `styles/tokens/zeros.resolver.json` defines the base set followed by the
  appearance modifier; CSS names and cascade order remain compatibility contracts.
- **Primitive change:** in `shared/ui/primitives/` with a test in
  `shared/ui/primitives/__tests__/`; keep the API compatible.
- **Paying debt:** fix the finding, then `pnpm check:ui --prune-debt`.
- Owner review (`.github/CODEOWNERS`): `styles/`, `shared/ui/`,
  `scripts/design-system/`, and the docs in this family.
