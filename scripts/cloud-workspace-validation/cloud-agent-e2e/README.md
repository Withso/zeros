# Real Linux cloud agent harness

This operator harness builds the current working tree's headless engine with
the production tsup configuration and stages its pinned Linux provider
dependency closure. It starts a disposable TLS fixture control plane, then the
real v4 engine launcher/namespace helper and real CloudNativeBoundary/ZSR path.
Fixtures are test-only; no production registry, base qualification or Alpha VM
is used. Personal Local and organization-local paths are unchanged.

The portable direct-provider test uses a private CA/TLS routing fixture and
the real VM `CloudTransport`. It checks the browser subprotocol carrier,
one-use actor admission, TLS identity, redirect refusal and exact boot/writer
metadata before `CONNECTED` or workspace work:

```sh
umask 022
pnpm exec vitest run scripts/__tests__/cloud-agent-e2e-direct.test.ts
```

`ENGINE_READY.cloudLocalCommands` uses `CloudAgentBootConversationSchema`.
The test constructs this business metadata and its one-use admission callback
explicitly; it does not establish real CP authorization,
real engine boot-mode activation or qualify a Boat public endpoint. Its
`private-tls-routing-fixture` evidence always has `providerQualified:false`.
The helper has no automatic fallback or work redispatch. Production fallback
requires a fresh same-boot actor grant through the desktop broker. Live Boat
WSS qualification remains a post-merge check on an authorized disposable VM.

Run from the repository root on Linux with Node 24, pnpm dependencies,
passwordless sudo, mount/user/PID namespaces, cgroup-v2 delegation, bubblewrap,
setpriv, gcc, git and openssl:

```sh
sudo dnf install -y bubblewrap xz gcc gcc-c++ make python3 util-linux socat
umask 022
pnpm cloud:agent:e2e --providers claude --credentials invalid
pnpm cloud:agent:e2e --providers claude,codex,cursor --credentials invalid
```

Strict is the default scope. On this sandbox its real memory/pids controller
gate fails with `ENOTSUP`. The explicitly selected alternative is:

```sh
pnpm cloud:agent:e2e --providers claude --credentials invalid --scope cpu-private-pid-fixture
```

This alternative is **PARTIAL CLI/bridge evidence — cgroup/resource
qualification pending**, **SOURCE-MODE, no memory/pids cgroup limits**. It uses
the real launcher's existing scope seam, a real CPU cgroup, and a guarded
private PID namespace. Real UID maps, native canaries, authority checks, procfs
and sysfs remain active. Its separate `pidNamespaceRetired` proof never claims
full cgroup containment or Level B/runtime qualification.

On hosts without the qualified base's Podman installation, select the private
Ubuntu OS fixture explicitly:

```sh
pnpm cloud:agent:e2e --providers claude --credentials invalid \
  --scope cpu-private-pid-fixture --linux-view ubuntu-24.04
```

`--linux-view host` is the default. The Ubuntu option downloads the official
Ubuntu 24.04.5 base archive over HTTPS, verifies its SHA256 against the published
SHA256SUMS before extracting into a new empty scratch directory, and installs
Podman, bubblewrap, uidmap and adjacent tools through authenticated apt. Its
programs execute only in a guarded private mount/PID namespace. Writable OS
mounts point only to that new rootfs; `/proc` and `/sys` remain real. This OS
fixture is unqualified and does not supply the missing memory/pids controllers.
The outer view binds its already private parent's procfs; after root, mount
namespace and PID1 checks, the entry mounts fresh real procfs and verifies that
its init belongs to its own PID namespace. This avoids the locked child mounts
created by outer `bwrap --proc`, which reject later worker procfs mounts. The
real engine and worker namespace helpers retain their native checks.

`invalid` is the default. It supplies synthetic invalid access material to the
fixture CP and never reads ambient provider tokens. It proves only stages up
to the actual observed gate. A typed provider authentication failure is an
expected case; an earlier native or authority refusal fails the run and does
not count as provider-auth proof. Streaming, native tools, resume and
Stop acceptance stay pending until real authorized provider responses run.
Do not infer authorization from credentials being installed on the machine.
Only after the owner explicitly authorizes real provider turns:

```sh
pnpm cloud:agent:e2e --credentials environment --owner-authorized-provider-turns
```

Provider models can be selected with `--claude-model`, `--codex-model` and
`--cursor-model`; these are pinned into actor-bound fixture grants. Real turns
use the actual engine CloudTransport, renderer-shaped `cloudCommands.request`
mutations, live AGENT_* frames, authenticated paginated replay, and durable
receipts. There is one dispatcher and one enqueue; a lost or uncertain response
never causes a prompt replay. Empty success and replay-only output fail.
The authenticated event cursor captured immediately before enqueue bounds the
turn. Live text and terminal frames must match authenticated replay by stream,
sequence and bounded SHA256 fingerprints; prior-turn, changed or truncated
replay fails. Fingerprints retain no provider text.

Each run writes under `.context/agents-fix/scratch/W5/e2e-*/`. `evidence.json`
contains closed stage/code fields, byte counts, fixture metadata and explicit
pending matrix cases. Provider prose, tool output, argv and credentials never
enter the trace. Config/TLS files are private fixture capabilities (0600 keys,
0700 directory); never share them. The evidence ledger is captured before CP
close releases leases. Root supervisor stdout contains only its closed control
protocol; raw engine output stays in a bounded in-memory diagnostic buffer.

A failed case preserves its original typed receipt code, separate assertion
code, and authenticated live/replay counts. Positive retirement is reported
independently from that failed turn; cleanup before a namespace starts is
pending. Engine identity reads only the executable, uid/gid maps and fixed
status fields in the private PID namespace, never process argv or environment.

All `/opt`, `/etc`, `/run` and `/srv` overlays and `/usr/bin` overlay are created
only after verifying a new private mount namespace. The fixed host UID map is
0→10003, 10001→10001 (length 2), 10004→10004. Runtime/configuration is root-owned;
engine state belongs to 10003, worker HOME/checkout to 10001, capture HOME to
10002. Engine/provider authority is still admitted through real production
checks; no Local fallback or absent-marker path exists. Source fixtures reuse
the sandbox's working SQLite N-API prebuild in a private staging projection;
the manifest identifies this separately from a release source build.

The exact observed repository MCP fixture is
`{"mcpServers":{"0canvas":{"type":"http","url":"http://localhost:24193/mcp"}}}`.
Its unreachable local service is independent from parser/admission acceptance.
Native tool acceptance verifies output bytes/UID independently through the
root supervisor: an undisclosed random fixture input must appear in the edited
output, and shell output contains the turn nonce plus UID 10001. Each case
resets prior markers and checks their initial absence. Stop waits for the
fresh native shell's start marker before sending
Stop and requires a cancelled receipt plus absent finish marker and confirmed
domain retirement. A stopped pre-start tool is not mid-tool proof.

Current limits: the Vercel sandbox's cgroup root is `domain threaded` and cannot
enable the memory controller (`ENOTSUP`). Strict v4 cgroup launch fails there;
no full v4 base/runtime resource qualification is claimed. Real-response matrix,
provider spawn fault injection and excluded/project/plugin MCP launch-marker
matrix remain pending. A run never silently treats an all-skipped matrix as
passed.

Retained portable regressions:

```sh
umask 022
pnpm exec vitest run scripts/__tests__/cloud-agent-e2e-driver.test.ts \
  scripts/__tests__/cloud-agent-e2e-runtime.test.ts \
  scripts/__tests__/cloud-agent-e2e-retirement.test.ts \
  scripts/__tests__/cloud-agent-e2e-scope.test.ts \
  scripts/__tests__/cloud-agent-e2e-identity.test.ts \
  scripts/__tests__/cloud-agent-e2e-ubuntu.test.ts \
  scripts/__tests__/cloud-agent-e2e-diagnostics.test.ts \
  scripts/__tests__/cloud-agent-e2e-fixture-cp.test.ts \
  scripts/__tests__/cloud-agent-e2e-fixture-cp-transport.test.ts
```

They cover strict ownership/wire shapes, early ENGINE_READY/account readiness,
empty-success refusal, authenticated replay, typed failure consistency, private
mount guards, no implicit credential import, timeout cleanup, and late/nonzero/
forced namespace retirement failures. These regressions are separate from the
real engine/provider run and do not substitute for it.

The R7 measurement adapter instantiates the real renderer `CloudAgentConnection`
and ordered `CloudEventReader` over an authenticated Node bridge. Its private
HTTPS grant helper performs the public prepare POST with synthetic user
authority, an empty body and a fresh idempotency identity; actor, provider,
model, expiry and qualification checks remain active. It verifies the fixture
CA, refuses redirects and bounds response size, timeout and cancellation.
These modules have portable regressions:

```sh
umask 022
pnpm exec vitest run scripts/__tests__/cloud-agent-e2e-renderer.test.ts \
  scripts/__tests__/cloud-agent-e2e-bridge.test.ts \
  scripts/__tests__/cloud-agent-e2e-renderer-grant.test.ts \
  scripts/__tests__/cloud-agent-e2e-renderer-http.test.ts \
  scripts/__tests__/cloud-agent-e2e-measurement.test.ts \
  scripts/__tests__/cloud-agent-e2e-renderer-turn.test.ts \
  scripts/__tests__/cloud-agent-e2e-ingress.test.ts \
  scripts/__tests__/cloud-agent-e2e-ingress-inventory.test.ts \
  scripts/__tests__/cloud-agent-e2e-baseline.test.ts \
  scripts/__tests__/cloud-agent-e2e-operator.test.ts
```

The explicit current-path measurement operator uses these modules:

```sh
pnpm cloud:agent:e2e --providers claude,codex,cursor --credentials invalid \
  --measurement current --cp-request-delay-ms 100 \
  --scope cpu-private-pid-fixture --linux-view ubuntu-24.04
```

The default command still runs the original unmeasured matrix. Measurement
currently accepts invalid credentials only. The optional request delay is an
integer from 0 to 5000ms, applied to every declared fixture route; it never
changes authority deadlines. A fresh conversation is measured per provider.
Missing actual `cloud.turnTimings.v1` capability, timing packet, native/auth
stage or complete fixture details refuses evidence. Portable fixtures alone
do not prove browser click timing, OAuth/account switching, native provider
acceptance or zero foreground CP requests. Fixture mutations are not actual
SQL statements; direct bridge bytes are not CP-relayed bytes.
Missing native ACK, causal coverage or actual SQL/relay evidence stays
unavailable rather than zero. The live/authenticated replay and receipt guards
continue to apply independently of timing observations.

Select the negotiated boot-owner path explicitly for the after comparison:

```sh
pnpm cloud:agent:e2e --providers claude,codex,cursor --credentials invalid \
  --measurement boot-owner --cp-request-delay-ms 100 \
  --scope cpu-private-pid-fixture --linux-view ubuntu-24.04
```

This requires actual engine `cloud.localCommands.v1` and timing capabilities,
the strict `cloudLocalCommands` ready binding, and the fixture CP's independently
activated matching boot/writer. It uses the real grant-free renderer Send and
refuses a legacy fallback. VM live and authenticated replay still prove exact
current-turn frames; compact CP history proves only the separate eventual
canonical final state. After the measurement interval, the guarded namespace
helper opens the actual engine FULL SQLite ledger read-only and compares its
terminal, immutable audit, current head and canonical hashes with the fixture
projection after outbox drain. Missing bytes, incomplete history, changed
binding or timeout cannot produce a complete-history result. Only hashes and
counts leave that helper. Both modes retain the SOURCE-MODE/PARTIAL and invalid
auth limits above; SQL, CP-relayed bytes and causal attribution remain
unavailable in this memory/direct topology. The separate real CP service cost
comparison is independent of this operator.

Boot-owner measurements send twice per provider in the same conversation:
`cold-first`, then `same-conversation-second` after the first turn's independent
final proof. Each send has its own command/message identity, timing packet,
live/replay/receipt checks and CP arrival rows. Invalid authentication can
retire the native host, so the second case proves conversational reuse only;
native host reuse and successful provider responses remain unproved. Failure
does not retry a send, and a failed second case retains the first case's row.
Calibrated prefix rows retain closed route/operation, arrival/completion
sequence and time, status and interval membership. Origin/span/wait attribution
is explicitly unverified until an actual authenticated producer proves it.

The pure timing validator checks the inspected packet against the exact
workspace, boot, writer, command, turn, execution and provider. It reports a
request-response clock uncertainty range, separates native writes, acceptance
ACKs, SDK run creation and first text/tool, and refuses incomplete or conflicting
evidence. An observed ACK may follow the first output. The validator alone
supplies no native, CP request, SQL or relay measurement.

The current-path turn helper captures the actual outgoing renderer command
UUID before forwarding it. It includes grant preparation and pre-reads in
Send, then independently verifies raw live frames, authenticated VM replay,
receipt and CP terminal consistency before inspecting timings. It stops an
uncertain submitted turn once and disposes its observations. Controlled bridge
regressions are separate from running the real engine and provider CLIs.

Fixture ingress summaries validate cumulative totals against bounded request
details and keep arrival, completion and pending work separate. Calibrated
intervals report minimum/maximum counts when an arrival is near a boundary.
Missing details or inconsistent clocks refuse evidence. A route does not
identify a causal foreground dependency; those counts remain unavailable
until trusted request and wait correlation is exercised.

Measurement results separate exact `sendWindow` checkpoint counts from the
wider `ingress.fullWindow`, which includes attachment and verification work
to cover clock uncertainty. `observedIntervals` slices that wider window at
the verified engine receipt and each available native write, acceptance ACK,
SDK run creation or typed auth failure. None supplies another missing marker.
Request counts use minimum/maximum bounds, including the fixture's integer
microsecond timestamp resolution. Foreground/background causal counts,
production SQL cost and CP-relayed bytes remain explicitly unavailable in
this direct fixture topology. Warm successful follow-up, Stop and recovery
measurements remain pending.
