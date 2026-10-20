# Wake existing lifecycle work after owner discard

An accepted Delete remained queued after its exact owner-loss receipt committed.
The blocked lifecycle job had already completed, while recovery scheduling sent
the discarded row to a final-save job at infinity. Direct reconciler tests
proved dispatch authority and erasure but bypassed durable queue discovery.

Drain the earlier blocked job, commit the actual repair, and observe the real
JobRunner claim, fenced handler and completion. Also migrate an already committed
receipt with no job. Enqueue hints transactionally and backfill only current,
active exact receipts without changing source facts, retry clocks or leases.
Cover rollback, dedupe, a running job, a future retry, a terminal failure and a
new legal hold. Scheduling never supplies save or provider-deletion proof.

Encoded in the three owner-discard lifecycle integration suites, migration
0179 and its exact expansion guard, the bug-fix playbook, and the
`discarded-final-save-lifecycle-wake` seeded eval. Local Personal and
organization-local paths do not use these control-plane tables.
