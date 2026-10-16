# Reconciled changes must reach content subscribers

- **Symptom.** Polling detected a new input file for Files/Changes but left a
  one-shot Design style build stale.
- **Cause.** The shared listener was called only from native watcher events;
  reconciliation re-added paths with `ignoreInitial` and never forwarded them.
- **Rule.** When a consumer starts using shared watcher events, test the
  fallback producer with native events held absent. Verify both invalidation
  and the consumer's exact-owner callback for additions and deletions.
- **Encoded in.** `apps/desktop/src/engine/git/__tests__/watch.test.ts`
  (`forwards polling-only additions and deletions...`), using the controlled
  polling tree and fake clock.
