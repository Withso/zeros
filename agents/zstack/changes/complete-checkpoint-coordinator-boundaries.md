Symptom: a new background-save coordinator could report a recent acknowledgement
for an old data cut, lose retry state after slow terminal journaling, or begin
work early when a persisted due time exceeded one timer's range.

Cause: upload completion, durable journal completion and timer wakeup are
different boundaries from cut freshness, positive retirement and due admission.
They also remain distinct across restart and wall-clock rollback.

Rule: keep the original attempt and deadline through journal/retirement I/O,
persist failed-attempt backoff before a successor, recheck a bounded timer's due
condition, and report age from the verified cut with a monotonic floor. A clean
workspace needs no scheduling timer; dirty ineligible work can still require a
bounded operator alert. Unknown custody never becomes a retired failure.

Encoded in cloud-complete-checkpoint-coordinator.test.ts: delayed journal writes,
two coordinators sharing a CAS revision, persisted unknown custody, restart,
cut-versus-ACK age, clock rollback, post-cut changes and separate final admission.
Final pause also verifies prior custody before the first heartbeat, rechecks the
source after I/O, and refuses a timed-out initial journal read or a malformed
complete-mode selector. Observed age floors are keyed to the original receipt.
Overlapping final callers keep separate pause holds; a resume cannot consume a
hold that is still joining admitted background work.
These are dormant orchestration controls; a mocked producer is not proof of an
all-writer cut, complete storage or native recovery. Those remain implementation
and qualification gates before enrollment.
