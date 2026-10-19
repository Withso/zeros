# Current-boot proof and cleanup lifetimes

Symptom: while developing dormant build-mode admission, a cancelled short probe
could wait forever for its report decoder before retiring its original cgroup.
A separate process fixture showed why leaving descriptors open is insufficient:
an exiting root monitor releases its inherited setup/engine locks.

Cause: report completion and original cleanup custody shared a lifetime. A late
callback also remained able to acknowledge or stop an already-finished launch.
Independent review then found an uncovered lifetime: preparation failure and
final cleanup awaited retirement outside the signal guards. TERM could release
both inherited locks before any retirement receipt; one-shot guards also failed
on repeated cancellation.

Rule: cancellation starts original cleanup independently of report I/O; fence
every late continuation before side effects. Unknown cleanup retains the owner,
locks and original descriptors until trusted retirement. Keep the original
deadline and check the current setup attempt at both publication and consumption.
Install persistent boot cancellation guards before preparation and retain them
through all pending cleanup. Keep the root process alive while retirement is
pending; withdraw proof without restarting the cancellation deadline. Remove
guards only after positive retirement or refusal before custody was acquired.
Unknown cleanup keeps them inert alongside the retained original owner.

Encoded in `cloud-workspace-engine-launcher.test.ts`,
`cloud-boot-custody-lifetime.test.ts`, `cloud-boot-retirement.test.ts`,
`cloud-boot-retirement-signal.test.ts`, `cloud-boot-locks.test.ts` and
`cloud-boot-admission.test.ts`. The real-process signal regression holds
retirement at explicit barriers after preparation failure, final cleanup and
probe exit, with repeated TERM/INT and positive-retirement controls. The seeded
`seeded-cloud-boot-retirement-signals` eval replaces persistent guards with
one-shot listeners. Permission checks run with capabilities dropped and
no-new-privs: a non-root euid alone is not CI-equivalent when DAC capabilities
remain effective. The seeded
`seeded-cloud-boot-current-attempt` eval removes the shared current-attempt fence
and must expose stale probe/consumer admission. This is a new-path development
regression and deliberate mutation, not a claim that the dormant code ran live.
