# Checkpoint diagnostics preserve the operation they observe

- Symptom: a checkpoint delivery committed, but the evidence could not distinguish engine receipt from a stalled drain or seal.
- Cause: the heartbeat and response are strict compatibility contracts; adding a field would reject a released peer. Reusing the ordinary ingress budget for optional reports can throttle the seal itself.
- Rule: add a separate best-effort closed endpoint with its own rate budget. Keep exact current engine/request authority and the original deadline; diagnostic completion never supplies checkpoint custody.
- Coverage: retained route and ingress-budget reds, old-service/heartbeat compatibility, real PostgreSQL cancellation, expiry, replay and immutable first-failure tests. A further retained red caught UUID case aliases dividing one request's audit history; canonical UUIDs now own the 64-receipt cap. No tokens, text or content enter audit subjects.
- Evidence limit: engine source races and CP delivery records do not establish which branch ran in a past live incident. A diagnostic report is an authenticated observation, never authority or proof of a seal.
- Encoded in the bug-fix playbook and eval `checkpoint-progress-isolated-evidence`.
- The replay selects the existing app ingress regression. The parent has no new checkpoint-progress module, so importing its new suites would produce an unverified import failure instead of exercising the old ingress budget. The full current-source contract and PostgreSQL suites remain part of adjacent verification.
