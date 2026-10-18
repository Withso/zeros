# Finite provider-session proof

Symptom: the provider adapter discarded session user/expiry, and an expiry-less
session-created webhook cleared an existing finite deadline. Those projections
could not support independently bounded cloud work.

Cause: ordinary access-token authentication did not require positive provider
expiry, and an omitted webhook field was treated as a replacement value.

Rule: separate positive enrollment evidence from continuation authority. Retain
exact provider identity and finite expiry; anchor short caches at observation
start, bound and cancel I/O outside DB locks, then recheck source/account state.
Use an exact source/version/deadline job and atomic revocation publication.
Omitted fields cannot erase proof, late results cannot revive terminal sources,
and repeated observations must not accumulate unclaimed expiry jobs.

Independent review caught a second bound: cancelling a waiter decremented its
counter but retained its Promise callbacks until the shared lookup settled.
Use one completion reaction and a removable bounded waiter set. Cancellation
churn must not grow retained callbacks while another caller keeps I/O alive.

Integration found that the real 5 s provider deadline raced Vitest's default
5 s test budget. Keep the production bound unchanged; await actual lookup entry
and advance only its timer to prove the 4,999 ms / 5,000 ms boundary while DB I/O
and the runner retain real time. A broader suite timeout must not hide this race.

Encoded in the real adapter/webhook regressions, source-proof race and queue
integration tests, request-cancellation tests, and the provider-session-proof
replay case. No recurring provider polling or detached activation is introduced.
