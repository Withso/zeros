# Current-boot proof and cleanup lifetimes

Symptom: while developing dormant build-mode admission, a cancelled short probe
could wait forever for its report decoder before retiring its original cgroup.
A separate process fixture showed why leaving descriptors open is insufficient:
an exiting root monitor releases its inherited setup/engine locks.

Cause: report completion and original cleanup custody shared a lifetime. A late
callback also remained able to acknowledge or stop an already-finished launch.

Rule: cancellation starts original cleanup independently of report I/O; fence
every late continuation before side effects. Unknown cleanup retains the owner,
locks and original descriptors until trusted retirement. Keep the original
deadline and check the current setup attempt at both publication and consumption.

Encoded in `cloud-workspace-engine-launcher.test.ts`,
`cloud-boot-custody-lifetime.test.ts`, `cloud-boot-retirement.test.ts`,
`cloud-boot-locks.test.ts` and `cloud-boot-admission.test.ts`. The seeded
`seeded-cloud-boot-current-attempt` eval removes the shared current-attempt fence
and must expose stale probe/consumer admission. This is a new-path development
regression and deliberate mutation, not a claim that the dormant code ran live.
