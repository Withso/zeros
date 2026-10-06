---
name: zeros-ui
description: "Zeros design system for renderer UI: use when building or changing UI under apps/desktop/src/renderer or styles/ — components, tokens, colors, spacing, typography, contrast, and the checks that gate them."
---

<!-- GENERATED from docs/design-system.md by scripts/design-system/build-design-docs.mjs. Edit the agent brief there, then run `pnpm design:docs`. -->

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
   use toasts. Report each read with `useWorkbenchStatusSource`; retain confirmed
   exact-key content and never add a second error paragraph or Retry button.
7. **Verify:** run `pnpm check:ui` (compiles every class, enforces the policy
   ratchet) plus `pnpm typecheck`, `pnpm lint`, and the nearby tests. Fix
   findings; never raise `styles/policy/ui-debt.json`, add a `check:ui ignore`
   comment, or loosen `styles/policy/contrast-contract.json` to get green.
   Token or contract changes: run `pnpm design:docs` and say so in the handoff.
