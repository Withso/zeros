# Start an inline edit from a menu only after the menu has closed

**Symptom.** Choosing Rename… from a theme row's ⋯ with the keyboard (Enter
on the trigger, Enter on the item) left focus on the page body. The rename
field rendered but never took focus, so typing went nowhere; a pointer click
happened to work.

**Cause.** The item's `onSelect` mounted the field with `autoFocus` in the
same commit that closed the Radix menu. The menu's focus scope was still
trapped then and pulled focus back to its content; when the content
unmounted, focus fell to the body. A keyboard close also refocuses the
trigger, which would blur a field that did get focus.

**Rule.** When a menu item opens an inline field (rename, a draft row), record
the choice in `onSelect` and start the edit in the menu content's
`onCloseAutoFocus`: call `event.preventDefault()`, then mount the field. Test
the keyboard path, not only the click, and assert the field is focused.

A composed trigger also takes the outer primitive's state attribute. In
`<Tooltip><PopoverTrigger asChild>`, PopoverTrigger spreads the Tooltip's
`data-state` over its own, so the trigger reads `closed` while its popover is
open and a `data-[state=open]:` fill never shows. Key an open fill off
`aria-expanded`, which only the popover sets (`workspace-identity.tsx`; the
workspace-header smoke measures the open fill).

**Encoded in.** `VariableActions` in
`features/design-workspace/design-theme-editor.tsx`;
`scripts/ui-smoke-design-theme-variables.mjs` asserts the rename field is
focused after a keyboard choice. Target: `agents/zstack/gotchas.md`.
