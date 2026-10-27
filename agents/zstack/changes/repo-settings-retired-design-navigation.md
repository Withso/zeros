# Retiring repository Design settings

- Symptom: removing the visible Design tabs alone would leave saved selections
  and Design-workbench links pointing at pages that no longer exist.
- Cause: the repository tab strip, per-repository mode memory, legacy Settings
  selection parser and workbench entry links own separate navigation paths.
- Rule: retire the destination at every UI caller; migrate its persisted value
  within the same owner before first paint. Retain shared caches and runtime
  lifecycle operations when another surface still uses them.
- Encoded in: `persist-ui-state.test.ts` (owner-specific fallback, malformed
  legacy state and bounded migration), `navigation-memory.test.ts`,
  `design-workbench-status.test.ts` and `scripts/ui-smoke-repo-settings.mjs`
  (Local/organization placements, reload and no Design operations from settings).
- Fixture lesson: cloud repository IDs come from the cloud catalog; the Local
  registry intentionally excludes cloud roots. Seed that catalog for reload
  coverage instead of assigning a fresh Local project ID on each load.
- CI caught an old accessible-label selector in the plain-folder browser smoke.
  Trace accessible names as well as imports when retiring a navigation mode;
  `scripts/ui-smoke-folder-workspace.mjs` retains the capability checks and now
  also asserts that plain-folder settings have no retired Design controls.
