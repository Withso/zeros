# Cloud workspace data, copies, and sync

This document defines the product and engineering contract for creating a
Zeros workspace locally or in cloud, making integrity-checked copies between
those placements, and keeping private device replicas. Migrations `0026`
through `0062` and the desktop engine services implement the non-UI
foundation. End-user wiring and protected live qualification remain separate
release work.

## The three independent dimensions

Do not encode ownership, immutable workspace placement, and replication in one
`location` field. They answer different questions:

| Dimension           | Values                                                      | Meaning                                                                                    |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tenant ownership    | Personal or Organization/Team                               | Who owns policy, repository access, retention, and the workspace record                    |
| Workspace placement | This Mac or Cloud                                           | Where this workspace's single authoritative engine is created; it does not change in place |
| Device replica      | Off, Syncing, In sync, Paused, Diverged, Detached, or Error | Whether one member's device has a private local mirror of a cloud-authoritative workspace  |

Local placement does **not** imply Personal ownership. An Organization workspace
may be created on one member's Mac and inherit Organization repository policy
while its files, chats, paths, processes, and terminals remain private to that
device. Cloud placement does require Organization ownership; Personal
workspaces are permanently device-local.

This separation produces three valid creation combinations:

| Tenant       | Runs on this Mac                                         | Runs in cloud                                                             |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Personal     | Private local workspace                                  | Not supported                                                             |
| Organization | Organization-governed but device-private local workspace | Single-owner cloud workspace in Phase 5; member collaboration is Phase 6A |

## Sources of truth

| Data                                                                                                | Live authority                      | Durable authority                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Repository content                                                                                  | Authoritative engine/working tree   | Configured Git remote plus explicit encrypted checkpoints for uncommitted recovery |
| Never-cloud local workspace identity and runtime metadata                                           | Local engine                        | Device SQLite                                                                      |
| Cloud workspace identity, tenant/team, creator, billing owner, assignee, generation/authority epoch | Control plane                       | Control-plane database                                                             |
| Local replica path and device-only overrides                                                        | Desktop replica broker/local engine | Device SQLite/OS credential store; never the cloud record                          |
| Replica desired state, health, and cursors                                                          | Desktop broker + cloud engine       | Tenant-scoped control-plane record                                                 |
| Chat, turns, agent sessions, run state, and recoverable workspace metadata                          | Running engine while active         | Durable cloud record                                                               |
| Presence and transient UI state                                                                     | Active client/engine session        | Not durable unless explicitly promoted to a product preference                     |
| Secrets                                                                                             | Narrow runtime credential boundary  | Approved server secret store or user OS credential store; never the transcript     |

The execution environment is disposable. It may cache durable data, but it must
not be the only location from which a user can recover workspace identity,
history, or committed code.

## User-facing model

Workspace creation asks only three primary questions:

1. **Where does this belong?** Personal or an Organization/Team.
2. **Which repository?** One repository identity, not separate Local and Cloud
   repository records.
3. **Where should it run?** This Mac or Cloud.

Advanced environment and resource choices stay collapsed unless the selected
repository has no usable default. The workspace UI then shows a placement badge
(`This Mac` or `Cloud`) and, for cloud workspaces, a separate `Local copy`
status. Do not use a single ambiguous `Local` status for both.

The workspace-details actions use verbs that state their consequence:

- **Create cloud copy** forks a new cloud workspace and retains the local
  source.
- **Create local copy** forks a new private local workspace and retains the
  cloud source.
- **Sync to this Mac** creates or resumes the owner's receive-only local
  replica; cloud remains authoritative.
- **Pause sync on this Mac** affects only that replica and leaves its files on
  disk.
- **Remove local copy** affects only that replica and requires explicit
  confirmation before deleting its directory.
- The destination tenant is selected explicitly. Copying Organization-owned
  work to Personal is a policy-checked export, never an implicit side effect of
  choosing a Mac path.

`Detached` is not another paused state: the local bytes remain on disk, but the
replica identity has no live authority or grant. A replica paused only for an
approved destination relocation may obtain fresh authorization and transition
back through `Syncing`. Detachment caused by workspace deletion, membership or
device revocation, or a replica tombstone can never reactivate the original
replica identity; the member may remove the retained local copy or create a
separately authorized new fork.

Routine remote editing uses **Open via SSH**. A local copy is an independent
workspace, not a way to make one Mac authoritative for the cloud source.

## Ownership and collaboration rules

- A workspace has immutable `created_by`, mutable `owner_user_id`, and mutable
  `assignee_user_id` fields. Creator, billing owner, and current assignee are
  not aliases.
- Reassigning responsibility changes `assignee_user_id`; it does not silently
  change billing, provider credentials, or ownership.
- Transferring ownership is a separately accepted operation. It starts a new
  billing epoch and may require a cloud checkpoint and reprovision under the
  new owner's provider connection.
- A Personal workspace has exactly one authorized member and cannot enable
  presence, followers, shared chat, or member replicas.
- An Organization-local workspace remains visible only to its creator by
  default. Organization policy can govern it, but the server must not imply
  that locally stored source or chat is shared.
- A never-cloud Personal workspace needs no server workspace record. A never-
  cloud Organization workspace may fetch and cache authorized Organization/
  repository policy without publishing its source, chat, absolute path, or
  process state. If Organization policy requires a minimal placement audit
  registration, disclose that before creation and store only identity/policy
  metadata.
- A Phase 5 Organization cloud workspace is single-owner: Organization
  membership alone does not grant runtime, replica, access, export, or
  lifecycle authority. Member collaboration and role-based workspace access
  are deferred to Phase 6A.
- Forking an Organization cloud workspace to one Mac does not suspend or
  modify the source. The destination is a new local workspace in Personal or an
  authorized Organization, subject to export and destination-creation policy.
- A local Organization copy remains Organization-owned. Its new source, chats,
  paths, and processes are private to that device unless a later explicit
  cloud-copy operation exports selected state into another new workspace.

## Repository and settings model

### One repository, placement-aware profiles

A repository is identified by a stable forge repository identifier plus tenant,
not by a Mac path, owner/name pair, or clone URL. A repository rename, transfer,
or different local checkout path must not create a second repository record.
The device database maps the stable repository ID to its local root path.

The repository settings surface has three sections:

1. **Shared** — repository identity, Git defaults, prompts, non-secret scripts,
   and policy that applies in both placements.
2. **Local** — shell/toolchain behavior, Mac-only script variants, local file
   inclusion, and references to secrets held in that member's OS credential
   store.
3. **Cloud** — environment generation, compute profile, cloud setup/run
   variants, network policy, cloud secret/MCP bindings, and provider connection.

The user should not create duplicate Local and Cloud repository entries. A run
or setup action may declare `local`, `cloud`, or both. The UI previews the
effective value and labels its provenance, such as `Organization Cloud`,
`Repository Shared`, `Only this Mac`, or `Managed policy`.

### Resolution and snapshots

Non-secret settings resolve from weakest to strongest:

```text
built-in defaults
  < user's placement defaults
  < Organization shared and placement defaults
  < repository shared settings
  < repository placement profile
  < workspace override
  < Organization managed policy
```

An Organization policy may reject a lower-layer value even when it does not
replace it. The resolver returns both the effective document and per-leaf
provenance. Critical policy, lifecycle, authorization, billing, and resource
fields remain normalized columns; do not hide them inside a generic settings
blob or EAV table.

`.zeros/settings.toml` remains the reviewable repository-shared layer.
`.zeros/settings.local.toml` remains device-private and is never uploaded to the
control plane, sandbox, checkpoint, or another member. Cloud-only private
settings live in the cloud settings service rather than pretending to be the
same local file.

Cloud creation, fork import, and every explicit rebuild record an immutable, redacted
settings snapshot and environment-profile version. Editing Organization or
repository Cloud settings affects new generations; an existing workspace shows
`Update available` and changes only after **Apply and rebuild**. Current managed
security policy is always enforced and is not frozen into an old permissive
snapshot.

An Organization-local engine caches the last verified policy snapshot for
offline use and labels it stale. Managed policy may set a maximum offline age.
Membership loss immediately revokes server settings/secrets and marks the local
workspace detached from Organization services; it never silently converts
Organization data to Personal ownership.

### Environment, MCP, and secrets

A user's Personal placement defaults may seed an Organization workspace only
through explicit, policy-approved inheritance. Never copy a Personal secret
value into an Organization document.

- Share non-secret environment names and values as normal settings.
- Store secret values only in an approved OS or server-side secret store.
- Persist opaque `secret_binding_id` references with scope, purpose, owner, and
  rotation metadata; never persist a secret in a settings snapshot or event.
  Persisted equality verifiers are domain-separated HMACs tied to the binding
  identity and encryption-key version, never raw value hashes.
- Organization MCP definitions may share names, commands/URLs, capabilities,
  and policy. Authentication headers, OAuth tokens, and environment values use
  separate bindings.
- User-delegated MCP identity is resolved per actor when the MCP protocol
  supports it. Workspace service credentials are resolved from an approved
  Organization or billing-owner binding and are never revealed to members.
- Ownership transfer is deferred to Phase 6A. Its persisted model already
  identifies owner-scoped bindings; the accepted workflow must invalidate and
  replace them before a new cloud generation can become ready.

## Authority and revision model

A workspace has exactly one current authoritative execution lease. The lease is
identified by workspace, placement generation, engine instance, epoch, and
expiry. Every source, Git, chat, terminal-control, and Design mutation carries
that epoch and an idempotency key. A stale cloud generation fails closed after
replacement, delete, membership revocation, or ownership transfer.

The running authoritative engine is the live sequencer. The durable record
stores acknowledged revisions, checkpoints, and events for recovery. A client
or replica never elects itself authoritative because the network is offline.

Every durable stream is scoped by stable tenant, workspace, semantic owner, and
authority-epoch identifiers. Events use monotonic revisions or explicit
ordering tokens; timestamps are metadata, not conflict resolution. Writes are
idempotent, consumers apply ordered events only after an exact-revision
snapshot, gaps trigger bounded catch-up or a new snapshot, and deletion or
membership tombstones outrank late events.

Git and file synchronization are different layers:

- Git remote plus explicit checkpoints are the durable code/review boundary.
- The file stream makes an exact working tree available without forcing a
  commit.
- `.git` is never synchronized. Each authoritative checkout owns its Git
  metadata. A receive-only replica does not advertise itself as a safe place to
  commit.
- Git index/worktree mutations are serialized through the authoritative engine
  with a workspace-scoped lease.

## Durable object-storage admission

The 64 MiB per-object ceiling is not a cumulative capacity control. Before
publishing any object, the coordinator therefore reserves durable bytes in the
same PostgreSQL transaction that establishes the tenant blob identity. One
Organization-scoped advisory boundary serializes uploads, reference accounting,
copy-on-write key rotation, and owner limit changes.

Two independent counters apply:

- the Organization counter measures physical tenant-deduplicated blobs in
  `pending_upload`, `available`, `quarantined`, or `deleting` state, plus bytes
  reserved for a second ciphertext during key rotation; and
- the workspace counter measures logical unique `(workspace_id, blob_id)`
  reservations, regardless of whether another workspace reuses the same
  tenant blob.

A retry or duplicate upload of the same tenant/workspace/hash refreshes the
existing reservation instead of charging again. A successful immutable
reference promotes the upload reservation to a non-expiring referenced row.
Deleting the last `workspace_blob_references` row for one
`(workspace_id, blob_id)` releases that workspace's corresponding
`workspace_blob_storage_reservations` row and logical `reserved_bytes`; it does
not release the Organization physical charge, which remains until physical
collection succeeds. Interrupted uploads receive a 24-hour recovery lease that
a retry refreshes. If another workspace still has an immutable reference to an
available deduplicated blob, maintenance can expire only the abandoned
workspace's logical reservation; the shared physical blob remains charged to
the Organization. A unique abandoned upload keeps both its logical reservation
and Organization physical charge until physical collection succeeds.
Maintenance also repairs stale reference reservations, reconciles reference
counts, and applies the existing age/retention/legal-hold garbage-collection
rules.

Key rotation reserves one additional physical object before writing the target
ciphertext. A failed or crashed attempt keeps that reservation for a safe retry;
success deletes the source and releases the duplicate-byte allowance. Missing
Organization limits fail closed, and limits are never inferred from sandbox
disk allocation or the object-store provider's volume size. The per-workspace
logical ceiling cannot exceed the Organization physical ceiling.

## Phase-5 local replica contract

The first production sync mode is **cloud-to-device, receive-only, safe**:

1. Each authorized user/device pair has its own replica identity, grant,
   desired state, cursor, local path, and health. Phase 5 authorizes only the
   owner; Phase 6A may admit additional members. No Organization-wide
   `sync_enabled` boolean exists.
2. Initial sync downloads an exact checkpoint manifest, then applies ordered
   file events after that manifest revision.
3. Files are staged to a private temporary path, verified by content hash, and
   atomically renamed. Watchers reduce latency; bounded periodic scans prove
   convergence.
4. Paths are normalized and confined beneath the replica root. Symlink type and
   target policy, executable bits, Unicode normalization, case collisions, file
   size, entry count, total bytes, and unsupported special files are validated
   before apply.
5. `.git`, Zeros state databases, credentials, sockets, device files, and
   configured generated/cache paths are excluded. Ignore rules and their
   resolved version are visible before sync starts.
6. Cloud changes never silently destroy unsynchronized local source changes.
   A changed protected path enters `diverged`; Zeros preserves the local bytes,
   pauses that path, and offers **Save as patch/copy** or **Replace from cloud**.
7. Generated or ignored local artifacts may be changed by local commands and
   are never uploaded.
8. Pausing one replica revokes only that replica's live grant. The owner's other
   devices, cloud agents, terminals, previews, and replicas continue normally.

The deferred UI may offer a Local terminal only when that device has an
`In sync` or `Diverged` replica. Its tab must be visibly marked `Local`; a
Cloud terminal is marked `Cloud`. The local terminal is useful for Mac-only
tools and local dev servers, but source writes do not flow back. Use the Cloud
terminal/SSH to change authoritative files, or create an independent local
copy. This limitation must be stated in the terminal tooltip and first-run
explanation.

Automatic bidirectional synchronization is not part of Phase 5 or Phase 6A.
If added later, it requires a separately reviewed three-way reconciliation
protocol based on a last-agreed manifest, per-file base revisions, durable
conflicts, deletion tombstones, and multi-device tests. Timestamp-based
last-writer-wins is prohibited.

## Copy and sync workflows

### Create a cloud workspace from local

1. **Preflight:** choose the destination Organization tenant, resolve a
   verified repository identity, authorize cloud creation, and validate
   provider connection, paid entitlement, quota, settings, paths, exclusions,
   symlink/case portability, and bounded snapshot size.
2. **Identify:** allocate a new target cloud UUID. The source local UUID and
   checkout remain unchanged.
3. **Capture:** scan a stable Git base plus the selected working-tree overlay.
   Stage file blobs and optional portable chat records locally; never include
   `.git`, device settings, credentials, sockets, or secret-like files.
4. **Reserve and upload:** create an idempotent fork intent bound to the
   expected source snapshot. Reserve each deduplicated encrypted blob and the
   aggregate quota transactionally before object publication.
5. **Seal:** stage bounded entries/records, recompute the canonical snapshot,
   and create the destination's first durable checkpoint only when the expected
   digest matches.
6. **Start:** the normal cloud setup worker restores that checkpoint, applies
   the selected cloud settings snapshot, starts the engine, and verifies
   readiness.
7. **Recover:** every step is replayable. A mismatch or expired 24-hour staging
   deadline fails the destination fork and releases staging references. It
   never deletes, archives, stops, or mutates the local source.

The destination tenant is explicit. A Personal source may fork to an
Organization when the actor may create there; an Organization source may fork
to Personal only when export policy permits it.

### Sync or download a cloud workspace

**Sync to this Mac** creates a device replica and does not change authority.
Phase 5 permits the workspace owner; Phase 6A may let each Organization member
create a separate replica when their role and policy allow it. The local
absolute path remains only in that device's SQLite database; the server stores
at most a user-chosen label and the state needed for authorization and
recovery.

**Make a local copy** bootstraps the same code/checkpoint into a new workspace
ID. Chat/history copying is a separate, policy-controlled option. Copying
Organization data into Personal requires explicit confirmation and may be
disabled by Organization export policy.

### Create a local workspace from cloud

This is a copy, not an authority handoff:

1. The owner requests an idempotent cloud-to-local fork with a fresh target
   local UUID and optional chat-history selection.
2. The control plane requires current account, tenant, Team, workspace-owner,
   and device proof. Existing durable data remains exportable after paid
   compute cancellation, but membership and owner authority remain mandatory.
3. The checkpoint worker pins the last durable file manifest and record
   revision without stopping the source cloud engine.
4. A short-lived, one-use, device-key-version-bound export grant pages the
   canonical manifest/records and fetches only referenced encrypted blobs.
5. The desktop stages bytes beneath a private job root, verifies every hash,
   path, type, size, Git identity, and snapshot digest, then atomically
   materializes the new local workspace and imports selected portable records.
6. Replay resumes from durable local job state. Any partial target is preserved
   for diagnosis or removed by an explicit cleanup; the cloud source and the
   owner's other sessions and devices are unaffected.

The cloud owner may later archive or delete the source through its normal
lifecycle controls. That decision is not part of the copy transaction.

## Deferred Phase 6A multiplayer replica behavior

The following is a Phase 6A design contract, not current Phase 5 behavior. Once
Organization-member collaboration is implemented, the cloud engine remains
authoritative for every admitted member:

```text
                         cloud engine
                 source / Git / chat sequencer
                      revision 1842
                       /          \
        member A, device 1      member B, device 7
        replica cursor 1842     replica cursor 1839
        In sync                 Syncing
```

Member A pausing or deleting their replica changes only the A/device-1 binding.
Member B continues from its own cursor. Removing a member or revoking a device
revokes all matching replica and endpoint grants; it cannot promise remote
erasure of bytes already downloaded, so policy and UI must state that boundary.

Presence and shared chats are sequenced by the cloud engine/durable event
stream, not by the file synchronizer. Collaborative source or Design editing is
a separate feature. Phase 6A may allow many observers/prompters and multiple
agent chats, while retaining one engine-owned Git/source mutation lane and the
Design API's exact-revision transactions.

## SSH, previews, and forwarding to the Mac

SSH and port access are per actor and revocable:

- **Open via SSH** requests a short-lived workspace/generation/account-bound
  grant only after current membership and role checks. The desktop can open
  Cursor/another supported IDE, open Terminal, or copy a generated SSH command.
- Do not store a reusable provider SSH token in renderer state, URLs, logs, or
  the database. Store only a verifier/digest and audit issuance/revocation.
- **Open Preview** uses an authenticated provider/control-plane proxy. Prefer a
  separate header token; create a signed URL only for an explicit time-limited
  share action.
- **Forward to this Mac** starts a desktop-owned tunnel from a sandbox port to
  an available `127.0.0.1` port. It never binds `0.0.0.0` by default. The local
  port may differ and the UI shows the exact mapping.
- Forward state is per user/device. Stopping one member's forward does not stop
  the sandbox service or another member's forward.
- The client may restore a requested mapping after reconnect only by obtaining
  a fresh grant. Workspace stop, ownership transfer, membership loss, device
  revocation, or app exit closes the tunnel.
- Start with authenticated HTTP previews and TCP-over-SSH forwarding. UDP,
  public ports, custom domains, and Organization-wide shares are separate
  policy surfaces.

## Design workspace behavior

When cloud is authoritative, the Design canvas and renderer remain on the Mac,
but every authored mutation goes through the versioned Design API served by the
cloud engine. The mutation carries the exact source revision; the cloud engine
performs the sandbox filesystem CAS/write lock and returns a receipt. The local
replica updates only after that authoritative write appears in the file stream.

The canvas never writes directly into the synced folder. A future Design agent
uses the same cloud Design API. An independently forked local workspace uses its
own local engine/Design API and does not share the cloud workspace identity.

## Durable data model

The main implemented relations are below. Exact SQL names in migrations
`0026`–`0062` are compatibility contracts.

| Relation                                                          | Purpose and important constraints                                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositories`                                                    | Stable tenant + forge repository identity; unique on tenant/forge/provider-repository ID; rename-safe                                                                        |
| `repository_device_paths`                                         | Device-local stable repository ID to canonical path mapping; SQLite only                                                                                                     |
| `repository_settings_versions`                                    | Immutable schema-versioned Shared/Local/Cloud non-secret documents with creator and provenance                                                                               |
| `environment_profiles` / `environment_profile_versions`           | Named Personal or Organization placement profiles and immutable build inputs                                                                                                 |
| `provider_connections`                                            | User/Organization-owned encrypted Daytona or future provider binding; no raw credential in workspace rows                                                                    |
| `secret_bindings`                                                 | Opaque secret-store references scoped by tenant, owner, purpose, placement, and rotation version                                                                             |
| `cloud_workspaces`                                                | Cloud UUID, non-Personal Organization/team/repository, creator, owner, assignee, visibility, single-member flag, authority/billing epochs, lifecycle, and optimistic version |
| `cloud_workspace_members`                                         | Explicit workspace role/following/presence eligibility; membership is always bounded by Organization/Team membership                                                         |
| `workspace_settings_versions`                                     | Redacted effective snapshot, source versions, environment profile, and policy version used by one workspace generation                                                       |
| `workspace_executions`                                            | Append-only cloud execution projections; at most one current execution for an authority epoch                                                                                |
| `cloud_workspace_generations`                                     | Pinned image/resources/source commit/settings snapshot for cloud execution; extends the existing generation contract                                                         |
| `cloud_workspace_provider_bindings`                               | Opaque provider resource observed state keyed by provider connection and generation                                                                                          |
| `devices`                                                         | Per-user public-key identity, trust/revocation state, platform, and last-seen metadata                                                                                       |
| `workspace_replicas`                                              | Workspace + user + device binding, mode, desired/observed state, authority epoch, checkpoint and event cursors; one live binding per tuple                                   |
| `workspace_replica_events`                                        | Bounded state/error history for diagnosis; no absolute local path or source bytes                                                                                            |
| `workspace_content_revisions`                                     | Monotonic engine sequence and parent/checkpoint identity                                                                                                                     |
| `workspace_file_entries`                                          | Current manifest projection: normalized relative path, type, mode, content hash, size, revision, tombstone                                                                   |
| `workspace_file_events`                                           | Idempotent ordered changes used for catch-up; payload refers to encrypted object blobs                                                                                       |
| `workspace_checkpoints`                                           | Git base/ref plus encrypted manifest/artifact reference, reason, author, integrity state, and retention                                                                      |
| `workspace_blobs`                                                 | Tenant-scoped content-addressed encrypted objects with reference accounting and deletion state                                                                               |
| `cloud_workspace_object_storage_limits`                           | Owner-managed Organization physical-byte and per-workspace logical-byte admission limits, separate from provider disk quota                                                  |
| `cloud_workspace_object_storage_limit_changes`                    | Immutable database-owner evidence for target-bound durable-storage limit changes                                                                                             |
| `cloud_workspace_entitlement_changes`                             | Immutable database-owner evidence for target-bound Organization entitlement and active-seat changes                                                                          |
| `workspace_blob_storage_reservations`                             | Deduplicated workspace/blob upload or referenced-byte ledger used for cumulative admission and crash recovery                                                                |
| `workspace_fork_intents`                                          | Idempotent local→cloud/cloud→local copy identity, source/target UUIDs, selection flags, deadline, snapshot/checkpoint provenance, and outcome                                |
| `workspace_fork_import_entries` / `workspace_fork_import_records` | Bounded immutable staging for file overlays and optional portable chat records; blob reservations use `workspace_blob_references`                                            |
| `workspace_ports`                                                 | Engine-observed sandbox listeners and health, never an unauthenticated public endpoint                                                                                       |
| `port_forward_sessions`                                           | Actor/device/remote/local mapping, bind address, grant, expiry, and observed status                                                                                          |
| `cloud_workspace_ownership_transfers`                             | Deferred Phase 6A offer/accept/cancel state; old/new owner and optimistic workspace version                                                                                  |
| `usage_events`                                                    | Immutable provider/agent usage with actor, billing-owner snapshot, billing epoch, source idempotency key, quantity, and timestamps                                           |
| `outbox_events`                                                   | Transactional publication of lifecycle, sync, audit, usage, and notification events                                                                                          |

Normalize authorization, ownership, lifecycle, billing, grants, provider
bindings, and cursors. JSONB is appropriate for bounded versioned settings,
provider observations, and redacted event metadata; it is not a substitute for
foreign keys or queryable security state.

Every tenant relation carries `org_id` (including Personal's tenant shell for
relations that support local Personal ownership), while cloud workspace rows
require a non-Personal Organization. Tenant relations use composite foreign
keys where that prevents cross-tenant references.
Application authorization and forced row-level security both apply. Background
workers set an explicit system/tenant context. Mutations use optimistic version
checks or row leases, idempotency keys, and a transactional outbox. Large file,
checkpoint, transcript artifact, and log payloads live in encrypted object
storage rather than PostgreSQL rows.

Human-readable workspace IDs and path-derived repository IDs are not safe cloud
identities. Desktop fork state allocates UUID destinations and preserves
released local IDs only as local compatibility data. Public API routes never
expose provider resource IDs.

## Restore and data lifecycle

Restore must be repeatable into a fresh environment:

1. Authorize the actor and resolve the stable workspace record.
2. Restore or clone the repository at its recorded Git identity.
3. Apply an approved uncommitted-work checkpoint, if one exists.
4. Initialize the engine schema and restore durable chats, turns, sessions, and
   workspace metadata through versioned migrations.
5. Start the bridge and publish readiness only after integrity checks pass.
6. Let clients reconcile from the returned exact revision.

A provider snapshot can accelerate startup, but the product needs a documented
recovery path when that snapshot is corrupt, expired, or unavailable.

Local and cloud workspaces are not bidirectionally merged. “Create cloud from
local” and “create local from cloud” produce new identities through the fork
protocol. Neither operation deletes, re-owns, stops, or silently retargets the
source. A receive-only replica is the only continuous cloud-to-device file
flow, and it never uploads local source changes.

- Document retention separately for active, stopped, archived, and deleted
  workspaces.
- Make export and deletion available at the same semantic workspace boundary.
- Encrypt data in transit and at rest, and document which operator roles can
  access each store.
- Backups need tested restore procedures, retention limits, and deletion
  propagation. A backup existing is not evidence that restoration works.
- Keep analytics, diagnostics, and billing data minimized and separate from
  source content and prompts.
- PostgreSQL stores ordered metadata, references, current projections, and
  small bounded events. Encrypted object storage holds file blobs, checkpoints,
  transcript artifacts, and full logs; a sandbox or Mac replica is never the
  only durable copy.

## Required edge-case behavior

- Two devices choose the same local destination: reject before writing unless
  it is the same replica identity and an exact safe resume.
- A case-sensitive cloud tree cannot materialize on a case-insensitive Mac:
  block with the exact conflicting paths; do not choose a winner.
- A cloud file becomes a symlink or changes type: validate the complete parent
  chain and apply atomically without following an untrusted link.
- A device sleeps mid-apply: resume from the last acknowledged event after
  verifying the last applied manifest; do not trust a watcher cursor alone.
- A local terminal changes a source file: preserve it as divergence and stop
  applying that path until the member chooses an outcome.
- A member disables sync: revoke only that replica; leave other replicas and
  cloud execution untouched.
- A member leaves or a device is lost: revoke grants immediately, tombstone the
  replica, and disclose that already-downloaded local bytes cannot be recalled.
- A workspace is deleted while a replica is offline: deletion tombstone outranks
  late events; the returning device becomes `Detached`, never authoritative.
- Ownership transfers across provider accounts are Phase 6A work: checkpoint
  and reprovision; changing an owner column alone is forbidden.
- A fork request times out: replay the same idempotency key and source snapshot.
  Never reuse the source UUID, delete the source, or create another destination
  merely because the client timed out.
- Cloud is unreachable: retain the last confirmed files and Git snapshot, mark
  them stale/read-only, and never promote the local replica automatically.

## Acceptance matrix

Before Phase 5 can be called seamless for a single member, automated and
end-to-end tests cover:

- Personal local and Organization local/cloud creation with exact settings
  provenance, including rejection of Personal cloud creation;
- local-to-cloud fork with clean, staged, unstaged, untracked, ignored,
  secret-like, large, symlink, executable, Unicode, and case-collision trees;
- snapshot mismatch, deadline expiry, over-quota object publication, process
  crash, and duplicate request replay;
- cloud-to-local fork while the source remains active, with degraded
  durability, device/grant replay, and ownership/policy restrictions;
- one member syncing separate trusted devices, independent
  pause/remove/reconnect, device revocation, and offline deletion tombstones;
- local divergence preservation and explicit replace/export resolution;
- exact-revision Design writes followed by local replica convergence;
- SSH expiry/revocation, Cursor/terminal launch, localhost-only port forwarding,
  mapping collisions, workspace sleep/wake, and membership loss;
- RLS and composite-FK cross-tenant attacks, stale authority epochs, grant
  replay, idempotency, outbox replay, usage deduplication, and paid-authority
  revocation;
  and
- backup/restore into a fresh provider environment without relying on the old
  sandbox or a Mac replica.

Before Phase 6A multiplayer can ship, extend the same matrix to two or more
members and prove independent device paths/cursors, role and membership
revocation, owner transfer, billing-epoch cutover, and the absence of
cross-member replica side effects.
