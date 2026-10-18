# Observe durable settlement after handlers finish

Symptom: the queue concurrency integration test observed all twelve handlers
returning, then intermittently found durable rows that had not been deleted yet.

Cause: a handler increments its delivery counter before the runner commits
`completeJob`; handler completion is not queue settlement. Both the production
runner and the failing test were unchanged from main when CI exposed the race.

Rule: use the existing runner drain barrier before asserting durable deletion.
Reproduce the gap by holding a row lock after a handler returns, not by adding
a sleep or weakening the zero-row/delivery assertions. Keep the concurrency
barrier deterministic too.

Encoded in `job-queue.integration.test.ts`, which retains the original test name,
holds one completion with a transaction, and awaits `JobRunner.stop()` before
checking all twelve deliveries, zero in-flight work and zero durable rows. The
held-completion assertion failed with the old synchronization and passed with
the drain; no production queue or CI behavior changed. This is a test-observation
repair, not a production queue bug or a fixed-test replay claim.
