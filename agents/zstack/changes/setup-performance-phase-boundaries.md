Setup's pre-admission wait and later transport status probe share a command
but describe different intervals. An aggregate command duration also encloses
installer/helper work, so neither a later fast probe nor a timestamp residual
establishes polling or network cost.

Measure requests separately from retry sleeps using a local monotonic clock,
closed labels and bounded coalesced counters. Keep optional diagnostics outside
strict proofs and old wire/SQL formats. Test failed/cancelled stages, observer
failure, malformed input, unchanged request counts, and stale execution fences.
Encoded by `setup-performance.test.ts`, `boat-setup-runner.test.ts`,
`linux-setup-executor.test.ts` and `setup-worker.integration.test.ts`.
