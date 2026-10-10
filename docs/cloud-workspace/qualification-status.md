# Cloud workspace qualification status

This page separates current repository behavior from release evidence. Alpha
cloud operation predates the overhaul; historical qualification of an older
image/deployment does not qualify the changed source, runtime or desktop.
Account-specific deployment receipts and test-run diaries stay in private
operational records, not this guide.

## Current implementation

| Area | Implemented contract | Qualification still required |
| --- | --- | --- |
| Execution floor | Boat-only; immutable saved v2 Computer source, complete qualified v4 pin, actor2. Retired rows retain metadata/history/cleanup and refuse new execution. | Exact released worker/base pair, intentional old-profile/actor-v1 refusals and supported-cohort skew. |
| Computer/create | Current organization members see v2 settings; admins manage builds/repository setup. Source/CAS/role/funding checks precede allocation. Renderer pending creation binds the confirmed UUID atomically. | Signed Mac create/failure/account-switch flows and exact template qualification. |
| Commands/native agents | One dispatcher per mode: legacy CP queue or negotiated VM-local queue; immutable actor/model/key/cwd admission, typed failures, exact terminal receipts, atomic per-chat recovery and owned decision replies. | Actual Claude/Codex/Cursor successful turns, native tools, resume, Stop/approval, lost events/reconnect and deployed admission. Synthetic startup handshakes are insufficient. |
| Negotiated fast path | Boot-owner selection/cache/lifetime, exact local queue/writer, bounded canonical capture/materializer/stopped readers, native-use notice and fenced removal contracts; legacy mode remains separate. | Integrated activation/epoch/retirement, FULL CAS/outbox/mirror/recovery and deployed rollout; source slices alone cannot qualify the complete path. |
| Native customization | Exclusive admitted MCP/skills; tolerant per-provider repo MCP with bounded notices; bounded Claude/Codex/Cursor instruction projections. Raw project/plugin authority remains disabled. | Exact worker/base native MCP and skill markers, auth/model/env traps, explicit Plan and actor-scoped permission isolation; safe additional native features only after proof. |
| Reference images | Chunked actor-owned VM publication and opaque prompt references; large PNG bytes tested through all three adapter paths, without increasing the queue cap. | Real-provider image reading and signed-client attachment/reattachment flows. |
| Git/Files/Design | Checked engine publication and required startup ownership recovery; finite Git diagnostics; direct PR commits net pending Code+Design. | Worker read/diff/commit, Design creation/Files refresh/capture, named targets, real GitHub installation/courier and conflicts on the adopted pin. |
| Lifecycle/recovery | Fenced setup/engine registration; periodic maintenance plus notifications/retry deadlines; checkpoints, stopped wake and generation recovery. | Fresh-allocation restore, rollback, unknown provider outcomes, authority loss, physical deletion and object cleanup. |
| Desktop/native access | Exact runtime routing, status/details/resources/ports, receive-only sync, main-owned Terminal/forwarding and revocation. Native editor launch remains hidden. | Signed macOS SSH/host trust/PTY/SFTP/tunnels/preview, frame isolation, focus and account/device/generation retirement. |
| Presentation cache | Bounded durable sanitized confirmed transcript windows, revision/tail cursor and provisional Cached paint; no send/completion authority. | Packaged Mac restart, disk/IPC timing, deletion/role/account retirement and streaming races. Forward incremental feed remains separate. |
| Runtime updates | Immutable bundles/pins; same-base wake/explicit upgrade; transfer/staging/resident handoff machinery, one journal. Staging cannot activate. | Exact controller/source/target/resident pair, rollback formats, workload survival, concrete acceptance adapter and measured handoff gap before automatic/present-client activation. |
| Spend/operations | Individual sponsorship, quotas, credit reservations, finite compute leases, cumulative meters and bounded checkpoint/Stop; encrypted durable objects. | Current deployment budgets, observability, provider loss/settlement, backup/PITR/object-key/deletion and regional recovery drills. |

Source/test anchors are in [engineering reference](engineering-reference.md).
Basic v4 credential runtime qualification and MCP qualification are distinct;
MCP/native Computer operations require their additional current evidence.
WorkOS membership alone does not grant paid authority or another person's agent
credentials. Boot-mode sharing separately records run-capable role consent to
owner funding. Personal stays Local; org-Local stays on the sidecar.

## Source-mode agent harness

`pnpm cloud:agent:e2e` builds the current headless engine with the production
configuration and pinned Linux provider closure, then attempts the real v4
launcher against a disposable TLS fixture control plane. It exercises the
durable queue, gateway and adapters without production credentials, registry
publication or Alpha allocation. The fixture seeds one actor/engine and bounded
in-memory ledgers; it does not qualify production identity, PostgreSQL, billing
or recovery authority. See the
[operator README](../../scripts/cloud-workspace-validation/cloud-agent-e2e/README.md)
for Linux dependencies, private mount layout and retained tests.

```sh
umask 022
pnpm cloud:agent:e2e --providers claude,codex,cursor --credentials invalid
```

Strict scope is the default and keeps production cgroup admission. Hosts unable
to delegate memory/pids controllers fail that gate. An explicit debugging scope
is available:

```sh
pnpm cloud:agent:e2e --providers claude --credentials invalid --scope cpu-private-pid-fixture
```

Its evidence is **PARTIAL CLI/bridge evidence — cgroup/resource qualification
pending**, **SOURCE-MODE, no memory/pids cgroup limits**. A real CPU group and
private PID namespace supply separate retirement proof; native UID/canary,
attestation and authority checks remain required. This is not Level B or
worker/base qualification. Source staging also identifies its fixture-only
SQLite N-API prebuild instead of representing it as a release artifact.

Invalid mode never reads ambient provider tokens. It proves only the stages
actually reached before authentication refusal. Real responses require explicit
owner authorization and both `--credentials environment` and
`--owner-authorized-provider-turns`; optional `--claude-model`, `--codex-model`
and `--cursor-model` bind exact fixture grants. Each private `evidence.json`
records closed stages/codes/counts, pending cases and `qualified: false`.
Credentials, prompts, provider prose and tool output never enter that ledger.

The driver checks authenticated live frames and paginated replay, receipt/native
terminal identity, fresh independent read/edit/shell markers, native UID, reused
provider binding and Stop after a fresh shell-start marker. Fixture inspection
cannot replace replay. Retirement requires final child close, successful exit,
positive domain proof and no late cleanup failure. These implemented assertions
are separate from an actual passing provider run.

Current PARTIAL source controls use a SHA-verified private Ubuntu fixture and
prove the real v4 engine maps, registration/readiness, SQLite head/append,
actor-admitted transport and renderer Send through all three pinned providers'
typed invalid-auth results. Authenticated live/replay/receipts agree, leases
release and private PID/CPU retirement succeeds. The
[legacy measurements](#measured-legacy-controls) retain reached stages and counts;
they do not qualify provider success, resources or integrated new-mode behavior.
First delta, native tools, images, resume and mid-tool Stop require real provider
runs. Integrated excluded-project/plugin MCP markers, spawn faults and strict
resource qualification remain pending. Pinned native unit probes establish
configuration/startup behavior only. Never mark the success matrix passed from
invalid auth, synthetic fixtures or an all-skipped run.

## Measured legacy controls

The Phase 3 CURRENT controls exercise the real renderer Send and pinned native
providers with synthetic invalid credentials in a SOURCE/PARTIAL fixture.
All three retain matching authenticated live/replay, typed receipts, released
leases and positive private-PID retirement. These are single negative-auth
samples, not first-output latency or successful agent turns.

| Provider | CP arrivals during Send/result, 0 / 100 ms injected delay | Renderer Send→result seconds, 0 / 100 ms |
| --- | --- | --- |
| Claude | 17 / 22 | 1.881 / 2.839 |
| Codex | 49 / 57 | 15.679 / 16.685 |
| Cursor | 13 / 15 | 1.265 / 2.139 |

Claude/Codex return `cloud_provider_prompt_auth_required`; Cursor returns
`cloud_provider_start_auth_required`. Counts include overlapping background
requests in the declared window; they are not causal foreground-only counts.
The two runs use different source hashes, so their difference is not a measured
speedup or controlled estimate of CP delay. SQL, relay cost and first text/tool
timing are unavailable in this memory/direct fixture. The new-mode native
comparison remains pending integrated activation.

A separate real PostgreSQL/CP-service synthetic legacy workload—one user
message, 100 deltas, one permission request/settlement and terminal—measures
**8 committed transactions, 108 inserted tuples and 9 updated tuples**, with no
rollback. It excludes credential/actor/runtime setup and the production durable
action lifecycle. The [cost integration test](../../apps/control-plane/src/cloud-workspaces/agent-turn-cost.integration.test.ts)
also measures **47,212 forwarded payload bytes** in a local relay fixture;
identical direct delivery adds **0 CP-relayed bytes**. This is selected-service
and transport-fixture evidence, not production/provider-WSS qualification.
Statements, encoded persistence bytes and warm new-mode turn cost remain
unavailable until actually measured.

## Rollout order

1. Back up/drain as required and apply forward migrations, including
   `0138_cloud_workspace_ui_metadata.sql`, `0139_cloud_local_command_queue.sql`
   and `0140_cloud_agent_boot_credentials.sql`, through the protected migration path.
   Keep application/migration roles separate. See
   [database qualification](database-qualification.md) and
   [operations](infrastructure-and-operations.md).
   Deploy the separate Dev broker's `0005_conditional_removals.sql` before
   enabling its conditional reference-removal caller.
2. Deploy the control plane with boot vault/actor/context/removal endpoints,
   compact mirror and stopped readers before desktop/worker consumers. Preserve
   the source/v4/actor2 floor and legacy path. Unsupported execution is intentionally refused;
   historical metadata/management/cleanup must remain available.
3. Build, qualify and publish the exact v4 runtime and compatible base through
   the supported bundle consumers (`release-alpha.yml`, `alpha-publication.yml`).
   Source fixes on the server/Mac do not replace a VM's accepted runtime.
4. Publish a compatible desktop and qualify explicit negotiation before
   activation: registration request/ACK, ready cache and FULL ledger, genuine
   boot activation, current actor confirmation and exact `ENGINE_READY` binding.
   Direct transport additionally opts into `directProviderVersion: 1` beside
   actor protocol2. Optional capabilities keep the protocol version unchanged;
   they cannot bypass the legacy strict contract. Old desktops on new-mode
   workspaces receive the existing upgrade-required refusal. Local is unchanged.
5. Adopt a qualified same-base runtime through the existing stopped next-wake or
   explicit fenced upgrade. Retain source/template/settings, Git/index/edits,
   Design and durable chats. Never patch base bytes under an old compatibility ID
   or rewrite historical pins. Drain legacy pending/dispatching commands and
   unreleased executions before local-writer activation; an unknown ACK or
   missing binding refuses rather than selecting legacy. Ordinary resume of an
   unchanged pin is not adoption.

Finish the signed Mac and authorized disposable Alpha acceptance matrix on the
adopted pair. The implemented negotiation still needs source and released-binary
skew proof; this guide does not claim that pending gate passed.

The separate `cloud-runtime-publication.yml` flat OCI pipeline is retired. Its
static `/opt/zeros-runtime` recipe still installs the v3 worker profile, so the
publisher and receipt steps refuse before any build, registry or receipt work.
It is not the qualified v4 workspace-runtime bundle. The shared Dev image kit
remains under an explicit publication follow-up. Consumer/base-contract
disposition and qualification must precede any v4 flat-image cutover; changing a
marker cannot qualify it.

The opt-in v3 release-worker promotion lane is retired. With
`ZEROS_WORKER_PROMOTION=enabled`, release refuses before allocation/build/credential preparation;
the disabled lane preserves normal release publication. Historical receipts and
builder/storage cleanup remain available. **Re-qualify a v4 release-worker lane
if needed** is separate future work; it cannot weaken the workspace v4 floor.
See [release worker qualification](release-worker-qualification.md).

`CLOUD_WORKSPACES_ENABLED`, background/setup gates, baked desktop capability and
native feature gates remain separate. Current code defaults do not establish a
deployed flag value or customer release approval. Preparation reuse defaults
true only on Alpha, is explicitly disableable, remains staff/negotiation/pin gated
and always needs fresh final attestation/launch/registration. See
[wake performance](wake-performance.md).

## Release acceptance

- Run the repository verification matrix and applicable selected CI lanes.
  Required checks include adjacent runtime/CP tests, forward migration checks,
  protocol/preload/hardening, UI/build/smoke, secrets/licenses and Actions for
  changed workflows. CI-definition changes require owner merge.
- Qualify the actual worker UID, namespaces/cgroups, protected installer/tree,
  runtime/base manifests, native tools and all required credential kinds. Root-
  only probes or historical v3 qualification cannot qualify v4 admission.
- Run the supported N/N−1 released-binary matrix within the saved-v2/v4/actor2
  floor. Intentional retired-profile refusals are a separate negative contract.
  No skew test may restore unsupported execution or revoked qualifications.
- Prove old desktop/new VM and new desktop/old v4 VM behavior for strict terminal
  results and owned permission/question replies, plus CP-first settlement. Refuse
  incompatible cloud clients before send and preserve Local protocol support.
- Exercise ordinary public actor admission, not provider-admin execution, for
  agents, Git/Files/Design, durable queue/receipts/replay, SSH/preview/tunnels,
  stop/wake/archive, recovery and cleanup. Use explicitly authorized disposable
  fixtures, bounded budgets and verified all-generation cleanup.
- Verify live revocation during issuance/I/O, multiple devices and owner switches;
  preserve undispatched/paused queue state and never replay uncertain native
  effects. Retired generations need metadata/history/export/delete acceptance.
- Qualify backup/PITR with referenced object integrity, key rotation, forced RLS,
  source fencing and target comparison. Approve RPO/RTO, capacity, incident,
  privacy/licensing and regional/object-store-loss policy separately.
- Run `pnpm smoke:engine` and native access/preview acceptance on macOS. Linux
  renderer, CLI and synthetic tests do not establish native disk/IPC/paint,
  signed-client behavior or deployed provider correctness.

No new live latency distribution or ≤2-second stopped wake/usable create result
is established by this overhaul's repository tests. The historical five setup
runs and unmatched probe limits remain in [wake performance](wake-performance.md).
Warm allocation capacity, qualification reuse, broader VM inbox/restore recovery,
outbound/multiplexed transport, forward transcript feeds and a general Mac
acknowledged send outbox remain
explicit [follow-ups](warm-pool.md). Seamless live handoff, mobile clients,
active ownership transfer, CRDT/bidirectional replicas, registered primary hosts
and customer-managed Railway template publication remain gated future scope.
