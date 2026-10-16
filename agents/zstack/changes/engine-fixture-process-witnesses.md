# Keep process fixtures scoped and wait for real workload readiness

Boot-factory construction and native-pump cleanup failed on unrelated CI changes.
Their shared portable fixture read strict native cgroup metadata for every host
process, although the fixture replaced that metadata with fake membership.
A retained denied-read regression reproduces both reported error stacks.
Read real births, groups and executable identities without that unused ambient
dependency; unreadable original births still refuse proof. Production native
custody and activity code remain unchanged.

Broader adjacency found another host-wide enumeration race. An eight-second
forced Node-exit probe captured a kernel-dead X task with parent 0 and
group/session -1, while its birth remained present. Ordinary exit churn did
not reproduce it. The portable reader now excludes only validated X tasks
before live numeric checks; a retained red reproduces the exact closed shape,
and malformed live identities still refuse proof. Existing post-stop sibling
checks use their existing complete-census wait instead of asserting against
an incomplete sample during real exit; the timeout and activity assertions stay.
The adjacent quiet-shell test also sampled immediately after startup output,
while the task could still be runnable. Its observed failure is retained; it
now waits for the actual complete idle proof using the suite's existing bound.

The resident owner-handoff failure was a separate startup assumption. A busy
Host wrapper can precede the shell and its real job. The test now holds the gap
with a FIFO, proves it is quiet, then waits for the real child's acknowledgement
before requiring activity across handoff. Releasing the filesystem gate avoids
recent-input activity masking the assertion. No sleep or timeout increase.

The ci-red playbook and the portable-custody-ambient-cgroups and
resident-workload-readiness evals retain both lessons. The CI reader discarded
its underlying errno; the exact ambient process from that run is not claimed.
The resident correction is a scenario eval: replay overlays its repaired test
onto the parent and would otherwise test the repaired assumption on both sides.
