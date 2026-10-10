# Test-only control plane

This disposable in-memory fixture drives the real headless Linux engine from
the source-mode harness. It is deliberately outside every production app and
package. The transport regression scans production source imports to retain that
boundary. Test directories and test/spec files may compose the fixture; retained
cases reject named, side-effect, dynamic and CommonJS fixture imports from
production files.
Run the harness with `pnpm exec tsx`; import `createFixtureControlPlane` directly
from `server.ts`. No standalone listener or credential output is emitted.

The harness supplies a private CA and server key/certificate through `tls`,
then calls `configureRuntime(attestation)` and `start()` after building its
source runtime. `runtimeConfig()` gives the engine's actual HTTPS registration
material. The harness projects the CA with `NODE_EXTRA_CA_CERTS`; TLS verification
and the production registration/attestation readers remain enabled. Unit-only
fixtures can omit TLS and use loopback HTTP for the individual private routes.

Use `actorGrantToken` to admit the bridge's one actor/device. The one-use grant
expires after two minutes; connected admission renewals require a renewal within
30 seconds and expire after 24 hours. Durable commands keep their recorded actor
after disconnect but fail dispatch after revocation. `delegationId(provider)`
selects that actor's provider grant; `invalidDelegationId` exercises a typed
credential-required refusal from an otherwise correctly claimed command.

Private HTTP contracts implemented:

| Route under `/internal/` | Contract |
| --- | --- |
| `v1/cloud-workspaces/engine/register` | Exact setup/engine/generation/protocol/v4 witness; bare registration response |
| `v1/cloud-workspaces/engine/heartbeat` | Live bearer and scope; bounded lease; bare heartbeat response |
| `v2/cloud-workspaces/engine/client-admission` | One-use actor grant or timely explicit renewal; real actor admission schema |
| `v1/cloud-workspaces/engine/commands` | Snapshot/read/mutate/Stop/claim/settle; real shared command schemas; native opt-in |
| `v2/cloud-workspaces/engine/agent-execution` | Claimed-command or session admission, lease validation/release, read-only empty background state, action authority and empty customization/environment reads |
| `v1/cloud-workspaces/engine/events` | Ordered append, exact last-batch retry, bounded replay/retention and typed cursor refusals |
| `v1/cloud-workspaces/engine/record/head` (GET) | Actual record projection, revision and ten-entry cursor pages |
| `v1/cloud-workspaces/engine/record/append` | Validated mutations, exact revision/idempotency receipts, tombstones |

`cloudCommands.createConversation`, `cloudCommands.conversation` and event
snapshots belong to the real engine bridge/SQLite. The fixture does not invent
CP endpoints for them. Claims have **no redispatch timer**. Execution leases
expire after 45 seconds by default and renew only while live. Admission returns
the accepted repository MCP set, a keyed repository verifier, and the actual
CP/engine public customization digest with private env/header values omitted.

Command responses advertise `x-zeros-cloud-turn-protocol: 1`, as the real CP
route does. Receipts retain native terminals privately. HTTP responses expose
them only when the request supplies both `x-zeros-native-commands: 1` and
`x-zeros-cloud-turn-protocol: 1`; native-v1 requests without the second opt-in
keep native result fields but omit the terminal, and legacy requests omit the
native result. The real engine client uses the acknowledgement before sending
terminal-bearing settlements. Wire projection never changes the stored ledger
used by the consistency helper.

`inspect()` contains bounded metadata only. `readEvents()` and `readCommand()`
are explicit test-only reads of native wire documents, which may contain provider
text; consume them in memory and redact before writing evidence.
`assertTerminalConsistency(commandId)` checks an exact command/execution terminal
against its receipt and the engine's submitted settlement, including failure
code, provider/execution ownership, duplicate terminals and cancellation. If a
native terminal is retained in the receipt, its response metadata is also
checked. Failed receipts retain either human text (the failure publisher) or
the exact typed code (the dispatched receiver). The native frame carries the
typed code plus the same failure object. The helper binds the code to
`resultCode`, accepts only that code or the native failure message for retained
error text, and checks every retained failure field (including kind, stage and
message). Production CP preserves a recorded admission denial even when an
older engine settles generically. The helper refuses that mismatch explicitly
without changing the settlement wire contract.

The default credential mode is `synthetic`: private, deliberately invalid API
keys are generated without reading process.env. `environment` mode snapshots
only ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY and CURSOR_API_KEY
from the harness-supplied environment. Missing or malformed material refuses
admission. No global environment mutation, provider refresh token, login cache,
admin key, request-body logging or external API call exists in this fixture.
The harness controls whether real-provider use is authorized.

The simplifications are intentional: one seeded organization/workspace/engine
and developer actor; no WorkOS/device signatures/Postgres/qualification registry,
provisioning or Alpha connectivity; static credential version; empty Computer
environment; repository-only MCP; synthetic actor-scoped history encryption
keys; every optional native capability false; no ChatGPT keeper, background
retention, native utility goal confirmation, mutable customization, Computer
tools, GitHub broker service, content/blob/checkpoint/usage persistence, idle
stop or generation replacement. Unsupported routes return a closed refusal,
never success. Record projection is bounded to 16,384 entities for test memory.
Ingress uses the real CP route byte limits and content-type refusal codes;
oversized bodies receive a closed JSON fixture refusal rather than Hono's
generic body-limit response. Authentication checks the seeded bearer directly;
it does not model CP database transactions, device signatures or IAM policy.

Fixture conformance does not certify production CP authorization or real provider
first delta/tools/resume/Stop. Synthetic invalid-auth runs only prove the stages
actually reached. Full success acceptance requires W5's authorized real-provider
runs, with the real native boundary and independent checkout inspection.
