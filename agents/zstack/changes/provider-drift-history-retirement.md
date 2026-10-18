# Cold drift must retire the predecessor before wake

- Symptom: an automatically resumed cloud workspace registers successive engines
  that all fail history recovery.
- Cause: provider drift revokes engine access without committing boot-source
  retirement, while setup retries the resulting explicit recovery denial.
- Rule: exercise the real drift-to-start path with an active unsealed writer;
  require confirmed lifecycle retirement before resume. Keep authorization
  failures terminal and transient transport failures retryable.
- Encoded in `reconciler.integration.test.ts`, `linux-setup-executor.test.ts`
  and `agent-history-recovery.integration.test.ts`: stop prerequisites precede
  resume, stale bindings cannot publish drift, explicit denial stops retries,
  and a retired unsealed source recovers only through authenticated custody.

- Retry lesson: an uninterrupted worker chain does not prove recovery through
  the owner API. A fresh idempotency key after terminal drain failure must keep
  the retirement prerequisite, including without a committed checkpoint.
  `wake-source-retirement.integration.test.ts` covers the real route, queued
  requests, held provider observations and a direct older-worker SQL claim.
  A compatibility fixture sharing the new provider loop cannot prove that last
  boundary; test the old claim independently.
- Cancellation lesson: a capture acknowledgement cannot erase a mandatory
  safety stop. Both engine cancellation and warm owner wakes retain one drain
  and its original deadline. The compute regressions exercise current and
  previous lifecycle writers, followed by same-intent unsealed escalation.
  Include an expired capture written by an older worker and a settled failed
  drain from before the current engine: the former must make progress, while
  the latter must not revoke a healthy successor on a warm no-op wake.
- Stale-authority lesson: rejecting one held observation is insufficient if
  its intent is requeued and adopts the replacement authority on its next claim.
  Supersede the still-owned stale intent and leave newer setup untouched. Run
  `automatic-recovery.integration.test.ts` with the wake and reconciler suites;
  its retained two-pass probe catches the later cancellation as well as the
  existing first-pass stale-epoch regression.
