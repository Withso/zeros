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
| Commands/native agents | One durable queue; stable IDs, guarded claims, truthful failed/uncertain outcomes, receipt-to-history catch-up. Native CLIs and per-actor credential/delegation authority. | Actual Claude/Codex turns, Stop/approval, lost events/reconnect and deployed admission. Synthetic startup handshakes are insufficient. |
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
credentials. Personal stays Local; org-Local stays on the sidecar.

## Rollout order

1. Back up/drain as required and apply forward migrations, including
   `0138_cloud_workspace_usage_and_ui.sql`, through the protected migration path.
   Keep application/migration roles separate. See
   [database qualification](database-qualification.md) and
   [operations](infrastructure-and-operations.md).
2. Deploy the control plane with the source/v4/actor2 floor and new readers before
   the desktop/worker consumers. Unsupported execution is intentionally refused;
   historical metadata/management/cleanup must remain available.
3. Build, qualify and publish the exact v4 runtime and compatible base through
   the supported bundle consumers (`release-alpha.yml`, `alpha-publication.yml`).
   Source fixes on the server/Mac do not replace a VM's accepted runtime.
4. Adopt a qualified same-base runtime through the existing stopped next-wake or
   explicit fenced upgrade. Retain source/template/settings, Git/index/edits,
   Design and durable chats. Never patch base bytes under an old compatibility ID
   or rewrite historical pins. Ordinary resume of an unchanged pin is not adoption.
5. Publish the desktop with the compatible protocol/capabilities and finish the
   signed Mac + authorized disposable Alpha acceptance matrix.

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
Warm capacity, qualification reuse, VM durable delivery, outbound/multiplexed
transport, forward transcript feeds and Mac acknowledged send-outbox work remain
explicit [follow-ups](warm-pool.md). Seamless live handoff, mobile clients,
active ownership transfer, CRDT/bidirectional replicas, registered primary hosts
and customer-managed Railway template publication remain gated future scope.
