# Final seal: admission quiescence is not authority retirement

Stop closes admission while the confirmed writer is still needed to drain,
mirror and seal. A valid control reply arriving after that fence used the
admission getter to infer lost authority. Local AbortController cancellation
was also classified as an explicit CP rejection. Both paths invoked engine
retirement and stopped heartbeats before seal completion.

Retain the immutable ACK and discard valid late work after independently
validating current authority and the entire control scope. Give local
cancellation its own internal class; never hide an explicit rejection, bad
origin/identity or a retired registration behind cancellation. Reproduce the
race through real registration, control transport, boot and SQLite seal
boundaries, including a second heartbeat while checkpoint work is held.

The live stop6 timeline is consistent with this reproduced mechanism; without
an engine-side receipt it does not prove which branch ran on that fixture.
