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
   Tooltip, Kbd, Badge, Pill, PanelHeader, ListRow, …), the layout blocks
   in `shared/ui/layout/` (`Inline`, `Stack`, `Surface`) and `WorkbenchTabFrame`
   for every tab body. Missing a variant? Extend the primitive in `shared/ui/`
   with a test; never hand-build a `<button>`, `<input>`, `<select>` or
   `<textarea>` in feature code, and never restyle a primitive from a caller.
3. **Tokens only.** Color comes from token utilities (`bg-bg1`, `text-fg2`,
   `border-border1`, `text-red-text`, …). No hex/rgb/hsl, no Tailwind palette
   colors (they do not compile), no arbitrary values such as `text-[14px]`,
   `z-[1000]` or `rounded-[18px]`. Token values live in
   `styles/tokens/*.tokens.json`; the CSS token blocks are generated. Each
   status family (red, green, yellow, violet, and the accent blue) has four
   roles: `-text` for words and icons on any plain surface, `-bg` for a tinted
   container, `-on-bg` for text inside it, `-solid` for a fill with white
   text. A status word on a plain surface is never the `-on-bg` tint. Retired
   names (`muted-fg`, `sidebar-bg`, `bg2-highlight`, `*-primary`, `blue-*`, …)
   fail `check:ui` with their replacement.
4. **Surfaces decide hovers.** The ladder is `bg1`, `bg1-raised` (composer,
   cards, settings groups; never floats), `bg2`, `selected-bg`, then `bg3`
   for anything floating; the app sidebar is `nav-bg`. On `bg-bg1` hover with
   `hover:bg-bg1-hover`, on `bg-bg1-raised` with `hover:bg-bg1-raised-hover`,
   on `bg-bg2` with `hover:bg-bg2-hover`, in the sidebar with
   `hover:bg-nav-bg-hover`; inside a `Surface`, `hover:bg-(--surface-hover)`.
   Floating surfaces (menus, popovers, tooltips, hover cards, toasts) are
   `bg-bg3` + `border-border2`, 12px corners, the dropdown shadow, a 4px inset
   and 28px rows with 8px corners; only they use `bg-bg3`. A picker docked on
   the composer paints the same `bg3`. A tool group that floats over content
   (message actions, selection popovers, the code-block copy) is
   `Toolbar size="inline"`: 24px, 12px text, 14px icons. Pills take their
   fill from the ground (`--pill-*`, `PILL_GROUND`). Navigation
   selection (sidebar, trees, layers) is `bg-selected-bg` with `text-fg1`, a
   step above hover. A pressed toggle, the active tab or segment, and a chosen
   chip or option fill with `bg-selected-bg`; no selected, pressed, active or
   current state adds a border, ring, outline or shadow.
5. **Text tiers:** three, a visible step apart: `text-fg1` emphasis/selected,
   `text-fg2` default, `text-fg3` metadata, hints, times and placeholders
   (AA on every resting surface; a hovered or selected row lifts it to
   `text-fg2`). Never fake a tier with opacity (`text-fg2/60`). On a tinted
   `bg-<family>-bg`, text is `text-<family>-on-bg`.
6. **Scales:** text `text-3xxs` 12 · `text-xs` 13/18 · `text-sm` 14/20 for
   chrome, `text-reading` 14/22 for the chat's reading text; 10 and 11px
   (`text-xxs`, `text-2xxs`) only for counts, badges, Kbd and canvas chips.
   Dialog, popover and window titles are 14 semibold. Controls are 28
   standard, 24 compact or 20 inline, with 14, 12 and 12px glyphs; never mix
   heights in one row. Panel headers are 40 in every column. Radius
   `rounded-sm` 4 · `rounded-md` 6 · `rounded-lg` 8 (menu rows, toolbar
   tools) · `rounded-xl` 12 (floating surfaces, toolbars, dialogs, groups) ·
   `rounded-2xl` 18 (the composer family). Durations `duration-fast` 120
   (colour), `duration-base` 150 (overlays, slides, dialogs), `duration-slow`
   200; never a literal. Spacing steps 0–12 (half steps belong inside
   controls). Global layers `z-panel` · `z-chrome` · `z-dropdown` · `z-modal` ·
   `z-toast`; only `z-0`…`z-2` locally.
7. **States are the primitive's.** Hover, open, pressed (`aria-pressed`),
   keyboard focus (a 1px `accent` edge; fields show it only on keyboard
   focus, except Design inspector fields, which show it on any focus),
   disabled (50%; `aria-disabled` keeps the reason tooltip)
   and loading (`loading` on Button and SplitButton). Filled buttons hover at
   90% opacity. Every wait shows Stream-run (`ZerosSpinner`, `RunStream`);
   the Island Z weave is for app startup only. One choice in a menu is a
   check at the row's end, several a left check column; destructive rows are
   red and last; shortcuts are Kbd chips (or a Tooltip's `shortcut`), whose
   symbols are the Phosphor key glyphs.
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
