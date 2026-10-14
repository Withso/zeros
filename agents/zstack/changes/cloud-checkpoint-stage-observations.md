# Observe the checkpoint gate without becoming part of it

A CP delivery transaction proves that a directive was returned, not that the
engine received it or reached a particular drain, mirror or seal gate. Record
the engine's finite stage changes before awaiting each gate. A held real stage
must leave a closed observation while the original lifecycle continues.

Keep the optional transport separate from strict heartbeat schemas. Use the
existing exact engine authority and fixed same-origin route, a one-second
request cap within the original checkpoint deadline, a bounded sequence and
coalesced pending stages. Abort an obsolete running report to prioritize the
immutable first failure before cancellation or cleanup. A timeout stops this
reporter; it never retries or changes engine authority. An old CP's 404 disables
only diagnostics. Completed reports are not checkpoint or custody proof.

Retained regressions hold real setup and record-flush gates, prove Local engines
send nothing, preserve the seal's existing deadline and acknowledged result,
and fence stale observations and late replies without logging raw errors.
The early idle-refusal guard also needs its observation before cancellation:
an outer promise catch runs too late once the CP has retired the request.
