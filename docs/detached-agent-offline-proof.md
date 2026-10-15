# Detached agent observation validation

`scripts/zeros-dev/detached-agent-proof.ts` checks the consistency of a bounded
JSON observation document. It performs no I/O, opens no runtime, issues no
commands and signs nothing. Its output always says `qualification:
not_performed`, `authority: not_verified` and `nativeDispatches: null`. A parsed
report cannot authorize work or satisfy infrastructure, hourly or Gate 0.

The input uses the existing public boot binding, command and event schemas.
`before` contains the actual activated boot/funding/authority binding, runtime
execution identity, accepting command snapshot and bounded event snapshot.
`after` contains the reconnected binding, exact command read and event snapshot.
The snapshot object is an explicit observation subset, not a new RPC wire.
Replay requests retain the original stream and cover its contiguous sequence
through the after-snapshot cursor. Later events in the final page do not extend
that coverage. Missing/truncated replay or a second relevant terminal refuses
the check.

The accepting command must be dispatching the selected turn, with no pending
permission or question. Success requires that command's completed native
terminal, matching turn/execution/provider, matching final snapshot and real
completion event. Native start/end observations must agree and show the turn
ending more than 30 minutes after detach. A 32-row, nonce/run/program-bound
task witness is additional evidence; it cannot replace native completion.

Every baseline row retains its identity and relative order. User rows, settled
prefix rows and settled tools retain their exact payload digest. Identified
pending tools/results and current-turn text/thinking may update while keeping
their original row and known native identities. Unknown row kinds receive no
blanket mutation exemption. This checks bounded task observations, never full
chat completeness. Inputs are capped at 4 MiB, 200 rows per snapshot, 512 KiB
per row, 64 replay pages of 128 events, and a 16 KiB task witness.

Launch token timestamps are observations only. The checker requires 120 seconds
of launch headroom, more than 3 seconds remaining at disconnect, expiry before
reconnect, and an independently recorded monotonic detach longer than 30
minutes. It preserves fractional monotonic milliseconds separately from wall,
native-turn and task timing. Recorded client requests, token refreshes, open
transports and issued commands during detach must be zero; this offline check
cannot authenticate those observations. Unavailable physical dispatch telemetry
stays null. No input boolean, provider expiry, private key or admission signature
can establish WorkOS authority.

An executable owner-app recorder and closed receipt signer still need their own
reviewed integration. The supported product entry is the signed-in desktop's
authenticated `RuntimeClient`; the fixture session and fixture `RunStore` are
not owner-org adapters. Device keys stay in main, and product admission
signatures cannot be reused for arbitrary evidence. Private WorkOS session
proof, its latency/rate qualification and all existing Stop, owner, funding,
generation, writer and authority fences remain CP/engine responsibilities.
Before/after observations alone cannot prove that no intervening revocation or
owner switch occurred. The offline report does not claim those guarantees.

Local Personal and organization-local workspaces keep their existing behavior;
this additive cloud-observation checker refuses Local input. No profile,
workflow, active soak, cleanup selector or existing signed receipt changes.
Long-history reader adapters and measurement claims wait for their exact wire
and counter contracts; this bounded check is not a large-history collector.

Verification: run `pnpm test:git scripts/__tests__/zeros-dev-detached-agent-proof`.
Fixtures are synthetic and deterministic. A separate seeded eval removes the
required replay completion check; its retained negative must fail even when
the task file and command receipt look complete. This is an offline feature
acceptance check, not a reproduced live engine fix.
