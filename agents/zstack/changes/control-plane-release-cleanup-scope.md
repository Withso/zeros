Aggregate cleanup health was also the CP release gate, so a failed deletion or
detached-object cleanup could prevent deploying its repair. A narrow Boat
receipt exception did not cover those unrelated cleanup failures.

The CP now measures its own readiness alongside full operational health in one
query and consistent snapshot. Cleanup remains an alert; stalled non-delete
lifecycle work, failed rotation, authority, durability and billing signals still
block. Unknown reasons fail closed. The old Boat label keeps its exact proof,
the v1 release receipt shape stays compatible, and qualification remains an
independent check. No resource is retired or marked deleted by reading health.

Real-Postgres regressions retain full health and deletion/accounting evidence,
distinguish mixed lifecycle and rotation signals, and cover cleanup with a
critical lease. Route regressions cover every excluded reason, critical and
unknown reasons, posture, qualification and an authoritative negative projection.
The CI-red playbook and `control-plane-release-cleanup-scope` eval retain this
release-gate review pattern.

The root Vitest include list does not select release tests even when their path
is passed beside selected root tests. Receipt compatibility therefore runs with
`scripts/release/vitest.config.ts`; compare expected and reported file counts
before treating a green command as complete coverage.
