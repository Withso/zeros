# Materialize the bounded SKIP LOCKED claim set

- **Symptom.** A lifecycle claim could return more workspaces than its limit,
  allowing a worker to exceed its concurrency bound.
- **Cause.** A limited `FOR UPDATE SKIP LOCKED` subquery inside an `UPDATE`
  could be evaluated again while that update changed row eligibility. A lease
  that expired immediately exposed the extra claims.
- **Rule.** Materialize the selected claim IDs before updating their leases.
  Apply exclusions before the limit, and test the returned count with a
  zero-duration lease so provider latency cannot hide an unbounded claim.
- **Encoded in.** `CloudV2Store.claimPending` uses `WITH claimed AS MATERIALIZED`.
  `apps/control-plane/src/cloud/store.integration.test.ts` covers expired
  leases, excluded in-flight workspaces and the claim limit; `lifecycle.test.ts`
  covers the four-step concurrency bound. Guidance is in
  `skills/zstack-verify/SKILL.md`.
