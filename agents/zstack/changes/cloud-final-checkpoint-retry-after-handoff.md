# Final checkpoint control after irreversible handoff

Heartbeats kept renewing while the record handoff flag suppressed every later
checkpoint directive. Separately, a cancelled capture left the original writer
sealed, and the admission fence rejected a replacement final checkpoint before
it could finish. A failed handoff flush also needed an explicit bounded retry.

Keep final control alive independently of ordinary record writes. Retain the
original writer, boot, registration and complete scope once sealing starts;
never resume NORMAL, claims or process admission from a cancelled final capture.
Recheck authority after awaited drains, reconcile the original cancellation,
and retry the same immutable seal and file pair. A preserved resident ticket
cannot be relabelled: explicit retirement needs a distinct drain ticket.

Real heartbeat delivery and WAL/FULL SQLite regressions cover both boundaries,
lost seal ACKs, failed flushes, exact cancellation reconciliation, concurrent
requests and foreign or expired authority. Existing real Host-group tests keep
reversible idle cancellation covered. Closed cancellation labels alone do not
establish the stop issuer or native replay failure predicate.

Encoded in cloud-runtime-registration.test.ts, cloud-idle-checkpoint-recovery.test.ts,
the bug-fix playbook and the cloud-final-checkpoint-retry-after-handoff eval.
