Separating ingress from the execution owner exposes two distinct lifetimes.
Keep one composed engine, ledger, writer and uplink. An ingress replacement
cannot initialize execution state, and loss of the actual owner still invokes
the supervisor's original exit withdrawal. Local placements never construct
the cloud child. Encode the distinction in production-composition tests and
an inventory of every readiness consumer, not a general engine-authority
exception. Credential/checkpoint and accepted-work authority stay independent.

A spawn callback can report exit synchronously, before its promise returns the
process handle. Install the starting flight before invoking the spawner, and
join the exact late handle's retirement before replacement. The retained
cloud-execution-coordinator regression observed three launches where only one
was owned; it now proves no replacement until the original handle and retirement
both settle. Unknown retirement remains unavailable.

A reversible idle/checkpoint/handoff fence can refuse replacement before any
Host scope is created. Distinguish that positively empty attempt from unknown
retirement: retry locally after admission resumes, without owner initialization
or readiness write churn. A real-process regression retains the original Host
registry's fence and resume proof; failed-launch controls require exact cleanup
before a retry is allowed.

Readiness received through two transports needs one exact-boot revision CAS.
Keep the original receipt timestamp across retries/resumes and bound a deadline
before lock waits. A stale status must not change the outer ready/phase fields
after its nested snapshot is rejected. Retained real PostgreSQL and WebSocket
tests cover delayed locks, source clock skew, foreign boots, old revisions and
API/realtime ordering while the owner's execution authority stays live.

Time can expire behind a writer lock or a grant INSERT even while identity is
locked. Check interactive readiness again at the final admission boundary;
real PostgreSQL regressions cover connect, endpoint grants and native services.
Do not filter a temporarily unavailable frontend out of capability issuance's
engine binding: that silently turns a bound token into an unbound one. Keep the
execution identity and deny new admission separately. SQL CHECK constraints
also need explicit false for a missing opt-in; NULL alone passes a CHECK.

Creating two private listeners adds a partial-start cleanup obligation. The
retained bind-failure test verifies the first socket closes when the second
fails, and preserves the occupied path. Real-process portable-custody tests
cover UID/mode, exact environment names, loopback classification, parent-pipe
loss and bounded control input. They do not qualify kernel custody or a Boat
runtime. These findings occurred before activation and remain regression tests,
not escaped-bug replay cases.
