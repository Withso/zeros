# Engine renewal timing boundary

CP database spans cover server work, but cannot measure the VM's listener scan,
network transit, response parsing or registration-scope validation. Foreground
turn instrumentation also misses background heartbeat and actor/context work.

The registration now records four closed operations with a separate monotonic
clock and bounded per-operation/outcome histograms. Existing work flushes the
aggregate after an active minute; retirement flushes once and fences late
completions. Logging cannot alter an authority result and adds no timer, request
or policy deadline. Completed transport/registration checks are explicitly
separate from the caller's final cache/actor admission.

Regression coverage drives real renewal calls through success, refusal,
transient HTTP failure, concurrency, scope mismatch, shutdown and a throwing
logger. Invalid clock coverage is explicit. The helper stays in the existing
CP-allowlisted registration module, preserving that import closure without
adding a CI-definition exception. In the initial red fixture a consumed Fetch
Response was accidentally reused; each synthetic request now gets a fresh body,
and both the original and clean red evidence remain in the handoff.

Eval: `engine-renewal-timing-boundary`. There is no live latency, p99, idle egress
or active-workspace qualification claim from these synthetic tests.
