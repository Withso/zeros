# Give long-held lock connections their own pool

- **Symptom.** During a Cloud Computer runtime refresh on Alpha, every
  lifecycle poll and the build itself failed with `database_acquire_timeout`
  for about 30 seconds. The build counted as a failure for the new pin, so its
  retry was pushed back six hours.
- **Cause.** Cloud v2 runs on the two-connection worker pool. That pool allows
  one long-held lock holder, which still runs its queries on the second slot.
  A build held its advisory lock on one connection for the whole run. A
  cleanup running beside it, for an orphaned build, took the second one. Each
  then needed a third connection for its queries, so everything waited until
  its acquire deadline.
- **Rule.** Take connections held for a whole operation from a dedicated pool
  sized to the number of concurrent holders, and keep queries on the shared
  pool. Test with every holder active at once on production-sized pools.
- **Encoded in.** "keeps the worker pool's query slots free while a build and
  a cleanup each hold their lock" in
  `apps/control-plane/src/cloud/computer.integration.test.ts`.
