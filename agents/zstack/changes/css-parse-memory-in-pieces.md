# Parsing a large stylesheet whole spiked the engine heap

- **Symptom.** Resolving a 30 MB Design style source raised the engine heap by
  1.3 GB and kept 120 MB after garbage collection.
- **Cause.** A postcss AST costs roughly forty times its CSS, and the first
  pruning index held per-rule objects and strings.
- **Rule.** Import large CSS in pieces cut after top-level statements, and keep
  only typed arrays with hashed names in long-lived indexes. Measure memory with
  a `--expose-gc` probe that reports the heap right after the work and what
  stays after collection, not only time.
- **Encoded in.** `apps/desktop/src/engine/design/style-prune.ts` and the
  "Imported style sources" section of `docs/design-mode-roadmap.md`
  (231 MB transient, 31 MB heap retained for the same source).
