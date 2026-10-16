# Floor the delay in full-jitter retry loops

The uplink presence writer retried a failed durable write after
`random() * cap` milliseconds. A test pinned `random()` to zero and the
suite hung: the write rejected synchronously, the zero-delay retry
re-entered the pump through promise callbacks, and the microtask chain
starved the event loop so no timer ever fired. Full jitter can always
draw zero, so any retry whose failure can arrive without yielding needs
a minimum delay. The fix floors the delay at 100 ms and a retained
regression (zero draw, rejecting store, one settle window) proves the
queue waits instead of spinning. When reviewing a jittered retry, check
the lowest possible delay against the fastest possible failure, not the
average case.
