# Decide what a new column's NULL means for rows that predate it

- **Symptom.** After merge, Alpha's only Cloud Computer would never have
  refreshed its runtime automatically. Every create and wake would have kept
  downloading the 325 MB runtime.
- **Cause.** Migration 0204 added `cloud_v2_computer_builds.runtime_sha256`,
  and every existing build got NULL. The refresh eligibility test was
  `runtime_sha256 IS NOT NULL AND runtime_sha256 <> $pin`, so a build that
  predated the column never counted as stale. The tests only used builds
  created after the column existed.
- **Rule.** When a new nullable column feeds an eligibility predicate, decide
  what NULL means for legacy rows and test that row shape directly. Use
  `IS DISTINCT FROM` when "unknown" should count as "different".
- **Encoded in.** "refreshes the runtime of a live snapshot built before
  builds recorded their runtime" in
  `apps/control-plane/src/cloud/computer.integration.test.ts`.
