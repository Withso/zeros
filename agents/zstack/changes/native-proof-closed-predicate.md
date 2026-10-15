# Preserve the native proof predicate

Symptom: a live infrastructure soak retained `detached_proof_incomplete`, but
the signed artifact could not distinguish refused PTY admission from replay,
row, heartbeat or file failure.

Cause: every validator branch used one closed code with no bounded predicate.
Stable boot/writer identity was insufficient to identify the failed boundary.

Rule: keep the public failure code and attach an allowlisted predicate before
cleanup; retain the first observation through later failures. Do not expose raw
terminal/provider text or infer a root cause from a missing legacy diagnostic.
After a pending request, check authority and cancellation first, then the
observer's latched failure before classifying its reply or seeding replay.
An earlier PTY exit must not be replaced by a later refusal, cwd or byte error.

Encoded in `native-proof-observation.ts`, real helper rejection/exit/replay
tests, infrastructure checkpoint ordering, signed artifact import/tamper tests,
and the `native-proof-closed-predicate` replay eval. The engine checkpoint
cancellation hypothesis is separate work; this diagnostic is not its fix.
