# Qualify replay inputs before counting catches

Historical replay is an experiment over two source revisions and their actual
dependency graphs. A current checkout's lockfile or an import failure proves
neither side. Install a missing graph outside the checkout, reuse it by immutable
inputs, bind workspace packages to each projection, and keep prerequisite failures
unverified. A leased cache entry cannot be evicted while a test is using it.

Partial clones need their promised objects before local batch reads. Hundreds of
lazy fetches can fail during negotiation through stale commit-graph entries;
prefetch object IDs in bounded refetch batches without moving refs. Canonicalize
scratch roots before applying no-follow source checks, including macOS-style
symlinked temporary paths.

Scope newer Git options to object replay, not the shared workspace verifier.
Lease cleanup must never wait behind installation or replace a completed replay's
result; release only the owned lease and let dead-PID cleanup reclaim leftovers.

Before retiring scratch dependencies, inspect active checkouts' nested package
and `.bin` symlinks as well as process cwd, PATH and open files. A real
`node_modules` directory can still depend on another worktree. Preserve receipts
and refs, remove worktrees through Git, and measure actual free bytes: shared
storage means a large `du` count may reclaim little space.

Held by the zstack-source and zstack-replay suites and the
zstack-replay-historical-dependencies, zstack-replay-promisor-prefetch and
zstack-replay-canonical-scratch evals. Operational bounds are in tools.md.
