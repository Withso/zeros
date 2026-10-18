# Cloud exit custody and independent checkpoint discovery

Symptom: a long uplink lease kept a dead engine's workspace ready, and an open
push socket hid a realtime-pool failure until final capture's deadline passed.

Cause: a durable lease was used as liveness evidence, and push availability was
treated as proof of checkpoint discovery. Runtime-transfer engines also use an
enrollment ID/sequence where setup engines use a setup ID/fence.

Rule: report only a positively observed original-child exit, fence its exact
setup or transfer enrollment, and preserve the existing lifecycle owner and
provider/data proof gates. Independent API freshness starts at request send;
pongs cannot extend it. Optional discovery must have both a time and an
outstanding-read bound. Failed signalling leaves exit reporting armed.
When a desktop client imported by control-plane contracts gains a protocol
dependency, include that file in the database CI classifier; its import-closure
test caught the newly shared lifecycle wire.
When integrating after the lifecycle-job migration, drive claim/run/complete in
the withdrawal probes; the removed polling driver cannot prove a Stop is queued
and dispatched by the deployed worker.

Encoded in zstack-review, engine-exit and runtime-transfer integration tests,
supervisor journal/custody tests, registration fake-clock tests and the isolated
API/realtime-pool checkpoint drill. The two replay cases retain the original
failure mechanisms without importing newly added product modules into the red
tree's tests.
