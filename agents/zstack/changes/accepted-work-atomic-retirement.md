Accepted-work enrollment initially left a pending actor hold when the capability
device disagreed with the reserved actor. Stop also paused the queue without
closing its distinct accepted principal. Own reservation cleanup before checking
its binding, and retire exact accepted work in the queue's durable transaction.
Publish aborts and actor-hold changes only after the outer transaction commits;
a failed Stop must preserve live work. A canceled enrollment still counts toward
the I/O bound until its underlying request settles.

Encoded in cloud-accepted-work.test.ts with mismatched-device, late enrollment,
Stop/remove, rollback and canceled-flight cases. Real PostgreSQL tests hold row
locks until observed contention and verify source revocation, original expiry,
flag rollback and signing-key ordering. These were found before activation, so
they are retained regressions rather than escaped-bug replay cases.

The final signing-key lock also aged an already-checked actor past its deadline.
Acquire that fence before clock-bound facts and new-actor confirmation. The
PostgreSQL regression observes the blocked enrollment, expires its actor while
holding the key lock, and verifies that releasing the lock cannot accept work.

The receipt INSERT can wait after actor confirmation too. Recheck the current
actor after the write and before new acceptance commits. Two real PostgreSQL
regressions hold a table SHARE lock, observe the blocked INSERT and the database
clock passing either actor session expiry or its 30-second renewal cutoff, then
require rollback with no receipt. Moving one earlier lock was not a substitute
for a final admission check after all writes.

The new security-definer fence also needs positively true system context. A
fresh connection yields NULL for an unset context, which `IF NOT` does not
reject. Test a fresh connection as well as an explicit user transaction; the
guard now uses `IS NOT TRUE`.

The populated-schema replay also compared old full rows with newly expanded
rows. Assert that the additive runtime opt-in is NULL, then compare every
pre-existing field; retain both compatibility checks in the migration test.
