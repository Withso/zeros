# Join independent access reads before cleanup

- Symptom: serial public access reads add their latencies before workspace setup
  can deliver a launch admission.
- Cause: the host-key and endpoint requests are independent after preparation,
  but sharing the transport with other callers makes an implicit overlap risky.
- Rule: opt in at the owning caller. Join and validate both reads before any
  access mutation, preserve the first failure, cancel the sibling and join it
  before channel disposal. Reject late successful replies after cancellation.
- Encoding: deferred-read tests cover both completion/failure orders, invalid
  access, preparation and cancellation barriers, a reused runner with a fresh
  channel, serial shared callers, lost SSH replies and unconfirmed revocation.
  Build mock delegates from an ordinary fixture: a queued one-shot result can
  otherwise masquerade as the general implementation and hide cleanup behavior.
