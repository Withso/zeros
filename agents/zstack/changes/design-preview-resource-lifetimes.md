# Keep optional rendering work and preview resources bounded

- **Symptom.** There was no opt-in latest-in-flight mode for background captures;
  reset admitted another producer while the old callback was outstanding, and
  a retired pause/idle callback could start a new owner's work. Runtime-tree
  eviction also removed cheap preview pixels despite unused byte capacity.
- **Cause.** Queue retirement only handled waiting tasks and reset logical
  counters before producers settled. Pixels shared the short runtime-history
  lifetime rather than their own byte/count/lease budget.
- **Rule.** Settle opted-in obsolete callers without releasing the producer slot
  early; preserve legacy running and queued work against opted-in background
  requests, including different-family capacity eviction, because explicit
  PNG export shares the queue.
  Fence pause and idle callbacks by lifetime. Keep preview entry/encoded/decoded
  budgets explicit, charge pinned replacement overlap, and retire owned bitmaps
  only after the final lease. Treat decoded/GPU costs as estimates and verify
  real renderer resources before claiming end-to-end support.
- **Encoded in.** `design-background-work-lifecycle.test.ts`,
  `design-preview-cache.test.ts`, `design-frame-spatial-index.test.ts`, and
  `docs/design-render-primitives.md`; eval case `design-background-work-lifetime`.
  Spatial buffers, PNG/cache stress fixtures
  and callback bounds are not rendered 10k workspace acceptance. Existing reset
  is a test workflow; its API failures are not a diagnosed navigation regression.
