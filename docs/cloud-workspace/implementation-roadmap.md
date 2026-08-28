# Cloud workspace implementation roadmap

This is the living execution plan. An unchecked item is not a shipped
capability. Update code anchors, migrations, tests, and exit evidence in the
same change that marks an item complete.

## Release boundary

Phase 5 is the complete seamless **single-member** cloud-workspace release:
Personal or Organization ownership, local/cloud creation, normal desktop
feature parity, durable recovery, Design writes in the sandbox, SSH, previews,
localhost port forwarding, explicit local/cloud authority moves, and an
optional receive-only local replica.

Phase 6A is required for **Organization multiplayer**: membership roles,
presence, shared live chats, per-member replicas, assignment, owner-funded
usage, and ownership transfer. Native iOS/Android, automatic bidirectional file
sync, and collaborative source/Design editing are explicitly deferred.

The ordering is deliberate: identity/settings precede paid provisioning;
durable state precedes migration/sync; and safe single-authority movement
precedes multiplayer.

## Phase 0 — Contract freeze and provider qualification

### Product and threat-model decisions

- [ ] Freeze the independent tenant, authority-placement, and device-replica
      model from
      [data, placement, migration, and local sync](data-and-sync.md).
- [ ] Freeze Phase-5 receive-only replica semantics and the distinction between
      Move, Sync, and Copy. Do not leave bidirectional write behavior implicit.
- [ ] Complete threat models for the remote engine, untrusted repository,
      Design resource proxy, SSH, preview/port forwarding, local replica path,
      provider connections, object storage, and ownership transfer.
- [ ] Resolve supported agent authentication, delegated subscription use,
      owner-funded invocation, runtime redistribution, and dependency-license
      release blockers.
- [ ] Define data classification, retention, export, deletion, recovery-point,
      and recovery-time targets for hosted and customer-managed deployments.

### Existing validation foundation

- [ ] Review the opt-in token/account-gated `CloudTransport` and prove it does
      not weaken local loopback/origin protection.
- [ ] Retain unit coverage for health, credential carriers, account binding,
      connection lifecycle, limits, backpressure, ping/pong, shutdown, and
      bridge round trips.
- [ ] Run the operator-only `scripts/cloud-workspace-validation/` sequence in a
      representative Daytona account, including exact image/ABI, required
      agents, PTY, reconnect, egress, lifecycle, soak, SSH, and verified delete.
- [ ] Store dated sanitized measurements in the private operational system;
      public CI and source presence are not evidence that paid-provider checks
      ran.

The branch already contains the transport, account verifier, provider
qualification harness, protected manual workflow, and a gated control-plane
foundation. The boxes remain unchecked until the required review and live
evidence exist.

Exit: the product contracts are approved; release/legal/security blockers are
owned; and representative live runs prove the engine image and provider
lifecycle without credentials or customer data in tracked files or logs.

## Phase 1 — Canonical identity, settings, and control-plane model

### Forward-only identity migration

- [ ] Add immutable global UUIDs for desktop repositories/workspaces while
      preserving current path-derived repository IDs and human-readable
      workspace IDs as compatibility aliases.
- [ ] Add one stable `repositories` identity keyed by tenant, forge, and forge
      repository ID. Store names/URLs as mutable metadata and device paths only
      in device SQLite.
- [ ] Add the stable server workspace record for cloud, moved, or policy-
      registered workspaces with tenant/team/repository, creator,
      `owner_user_id`, `assignee_user_id`, visibility, authority placement/epoch,
      optimistic version, and deletion state. Never-cloud local workspaces keep
      the same UUID contract in device SQLite without requiring content/chat
      upload.
- [ ] Evolve the existing `cloud_workspaces` record into the cloud-execution
      projection without changing released/public workspace IDs. Backfill
      existing rows transactionally and preserve current lifecycle routes
      through a compatibility layer.
- [ ] Replace the current permanent Personal-local-only database constraint
      with explicit placement eligibility. Personal cloud must remain feature-
      and quota-gated until Phase 5; Personal still has exactly one member.
- [ ] Add append-only `workspace_executions` and idempotent
      `workspace_placement_intents`, enforcing at most one live authoritative
      execution/epoch per workspace.
- [ ] Add `devices` and `workspace_replicas` now, even though Phase 5 initially
      authorizes only the workspace owner. Use one live binding per
      workspace/user/device and never store an absolute Mac path server-side.

### Settings and credential model

- [ ] Add versioned Shared/Local/Cloud repository settings and Personal/
      Organization environment profiles. Critical authorization, billing,
      lifecycle, and provider fields remain normalized columns.
- [ ] Implement the documented precedence with per-leaf provenance and an
      immutable redacted settings snapshot for each execution generation.
- [ ] Preserve `.zeros/settings.toml` as reviewable shared repository state and
      `.zeros/settings.local.toml` as never-uploaded device state. Add
      compatibility parsing/tests before introducing placement-aware syntax.
- [ ] Split MCP/environment definitions from secret values. Add opaque scoped
      secret bindings, explicit Personal-to-Organization inheritance consent,
      rotation, revocation, and managed-policy enforcement.
- [ ] Add encrypted `provider_connections` owned by a user or Organization.
      Bind each cloud generation to a connection; remove the assumption that
      one deployment-wide Daytona API key is every user's provider account.

### Authorization, billing, and events

- [ ] Define workspace roles independently from Organization roles and ensure
      every workspace member remains a member of the owning Organization/Team.
- [ ] Add immutable usage events with actor, billing-owner snapshot, billing
      epoch, provider/agent connection, quantity, and source idempotency key.
- [ ] Add ownership-transfer records now, even though the Phase-6A UI remains
      off. Reassign and transfer-owner operations must be different contracts.
- [ ] Add a transactional outbox and audit events for lifecycle, authority,
      settings, provider, replica, grant, usage, and ownership operations.
- [ ] Force RLS on every tenant table, use composite tenant foreign keys, and
      test application authorization independently from RLS.

The existing migration `0010_cloud_workspace_control_plane.sql` already
provides useful cloud generation, intent, provider-binding, setup-run, grant,
quota, RLS, and reconciliation foundations. Extend them with new forward
migrations; never edit a shipped migration in place.

Exit: mixed-version tests preserve local IDs and current cloud routes; Personal
and Organization × local/cloud records can be represented; cross-tenant,
duplicate-request, concurrent-intent, stale-epoch, revoked-membership, settings-
provenance, and usage-deduplication integration tests pass.

## Phase 2 — Production cloud execution and secure access

### Image and setup worker

Implemented foundation: migration `0013_cloud_workspace_setup_worker.sql` and
`setup-worker.ts` provide immutable generation inputs, workspace-first claims,
renewable leases, bounded retry, cancellation, and stale-result fencing.
`daytona-command-runner.ts` adds exact-resource command lookup, mandatory
provider deadlines, abort handling, strict input bounds, and bounded output.
Migration `0014_cloud_workspace_setup_authority.sql`,
`daytona-setup-executor.ts`, and `setup-admission-broker.ts` add an exact fixed
helper command, one-use setup-run/fence-bound admissions, fail-closed response
validation, and immutable structured readiness attestations. Migration
`0015_cloud_workspace_setup_materials.sql`, `setup-materials.ts`, and the
capability-only internal routes redeem that admission for an exact settings
snapshot, encrypted secret values, one repository-scoped read credential, and
an engine registration grant. The image now owns the strict clone/settings/
bounded-command helper and a root-only one-use process supervisor; the engine
registers, heartbeats, fails closed when its lease is lost, and renews the
short-lived GitHub working credential without storing the token in PostgreSQL.
Production boot wiring is protected by the independent
`CLOUD_WORKSPACE_SETUP_WORKER_ENABLED` gate, so provisioning may remain paused
at `setting_up` while the setup image is unqualified.

Migration `0016_cloud_workspace_generation_transitions.sql` and the lifecycle
reconciler now drain the source generation before candidate creation, fence
late results, promote only a ready candidate, and delete a rejected candidate
before waking the source. Migration `0017_cloud_workspace_client_access.sql`
and `access.ts` add account/Team/current-generation-bound SSH, localhost tunnel,
and isolated preview grants; only SHA-256 verifiers persist, unknown SSH issue
outcomes enter durable provider-wide revocation, and lifecycle or membership
loss fails future access closed. The protected qualification workflow now
contains production-adapter preview, SSH-forward, stop/wake, and rollback-
primitive checks, but their presence in source is not evidence that a live run
passed.

Migration `0018_cloud_workspace_engine_authority.sql` makes membership, account,
Organization, and Team retirement part of the database authority boundary.
User-context self-leave cannot hide credential rows behind FORCE RLS; issuing
and active access, endpoint grants, and engines are retired atomically. Scope
deletion cancels setup/replacement and queues provider deletion for every
generation. Until Phase 1 adds an explicit owner/billing epoch, WorkOS deletion
of the temporary `created_by` owner also queues deletion of its paid compute.
Fresh-install and every-intermediate-revision PostgreSQL tests cover these
transitions, but the remote deletion/revocation result still requires the live
provider gate.

The macOS-native service slice is also present: a bounded Electron-main client
and broker keep access credentials out of IPC responses, install HTTP preview
headers only for the exact authorized Browser frame ancestry, open Terminal,
copy an SSH command directly to the native clipboard, launch Cursor/VS Code,
and supervise exact `127.0.0.1` OpenSSH forwards. Provider-wide SSH revocation
is reflected across same-generation sibling leases, and malformed issuance,
launch failure, frame-capacity failure, auth replacement, or app exit fails
closed. This is not yet the Phase-5 cloud catalog/details UI, port discovery,
or a signed macOS/provider E2E result. External IDE launch now uses a fixed SSH
alias and isolated user-data directory whose Remote-SSH settings reference the
private per-launch config, keeping the provider username out of child argv and
recent-workspace state. Account/app disposal removes the projected config
immediately. The exact signed clients and cleanup behavior still need macOS/
provider qualification before closing the access item.

These checkboxes remain open until the exact baked image passes the full live
Daytona qualification, the current root engine-coordinator exception is either
removed or approved in the
[`root coordinator threat model`](./root-coordinator-threat-model.md), safe
generation upgrade/rollback and stop/wake behavior are provider-proven, and the
Phase-2 desktop SSH/preview/tunnel flow plus provider-edge controls are
complete. A unit or PostgreSQL integration test is not provider qualification
evidence.

- [ ] Produce a pinned, licensed, reproducible engine image for each supported
      architecture and record its immutable identifier/source commit.
- [ ] Run engine/setup/agents as a non-root workspace user with provider/VM
      resource limits and a read-only/minimal base where practical.
- [ ] Implement the setup worker that claims queued setup runs, obtains a
      repository-scoped short-lived grant, clones the exact repository/revision,
      applies the versioned settings snapshot, runs bounded setup, and publishes
      sanitized logs.
- [ ] Start the engine with a short-lived tenant/workspace/generation/purpose-
      bound grant. Readiness requires repository integrity, settings generation,
      engine health, protocol handshake, and durable-record connectivity—not a
      listening port.
- [ ] Implement safe retry, cancellation, generation upgrade, rollback, and
      complete stop/wake/archive/delete behavior. Reconciliation resolves
      timeouts after dispatch and verifies provider deletion.

### Provider and repository credentials

- [ ] Make the provider adapter resolve the generation's `provider_connection`
      just in time. Decrypt only inside the coordinator and never return raw
      credentials to the renderer, database logs, or sandbox.
- [ ] Support the hosted provider connection first, then a user's own Daytona
      connection through the same adapter contract. Validate ownership,
      capability, region, quota, and account revocation before dispatch.
- [ ] Use GitHub App installation/repository grants with separate clone/fetch
      and branch-limited push permissions where supported. Do not place a broad
      user token or provisioning credential in the sandbox.
- [ ] Recheck repository and workspace authorization when issuing or consuming
      every privileged grant.

### SSH, preview, and network boundary

- [ ] Issue short-lived account/workspace/generation-bound SSH grants on demand;
      support open in Cursor/supported IDE, open Terminal, and copy command.
- [ ] Add authenticated HTTP preview grants and revocation. Prefer a separate
      header token; signed URLs are explicit time-limited sharing operations.
- [ ] Add a TCP-over-SSH tunnel primitive for desktop localhost forwarding.
      Never expose a public or Organization-wide port by default.
- [ ] Enforce inbound policy and provider-edge rate limits; document direct
      tenant-VM egress for the initial release and test the configured network
      boundary.

Exit: a fresh authorized repository reaches true readiness, supports the normal
bridge/PTY/Git/Design API plus revocable SSH and preview/tunnel access, survives
stop/wake and generation replacement, and is completely revoked/deleted in
repeatable provider-backed tests.

## Phase 3 — Durable workspace record, checkpoints, and recovery

### Ordered record

- [ ] Add versioned records for chats, messages, turns, agent sessions, run
      state, workspace metadata, settings snapshots, presence eligibility, and
      monotonic stream revisions.
- [ ] Implement idempotent engine write-through, transactional outbox delivery,
      exact-key snapshots, bounded catch-up, gap detection, and tombstones.
- [ ] Keep the engine as live sequencer; clients never independently merge
      turns or promote cached state.
- [ ] Add immutable usage ingestion beside, not inside, transcript rows.

### Working-tree durability

- [ ] Add `workspace_content_revisions`, current file-manifest projection,
      ordered file events, checkpoints, and tenant-scoped encrypted blob
      references with bounded sizes and reference/deletion accounting.
- [ ] Checkpoint the Git remote/base commit plus selected staged, unstaged, and
      untracked work. Default-exclude ignored and secret-like files, and record
      exact inclusion policy/provenance.
- [ ] Treat provider snapshots/volumes as startup optimizations only. Rebuild a
      fresh execution from Git, object-store checkpoint, settings version, and
      durable event record.
- [ ] Implement encryption-key rotation, export, retention, legal hold if
      required, deletion propagation, backups, and tested restore.

### Degraded-state behavior

- [ ] Measure durable-write/checkpoint lag and block authority movement when the
      final checkpoint is not durable.
- [ ] Retain last confirmed exact-key snapshots while revalidating; show stale,
      read-only, durability-degraded, or restore-failed states honestly.
- [ ] Reconcile provider, database, object-store, engine, and Git observations
      without assuming a timed-out operation failed.

Exit: disaster-recovery tests reconstruct representative clean and dirty
workspaces in a fresh provider resource and prove tenant isolation, event/blob
deduplication, revision-gap recovery, backup restore, key rotation, and deletion
without the original sandbox or any Mac replica.

## Phase 4 — Desktop parity, movement, sync, and Design

### Client and UI architecture

- [ ] Replace the renderer's process-global active bridge assumption with an
      exact execution-keyed connection registry that can serve the cloud engine
      and a local terminal/replica helper without cross-workspace leakage.
- [ ] Add authenticated remote negotiation, reconnect, bounded resume,
      generation/authority-epoch validation, stale-state retention, and clear
      protocol mismatch handling.
- [ ] Reuse the current workspace shell, chats, diff, Git, terminal, browser,
      Design, and PR surfaces. Placement changes routing/availability metadata;
      it does not create a parallel Cloud UI.
- [ ] Add the three-step create flow: tenant, repository, and `This Mac`/
      `Cloud`, with effective settings preview and only relevant advanced
      choices.
- [ ] Add workspace details for lifecycle, resources, settings generation,
      authority, local-copy health, SSH, ports, and recovery.

### Design and terminal parity

- [ ] Route Design reads and exact-revision transactions to the authoritative
      engine. Keep the canvas/DOM renderer on the Mac; keep authored writes and
      filesystem CAS/write locks in the cloud sandbox when cloud is authority.
- [ ] Proxy Design resources through short-lived purpose-bound grants without
      exposing arbitrary sandbox paths or provider preview credentials.
- [ ] Label Cloud and Local terminals distinctly. Offer a Local terminal only
      for a healthy local authority or local replica and explain receive-only
      source behavior.
- [ ] Preserve explicit Git publish/rebase/merge/autostash semantics. Serialize
      Git mutations through the authoritative engine.

### Per-device receive-only replica

- [ ] Implement desktop device registration/key rotation and a local replica
      SQLite projection with absolute path, ignore configuration, manifest,
      cursor, divergence, and last confirmed state.
- [ ] Bootstrap from an exact checkpoint, then apply ordered cloud file events
      with content hashes, bounded staging, atomic rename, path confinement,
      symlink/type/case/Unicode/permission validation, and periodic convergence
      scans.
- [ ] Exclude `.git`, Zeros databases, credentials, sockets/devices, and
      configured cache/generated paths. Show the resolved exclusions before
      enabling sync.
- [ ] Preserve local divergence, pause only affected paths, and support explicit
      replace-from-cloud or save-as-patch/copy. Never upload or silently discard
      local source writes in Phase 5.
- [ ] Make pause, resume, relocate, and remove local-copy operations per
      user/device. Removing a directory is a separate confirmed local action.

### Placement moves and copies

- [ ] Implement local-to-cloud preflight, quiescence, selected-work checkpoint,
      idempotent provision/verify, atomic authority cutover, rollback, and the
      optional conversion of the old checkout into a local replica.
- [ ] Implement cloud-to-this-Mac handoff only for an eligible owner/manager
      with no collaborator/agent/PTY/Design/Git activity and healthy durability.
      Preserve tenant; suspend multiplayer; revoke cloud writes and stop/archive
      the sandbox after local verification.
- [ ] Implement Make local copy/Make personal copy as new identities with
      explicit tenant choice, history/export policy, and no hidden ownership
      change.
- [ ] Add crash recovery for every placement-intent phase. Startup reconciliation
      must prove which epoch is authoritative before enabling mutation.

### Ports and external tools

- [ ] Add Open via SSH actions backed by on-demand grants and safe local SSH
      configuration/command generation.
- [ ] Add engine-observed ports, authenticated browser preview, and desktop-owned
      `127.0.0.1` forwarding with collision-free local-port selection and exact
      remote-to-local mappings.
- [ ] Make port-forward state per user/device and close/re-authorize on app exit,
      membership loss, ownership transfer, workspace stop, or generation change.

Exit: UI smoke, protocol, preload/Electron, and race tests cover exact-workspace
and exact-execution isolation, A → B → A restoration, stale responses, hidden
surface inertness, reconnect gaps, Design CAS, destructive confirmations, all
move failure phases, local divergence, path attacks, SSH revocation, and port
mapping collisions. A full desktop E2E run proves the same normal workflow in
local and cloud placement.

## Phase 5 — Single-member production launch and operations

### Product launch

- [ ] Enable Personal cloud only after its forward migration, single-member
      authorization, owner billing/quota, provider connection, export/deletion,
      and all Phase-4 acceptance tests pass.
- [ ] Enable Organization cloud in single-member mode: only the creator/owner
      may connect or sync until the Organization passes the Phase-6A gate.
- [ ] Add authorized web management for lifecycle, repository/environment
      profiles, provider connections, settings generations, quotas, usage,
      checkpoints, exports, and deletion. Web and desktop use the same APIs.
- [ ] Add onboarding, setup/retry/recovery guidance, owner-visible cost, idle and
      maximum-lifetime policy, and explicit local/cloud privacy explanations.

### Operations and self-hosting seams

- [ ] Add dashboards/alerts for setup and lifecycle latency, provider drift,
      orphans, grant abuse, protocol mismatches, durable-write lag, checkpoint/
      restore failures, replica errors, usage ingestion, and deletion backlog.
- [ ] Run incident, provider outage, restore, rollback, object-store loss,
      database point-in-time restore, encryption-key rotation, provider-key
      rotation, and regional recovery exercises.
- [ ] Keep identity issuer/JWKS, provider, PostgreSQL, object storage, queue/cache,
      encryption, and public/private endpoints configurable for a future Railway
      template and customer-managed data plane.
- [ ] Produce versioned migrations, health checks, backup/restore commands, and
      upgrade/rollback documentation usable by the hosted deployment first.
- [ ] Complete privacy, security, abuse, support, capacity, cost, and signed/
      notarized desktop release reviews.

Exit: a Personal user and an Organization owner can create locally or in cloud,
use the same normal UI, edit Design with sandbox-authoritative writes, reconnect,
stop/wake, use SSH/preview/localhost forwarding, move authority in both eligible
directions, enable/disable a local replica, and recover/export/delete the
workspace. Desktop/web agree on exact authorized state, and operators can detect
and recover every supported failure. Only after this exit is Phase 5
`seamless`.

## Phase 6A — Organization multiplayer (partial Phase 6)

### Shared workspace behavior

- [ ] Enable workspace roles for viewer, prompter, developer, manager, and owner;
      authorize every connection and mutation against current Organization,
      Team, workspace, lifecycle, and generation state.
- [ ] Add presence, typing, shared live transcript/agent output, followers,
      direct links, and multiple chats without client-side turn merging.
- [ ] Keep one cloud engine as source/Git/chat sequencer. Concurrent Git/source
      mutation and Design operations retain exact revision/lease behavior; do
      not imply CRDT editing.
- [ ] Make every local replica a distinct user/device binding. Prove one
      member's pause/remove/offline/divergence cannot change another replica or
      cloud authority.
- [ ] Add per-role SSH, terminal, agent, Design, preview, forward, checkpoint,
      export, and lifecycle permissions with immediate revocation.

### Assignment, ownership, and cost

- [ ] Implement Reassign as responsibility only; preserve workspace owner,
      provider binding, and billing epoch.
- [ ] Implement accepted ownership transfer with a cutover checkpoint, new
      billing epoch, new agent/provider/secret bindings, and new cloud generation
      where required. Past usage remains charged to its snapshotted old owner.
- [ ] Attribute every cloud and agent usage event to the billing owner/epoch
      active when work was accepted, while retaining the member actor for audit.
- [ ] Freeze new paid work when owner credentials/quota are revoked or the owner
      leaves, until a valid transfer or owner recovery completes.

### Multiplayer qualification

- [ ] Test simultaneous observers/prompters, shared terminal policy, agent
      steering/cancellation, reconnect/gaps, membership/role changes, invite
      races, owner departure, transfer acceptance/failure, device loss, direct
      links, and audit/usage ordering.
- [ ] Test two or more members syncing different Macs, independent local paths,
      pause/remove/reconnect, offline workspace deletion, local divergence, and
      revocation without remote-erasure claims.
- [ ] Test that Move to this Mac is blocked while another member is active and
      that Make local/personal copy enforces export and destination policy.

Exit: multi-client authorization, presence, ordering, replica isolation,
revocation, ownership, and billing tests pass in production-like environments.
Organization multiplayer can then be enabled independently of mobile clients.

## Explicitly deferred after Phase 6A

- native iOS and Android applications;
- automatic bidirectional cloud/local file synchronization;
- CRDT/OT collaborative source editing and collaborative Design canvas editing;
- provider-to-provider live migration;
- UDP, public ports, custom preview domains, and Organization-wide port shares;
- offline local authority election or peer-to-peer replicas; and
- advertising a customer-managed Railway template before install, migration,
  upgrade, backup/restore, key management, and security procedures are tested.

## Roadmap retirement

Do not delete this roadmap merely because development started. When every item
is implemented, rejected with rationale, or moved to another owned roadmap,
move lasting contracts into the durable cloud-workspace documents and replace
this file with a concise shipped-status and verification record.
