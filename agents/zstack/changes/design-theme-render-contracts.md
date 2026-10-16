# Check theme behavior in the rendered consumers

- **Symptom.** A declared theme reset after selection, nested root dark rules
  stayed light, and API screenshots disagreed with the canvas default.
- **Cause.** Selection validation used a smaller catalog than the picker;
  nested media scoping required a root ancestor; only the native verification
  path applied the named default.
- **Rule.** Test catalog-only selections through the real picker, CSS scoping
  with computed browser styles on both root and descendant selectors, and
  default/explicit theme behavior across shared capture entry points.
- **Encoded in.** `scripts/ui-smoke-design-workspace.mjs`
  (`runDesignCatalogThemesSmoke`) and
  `apps/desktop/src/engine/design/__tests__/theme-rendering.test.ts`.
