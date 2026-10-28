# Chat shortcuts retain a live keyboard target

- Symptom: Command+Left/Right selected a chat once, then stopped switching;
  the shortcut reference also showed Home and End as unexplained diagonal arrows.
- Cause: selection hid the focused composer before focus moved. The incoming
  composer respected the old editor's focus, then Chromium blurred the inert
  layer to body, outside the pane's keyboard listener. The browser smoke hid
  the failure by calling `focus()` before every shortcut.
- Rule: hand keyboard focus to the destination's persistent tab before hiding
  its old content. A same-pane focus event must not restore a stale selection
  while React is still committing consecutive navigation events. Single-tab
  panes retain their existing caret; deliberate keyboard focus stays in the
  strip. Spell out Home/End and show the Fn-arrow equivalents for compact Macs.
- Encoded in: `ui-smoke-workspace-shortcuts.mjs` presses consecutive keys without
  repairing focus, checks one selection per rapid key, preserves drafts, and
  exercises split panes, tab-strip focus, overlays and Local/cloud owner round
  trips. The existing app-sidebar scenario runs these checks in shard 2. Its cloud
  fixture returns seeded rows on subsequent reads so revalidation cannot erase
  its own test destinations. The browser checks the readable message-navigation
  chords and captures both themes.
- Runner lesson: trace scenario callers as well as the registry before adding
  an entry; a scenario can already run inside another scenario.
