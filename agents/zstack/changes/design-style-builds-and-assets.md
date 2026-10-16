# Design style build lifecycle

- **Style-build teardown could disappear before archive retry.** Settled
  command promises and cache eviction were mistaken for process-stop proof.
  Keep unresolved boundary authority until the original proof succeeds, and
  test archive retries, settings replacement, idle stop and eviction
  (`design/__tests__/style-build-lifecycle.test.ts`). The same suite proves
  that failed one-shot builds retry on reopen, not on presence heartbeats.
  The real-process presence-expiry test arms its short lease after startup,
  so scheduler coverage does not assume a shell starts within 50 ms.
