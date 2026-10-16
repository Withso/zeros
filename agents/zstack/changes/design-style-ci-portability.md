# Design style CI portability

- Symptom: the license bundle was current on macOS but stale on Linux.
  Cause: Sass added Parcel's host-native optional watcher to the production graph.
  Rule: normalize new native production dependencies to the shipped target and
  verify identical inventories with and without the host variant. Encoded in
  `scripts/__tests__/license-platforms.test.ts`; the installed watcher and wrapper
  carry identical MIT license documents.
- Symptom: the token preview's no-op write test failed only on Linux.
  Cause: the filesystem rounded the requested `utimes` value by a microsecond.
  Rule: compare the stored timestamp before and after the operation. Encoded in
  `scripts/__tests__/design-system-tokens.test.ts`.
- Symptom: macOS watcher tests passed their assertions but failed the job with
  an uncaught `EPIPE`. Cause: a Git child exited before consuming stdin.
  Rule: handle pipe errors while preserving the child's exit status and stderr;
  cover early successful and failed exits with input larger than the pipe buffer.
  Encoded in `apps/desktop/src/engine/git/__tests__/git-exec.test.ts`.
- Symptom: a clean CI checkout rejected a documented runtime folder that existed
  locally. Cause: the docs checker interpreted it as a checked-in source path.
  Rule: use an explicit workspace placeholder for generated runtime paths.
  Encoded in `docs/design-system.md` and verified by the unchanged `check:ui` gate.
