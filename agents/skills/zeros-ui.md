## Agent brief: UI work in Zeros

Use the current shared primitives, token sources, and the checked-in frames in
`Zeros - Design/` to verify the existing behavior before changing it.

1. **Follow the existing direction.** Use one title and at most one line of
   description, in sentence case. Group rows in cards without nesting boxes;
   use one banner, message row or empty state per surface. Keep row heights
   consistent, use color only for meaning, and show keyboard focus on keyboard input.
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
   13/18 · `text-sm` 14/20, and `text-reading` 14/22 for the chat's reading
   text only. Controls are 28 standard, 24 compact or 20 inline
   (IconButton), with 14, 12 and 12px glyphs; never mix heights in one row.
   Radius `rounded-sm` 4 (inline controls, pills, badges, kbd, checkboxes) ·
   `rounded-md` 6 (buttons, fields, tabs, tooltips, tools) · `rounded-lg` 8
   (menu rows, code blocks) · 12 derived (floating surfaces, dialogs, cards) ·
   10 derived (toolbars). Spacing steps 0–12 (half steps belong inside
   controls). Global layers `z-panel` · `z-chrome` · `z-dropdown` · `z-modal` ·
   `z-toast`; only `z-0`…`z-2` locally.
7. **States are the primitive's.** Hover, open, pressed (`aria-pressed`),
   keyboard focus (a 1px `accent` edge; fields show it only on keyboard
   focus), disabled (50%; `aria-disabled` keeps the reason tooltip)
   and loading (`loading` on Button and SplitButton). One choice in a menu is
   a check at the row's end, several a left check column; destructive rows
   are red and last; shortcuts are Kbd chips.
8. **Never** use `dark:` variants, `transition-all`, stock shadows such as
   `shadow-lg`, or a color as the only signal. Don't build class names at
   runtime (`text-${tone}`): map states to complete class strings. Persistent
   workbench failures use `WorkbenchTabFrame`'s one 32px banner; action
   outcomes use toasts; cloud lifecycle and connection messages never enter
   the banner.
9. **Verify:** run `pnpm check:ui` (compiles every class, enforces the policy
   ratchet) plus `pnpm typecheck`, `pnpm lint`, and the nearby tests. Fix
   findings; never raise `styles/policy/ui-debt.json`, add a `check:ui ignore`
   comment, or loosen `styles/policy/contrast-contract.json` to get green.
   Token or contract changes: run `pnpm design:docs`. Interaction, overlay,
   focus or popover work also runs `pnpm test:ui-smoke` and `pnpm build:ui`.
   For state, navigation, tabs, or lists, verify exact-key reuse and inert hidden surfaces
   from the current implementation and tests. Check both themes.
10. **Local and cloud.** Verify the affected owners and placements with the
    zeros-workspaces skill. If a visual decision changes, update its owning
    primitive or token and add a check; do not duplicate the decision in prose.
