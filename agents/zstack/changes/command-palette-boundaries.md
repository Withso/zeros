# Command palette discovery and activation

- A nested workspace's chats appeared under its parent's owner. The shared
  first-prefix resolver does not select the most specific workspace. Resolve
  ownership across the complete catalog before filtering to the selected owner.
  Encoded in `shell/__tests__/command-palette-model.test.ts`.
- Enter on a category button ran cmdk's highlighted result. cmdk receives key
  events bubbling from controls inside its root. Keep control activation out of
  result activation, and exercise keyboard activation in the real browser.
  Encoded in `scripts/ui-smoke-command-palette.mjs`, run by dialog-chrome smoke.
- File search found a literal filename, but filling the fixed Files home trimmed
  its leading space. Testing the action builder alone missed the reducer that
  changed the identity. Preserve filesystem paths through the complete dispatch
  and persistence path; normalize freeform input at its own boundary. Encoded in
  `state/__tests__/workbench-reducers.test.ts` and the command-palette smoke.
- cmdk trims item values: raw filesystem IDs made `same.ts` and `same.ts `
  share a selected value, so arrow navigation could open the wrong file.
  Encode dynamic identity parts independently from their literal targets.
  Keep the real-browser assertion that both rows render, exactly one is
  selected, and ArrowDown/Enter opens the trailing-space filename.
- Palette reads and actions outlive their originating view unless explicitly
  scoped. Mount discovery only while open, fence account/owner/folder changes,
  retain exact-folder files during refresh errors, and use passive cloud catalog
  reads. The browser smoke covers owner A → B → A, deferred files, history-only
  actions and stopped → ready → stopped cloud capabilities without a wake.
