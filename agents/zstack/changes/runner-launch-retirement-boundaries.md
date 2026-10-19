# Runner launch and retirement boundaries

Symptom: review of a dormant runner contract found that Stop could arrive after
durable reservation but before the queued native submission, while a queued
launch was briefly absent from its busy state. Native unit liveness also
reported execution running before its private handoff ACK.

Cause: the first authority/busy checks preceded a promise boundary, and unit
liveness was treated as proof of completed execution admission.

Rule: count pending launch work synchronously, recheck authority at native
submission and distinguish a live unit from an acknowledged private handoff.
Once native submission has been attempted, an error is not proof of absence:
keep original custody until positive retirement, without replaying the start.

A second review probe showed receipt corruption could prevent native Stop.
Always attempt exact native retirement despite persistence failure; a failed
final receipt still remains busy. Keep captured material until original
retirement, including material acquired after cancellation.
Opening a substituted FIFO can block before descriptor validation. Use
nonblocking opens and bounded descriptor reads; the retained subprocess probe
proves it reaches retirement with the FIFO present, then requires native
cleanup to finish with a closed journal error.

A quiet census without an owner or freshness key could describe another boot.
Require exact owner/workspace/writer/kernel identity, a fresh challenge and the
current registry revision. This runner check adds a veto; it never replaces
the complete Host census or root drain for escaped descendants.

Encoded by retained regression assertions in `cloud-runner-lifecycle.test.ts`,
including the journal-corruption, queued/reserved start, handoff, late capture
and keyed-census cases. These were found before activation, not escaped bugs;
no replay case claims production or real systemd qualification. The native
backend and shared resource/census/drain integration remain activation gates.
