# Retire the reads and saved state behind a removed Design control

- Symptom: the Source toggle owned a document read even while closed, and its
  saved page flag also disabled canvas previews. Removing the icon alone would
  leave both behaviors behind.
- Cause: the surface spanned the toolbar, overlay, preview gates, page-memory
  projection and an otherwise unused source-warming helper.
- Rule: trace a removed control through its reads and persisted state. Ignore
  retired fields during normalization while preserving the existing storage key
  and the user's remaining navigation.
- Encoded in the legacy flat/per-page state check in
  `design-workspace-ui.test.ts`, the existing page/owner restoration suites,
  and the updated Design canvas browser smoke assertion.

The visual-check fixture also confirmed that Playwright init scripts run inside
sandboxed Design frames. Seed app localStorage only in the top-level window;
otherwise the fixture itself raises a sandbox storage error.

Root typechecks passed after installing only the workspace graph, but the full
UI smoke runner later imports `hono` from the control-plane graph. Use
`node scripts/dev-environment/dependencies.mjs --install` to prepare every
locked dependency graph before starting the browser matrix in a fresh checkout.
