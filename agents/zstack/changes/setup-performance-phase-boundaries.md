Setup's pre-admission wait and later transport status probe share a command
but describe different intervals. An aggregate command duration also encloses
installer/helper work, so neither a later fast probe nor a timestamp residual
establishes polling or network cost.

Measure requests separately from retry sleeps using a local monotonic clock,
closed labels and bounded coalesced counters. Keep optional diagnostics outside
strict proofs and old wire/SQL formats. Test failed/cancelled stages, observer
failure, malformed input, unchanged request counts, and stale execution fences.
Encoded by `setup-performance.test.ts`, `boat-setup-runner.test.ts`,
`linux-setup-executor.test.ts` and `setup-worker.integration.test.ts`.

Guest observations need readers on every executing replica before producers:
the replica acknowledging a materials header may differ from the one awaiting
setup output. Keep proof bytes unchanged, put timers in a separately negotiated
envelope, and restrict each producer's groups. Retain old helper/base output,
stream bounds, proof equality and failure controls. Root observations cannot be
overwritten by inner timings. A cached install still hashes its tree and retires
and restarts its host; measure those calls before changing them. Encoded in the
guest performance, root launch, setup attestation/helper and bootstrap tests.

An imported helper must also reach every installed layout and namespace fixture.
The v4 bundle inventory included the performance helper, but the real Computer
projection fixture and legacy image recipes omitted it. Run the projection and
all cloud script suites before handoff; keep a staged import that succeeds after
the source checkout is removed. Encoded in the runtime-bundle closure, image
artifact and Computer projection tests.

A `cloud-*` suite selection excluded the Boat kit's exact recipe assertion.
Enumerate every recipe/template consumer, including `boat-image-kit.test.ts`,
instead of treating one filename glob as dependency coverage. When a helper is
added, require it explicitly in the install list and normalize only that exact
addition out of the historical recipe digest; retain the original digest.
