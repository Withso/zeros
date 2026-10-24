# Added columns still need the complete migration ladder tests

- **Symptom.** The cloud suites and migration static gates passed, but adding
  retention columns broke an older preservation case in `src/migrations.test.ts`.
- **Cause.** The case captured a whole `SELECT *` workspace row, applied all
  later migrations, and compared it with the expanded row. New columns changed
  the row shape without changing any value the assertion meant to protect.
- **Rule.** When adding columns to an existing table, run the control plane's
  `src/migrations.test.ts` alongside the feature suites and migration gates.
  Compare preservation over the original columns and assert new-column defaults
  separately; do not weaken the check on existing data.
- **Encoded in.** The pre-existing-column projection in
  `apps/control-plane/src/migrations.test.ts`, in “preserves existing tickets
  and scopes sign-out to the exact creator session”. Guidance is in
  `skills/zstack-verify/SKILL.md`.
