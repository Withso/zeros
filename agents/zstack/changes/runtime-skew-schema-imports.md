# Capture schema imports in runtime skew checks

- Symptom: runtime qualification failed before either compatibility direction
  ran after a command schema moved unchanged into a dependency-only module.
- Cause: the source-capture harness searched only declarations in the command
  service. It could not capture the imported result schema or its dependencies.
- Rule: follow each selected named schema import through the same immutable
  source cohort. Keep the old strict contracts, unavailable-source refusal and
  incompatible-command control; a module move must not substitute new schemas
  for retained runtime definitions.
- Encoded in `scripts/runtime-skew/source.mjs` and the current/frozen import
  regressions in `scripts/__tests__/runtime-skew.test.ts`. Run this gate after
  moving schemas as well as after changing wire fields.
