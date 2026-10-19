Lifecycle transaction batching reduced database trips, but a running provider
result could skip the full runtime-pin recheck after inspection. Retain that
check for no-dispatch results, and repeat the complete DB-only admission after
a real 40P01/40001 rollback. The reconciler regressions and
`cloud-running-observation-runtime-revocation` eval retain both boundaries.

A clock in a SELECT FOR UPDATE target list can be evaluated before its row-lock
wait. The real-PG control holds that exact lock until provider expiry; the
naively combined query accepts the expired observation. Evaluate the clock
outside a materialized locked-row read, and retain the original allocation
deadline after all funding awaits. The compute-lease regressions retain the
expiry, committed reservation and no-client-held-over-provider-I/O controls.

Measure complete passes as well as the optimized region. The allocation-owner
lookup before provider find is a separate required read; omitting it from the
initial checkout budget would report a false cost failure. Test receipts count
actual query-port work and local wall time without claiming database CPU or
live-network latency.
