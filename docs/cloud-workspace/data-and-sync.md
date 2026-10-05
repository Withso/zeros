# Cloud workspace data, copies, and sync

This document defines the product and engineering contract for creating a
Zeros workspace locally or in cloud, making integrity-checked copies between
those placements, and keeping private device replicas. The append-only cloud
migration ladder and desktop engine services implement the foundation. Alpha
staff can control receive-only Mac replicas from cloud workspace details.
Protected signed-client qualification remains separate release work.

## The three independent dimensions

Do not encode ownership, immutable workspace placement, and replication in one
`location` field. They answer different questions:

| Dimension           | Values                                                      | Meaning                                                                                    |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tenant ownership    | Personal or Organization/Team                               | Who owns policy, repository access, retention, and the workspace record                    |
| Workspace placement | This Mac or Cloud                                           | Where this workspace's single authoritative engine is created; it does not change in place |
| Device replica      | Off, Syncing, In sync, Paused, Diverged, Detached, or Error | Whether one member's device has a private local mirror of a cloud-authoritative workspace  |

New device-local database workspaces belong to Personal. Organization workspaces
always use the cloud durable record, initially with managed Boat execution.
Registered Mac execution is a later capability with the same cloud ownership.
Legacy Organization-local rows and copy journals remain readable for recovery;
new Organization-local creation is rejected.

Current creation and the deferred registered-host option are:

| Tenant       | Runs on this Mac                                         | Runs in cloud                                                             |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Personal     | Private local workspace                                  | Not supported                                                             |
| Organization | Deferred registered-host execution with cloud records | Cloud authority shared according to workspace roles |

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
3. Placement follows ownership in the current release: Personal runs on this
   Mac; Organizations run on Zeros Cloud. Registered host selection is deferred.

Advanced environment and resource choices stay collapsed unless the selected
repository has no usable default. The workspace UI then shows a placement badge
(`This Mac` or `Cloud`) and, for cloud workspaces, a separate `Local copy`
status. Do not use a single ambiguous `Local` status for both.

Copy and replica actions use verbs that state their consequence. Workspace
fork/copy UI remains deferred; Alpha's internal sync controls expose the replica
actions below:

- **Create cloud copy** forks a new cloud workspace and retains the local
  source.
- **Create local copy** forks a new private local workspace and retains the
  cloud source.
- **Choose folder…** in **Sync files to this Mac** creates the authorized
  member's receive-only replica in an empty folder; cloud remains authoritative.
- **Pause** and **Resume** affect only that member/device/workspace replica.
- **Remove…** asks for confirmation, stops that replica, and keeps every
  downloaded file. Deleting the retained directory is a separate user action.
- The destination tenant is selected explicitly. Copying Organization-owned
  work to Personal is a policy-checked export, never an implicit side effect of
  choosing a Mac path.

`Detached` is not another paused state: the local bytes remain on disk, but the
device currently has no live authority or grant. When the server replica
identity remains live—for example, after an approved destination relocation or
membership/entitlement access that is later restored—it may transition back
through `Syncing` only after current authorization succeeds and a fresh grant
is issued. Workspace deletion, device revocation, or explicit replica
removal/tombstoning makes the original replica identity terminal; the member
may remove the retained local copy or create a separately authorized new fork.

SSH access is also outside the current UI phase. A local copy has an independent
identity; it does not make a Mac authoritative for the cloud source.

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
- Legacy Organization-local workspaces remain readable for recovery. Their
  historical local source and chat must not be presented as shared cloud data.
- A Personal workspace needs no server workspace record. New Organization
  workspaces always have a cloud record, including when a future registered
  Mac supplies execution. Durable Organization chat and settings stay cloud-owned.
- An Organization cloud workspace has one compute sponsor and one execution
  authority. Organization sharing, explicit member roles and accepted
  workspace-scoped guest grants determine collaborator access. Eligible members
  can attach independent device replicas; credentials and management require
  their own authority. Legacy private single-member workspaces retain owner-only
  behavior. Individual Pro and staff admission apply to each participating user.
- A future fork to one Mac does not suspend or modify the source. A fully local
  destination belongs to Personal and requires an authorized export. An
  Organization destination on a registered Mac retains a cloud-owned record
  with a new workspace identity.

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

A future registered Organization host may cache verified policy for bounded
offline use, subject to managed policy. Membership loss revokes server
settings/secrets; it never silently converts Organization data to Personal.

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
  reserved for a second ciphertext during key rotation and detached-object
  deletion tombstones' `reserved_bytes`. A tombstone releases its byte
  reservation only after physical deletion and permanent fencing succeed; and
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
rules. Migration `0098` stamps `dereferenced_at` when a blob loses its last
reference (including through a count repair) and clears it when the blob is
referenced again. Collection of a live object then waits for the deployment's
restore window (`CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS`, 48 hours by
default to match the PlanetScale backup retention that bounds point-in-time
restore), so a restore to any recoverable point still finds every object its
rows reference. Beta and Production explicitly set
`CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS=336` (14 days); the code default
remains 48 hours and the configured maximum remains 720 hours. The deployment
window must cover its approved PostgreSQL and object-backup restore horizon.
This window begins at final dereference, independently of checkpoint age.
Erasure and deletions already in flight do not wait. Key
rotation still deletes each superseded ciphertext once the new one is
authoritative: a restore to a point before a rotation finished cannot read the
blobs rotated after it, so take the restore point after the rotation, or keep
the old key and restore before rotating.

Key rotation reserves one additional physical object before conditionally
writing the target ciphertext. A failed or crashed attempt keeps that
reservation for a safe retry. The target becomes authoritative only after a
strong read-back verifies its ciphertext digest and authenticated envelope in
the expected Organization/blob context under the configured target key version.
The worker deletes and permanently fences the source, and marks the rotation
successful and releases the duplicate-byte allowance, only after that
verification and confirmed source deletion. Missing Organization limits fail
closed, and limits are never inferred from sandbox disk allocation or the
object-store provider's volume size. The per-workspace logical ceiling cannot
exceed the Organization physical ceiling.

## Receive-only local replica contract

The first production sync mode is **cloud-to-device, receive-only, safe**:

1. Each authorized user/device pair has its own replica identity, grant,
   desired state, cursor, local path, and health. Current workspace actor
   authority permits each eligible member independently. No Organization-wide
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

Directory sync is strictly cloud-to-device. Automatic bidirectional sync and
Apply-local-changes uploads are outside the product plan. Explicit workspace
copying remains a separate operation with a fresh destination identity.

### Alpha Mac controls

Cloud workspace details contains **Sync files to this Mac**, gated by
`useInternalFeatureActive("cloudComputerV2")`. Controls require the native Mac
host and an explicit `capabilities.canEdit === true`; an absent capability
fails closed. E5 owns that server-derived capability. A new replica also
requires a running workspace. Opening details or refreshing metadata never
wakes the cloud workspace.

The native folder picker only chooses a destination. It does not register a
Local project, change the selected workspace, or promote the replica to an
authoritative checkout. Downloads cover the primary repository only (ACD-3).
The UI explains receive-only behavior and the existing exclusions: `.git`,
`node_modules`, `.env` files, credential files, and private Zeros state. Existing
replicas also display their additional excluded prefixes.

Status and the local folder stay visible during revalidation. **Local changes**
lists divergent paths. **Use cloud version…** requires a second confirmation;
the existing runtime first saves local bytes under
`<root>.zeros-local-changes/<replicaId>/<detectedAt>/<path>`, then receives cloud
content. Cancel leaves the divergence intact. **Remove…** affects only the
selected replica and keeps both downloaded files and saved local changes.
**Detached** explains that the Mac has lost live sync authority and keeps its
files; it offers no resume or cloud replacement action.

All `cloudReplica.*` calls use the **Local engine**, including while a cloud
workspace is selected and has a remote engine connection. The selected cloud
organization/workspace is an RPC parameter. The additive `cloudReplica.identity`
read returns only account and enrolled device UUIDs. Scoped renderer requests
are checked against the current account/device and, for replica operations,
the exact organization/workspace; existing unscoped foundation RPCs keep their
serialized shapes. Electron retains tokens, keys, and private host proofs.

Renderer replica snapshots use the exact account UUID, sign-in generation,
device UUID, organization UUID, and workspace UUID. Enrollment metadata has an
eight-entry account cache; replica snapshots have a 32-entry / 4 MiB cache.
Pointer/focus intent and open details share read-only requests. Equal snapshots
retain their references, failed reads retain the last confirmed same-key value,
and obsolete account/connection responses cannot publish or mutate another
owner. Authentication changes clear both caches. Metadata revalidates on Local
reconnect, foreground intent, and a 15-second visible poll. Hidden or closed
controls stop polling and fence pending folder selection.

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
Each authorized member can create a separate replica when current workspace
role, entitlement and device policy allow it. The local
absolute path remains only in that device's SQLite database; the server stores
at most a user-chosen label and the state needed for authorization and
recovery.

**Make a local copy** bootstraps the same code/checkpoint into a new workspace
ID. Chat/history copying is a separate, policy-controlled option. Copying
Organization data into Personal requires explicit confirmation and may be
disabled by Organization export policy.

### Create a local workspace from cloud

This is a copy, not an authority handoff:

1. An authorized actor requests an idempotent cloud-to-local fork with a fresh target
   local UUID and optional chat-history selection.
2. The control plane requires current workspace read authority and trusted
   device proof. Guests receive exact workspace authority, never tenant-wide
   membership. Existing durable data remains recoverable by its owner after
   paid compute cancellation through the narrower data-recovery authority.
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

## Multiplayer replica behavior

The backend authorizes each replica independently. Alpha's internal Mac
controls are wired; signed-client lifecycle qualification remains open. The
cloud engine stays authoritative for every admitted member:

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
a separate feature. Multiple observers/prompters and agent chats retain one
engine-owned Git/source mutation lane and the
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

The canvas never writes directly into the synced folder. The shared
agent session uses the same cloud Design API when admitted in Design mode;
mode switching does not change cloud ownership or worker execution policy. An
independently forked local workspace uses its own local engine/Design API and
does not share the cloud workspace identity.
The [Design authoring contract](../design-mode-roadmap.md#composer-and-shared-agent-lifecycle)
owns mode selection and local-native versus cloud-API authoring. These paths
remain subject to the deployed-cloud qualification gates.

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

A provider snapshot is an optimization, not a recovery authority. If it is
corrupt, expired, or unavailable:

1. Provision a fresh provider resource. Use the still-authoritative PostgreSQL
   and object store, or first restore PostgreSQL from its approved PITR/logical
   backup and encrypted payloads from the independently retained object-store
   backup to a mutually consistent recovery point.
2. Resolve the generation's pinned durable checkpoint and verify its manifest,
   every referenced blob's Organization scope, hash, size, and encryption
   context, and the exact content and record revisions. Keep any missing or
   corrupt reference unavailable for repair instead of starting partially.
3. Clone and verify the recorded Git base, apply checkpoint deletes and upserts
   in canonical path order, then replay durable record changes after the pinned
   revision and reconcile references/reservations before garbage collection.
4. Do not publish bridge or workspace readiness until checkpoint/repository
   integrity, durable-record connectivity, and exact revision convergence pass.

Native checkpoint archives exclude proven pushed history from their local pack
but retain an immutable, shared base-pack copy of those objects. Restore verifies
the fetched commit pin when the clone is available, then verifies every archived
base/local pack and the exact recovered Git state. If the remote rewrites,
deletes or collects that base, native recovery can use a fresh initialized
repository and the archived objects instead. Working-tree-only recovery cannot
take this fallback. A missing or corrupt native chunk never permits partial
success. See [the native format](checkpoint-native-format.md) for the versioning,
shallow/index/reflog contracts and conservative full-pack capture fallbacks.

Checkpoint retention is tiered for active, stopped and archived workspaces:
keep everything from the last hour, the newest durable checkpoint per UTC hour
for 24 hours, and the newest durable checkpoint per UTC day for 14 days. The
existing `checkpoint_days` field can shorten the daily tier; its schema/default
is unchanged. Always retain the current checkpoint, every generation's
`recovery_checkpoint_id`, exports, workspace/checkpoint legal holds and unexpired
`retention_until`. Requests still needed by live lifecycle/fork intents also
protect their checkpoint. Completed delivery requests otherwise expire after
24 hours. Protected points may outlive every tier. Deleted workspaces retain
the explicit provider-erasure, tombstone and permanent-fence lifecycle, rather
than treating pruning as confirmed deletion.

Pruning removes all checkpoint manifest, projected-file and native-chunk
references, including `<checkpoint UUID>:v2`. Existing reference accounting
releases a workspace's logical reservation only after its final reference;
Organization physical bytes remain charged until object deletion and permanent
fencing succeed after the deployment's restore window. Shared immutable Git
bases remain referenced by each retained checkpoint, not by a fragile chain of
older checkpoints. Periodic unchanged-state checks create no checkpoint or
upload; manual and lifecycle operations still capture their final state.

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
- A member leaves: invalidate replica access immediately and mark the local copy
  `Detached`. The same live server replica may resume only after current
  membership/authorization is restored and a fresh grant is issued.
- A device is lost: revoke the device and its grants, make that device's replica
  identity terminal, and disclose that already-downloaded bytes cannot be
  recalled.
- A workspace is deleted while a replica is offline: the deletion tombstone
  outranks late events; the original server replica binding is terminal and
  cannot resume or become authoritative. Any retained on-disk bytes are only a
  `Detached` local copy, not a live replica.
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
  pause/remove/reconnect, device revocation, and offline deletion tombstones,
  proving a deleted workspace's replica binding cannot resume or become
  authoritative while retained bytes remain only a `Detached` local copy;
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

### Alpha signed-Mac acceptance runbook for E3

This runbook is executed by the orchestrator on Alpha after E5 and the C5, B8,
and B10 source/wake/persistence prerequisites are qualified. Chromium's
`harness-cloud-replicas.html` exercises the real controls and cache with
synthetic Local RPCs and a synthetic picker; it does not qualify a native Mac,
provider persistence, or live grants.

Preparation:

1. In the orchestrator's credentialed checkout, run `pnpm agent:check` to verify
   `.env.agent` read-only. Use its existing Alpha fixture/qualification scripts
   for provider setup and cleanup. E3 requires no direct provider API commands.
2. Use an isolated Alpha test organization, dedicated test accounts/devices,
   and two signed Alpha Macs with independently enrolled trusted devices.
   Enable **Cloud Computer v2** in Internal settings.
   Use owner/developer accounts for sync and prompter/viewer accounts to verify
   unavailable controls. Record app commit, runtime/base/template revisions,
   accepted pins, account/device IDs, and B10 qualification receipts privately.
3. Fork a sanitized Cloud Computer template through C5 into a disposable
   `zeros-v2-test-e3-<run>` workspace. Record its organization/workspace IDs and
   provider resource IDs in the private run log. Use the primary repository for
   every file fixture; secondary repositories are outside this acceptance.
4. Prepare separate empty `zeros-v2-test-e3-<run>-mac-a` and
   `zeros-v2-test-e3-<run>-mac-b` folders. Record their absolute paths. Use public
   marker text only, including in secret-like exclusion fixtures.

Execute and record each result:

| Step | Action | Required observation |
| --- | --- | --- |
| Gate and authority | Open workspace details on each Mac, then with the internal toggle disabled and with a prompter/viewer role. | The surface is absent without the staff gate. Edit controls are unavailable for `canEdit: false` or an older document without `canEdit`; the other details still work. |
| Initial download | In the Cloud terminal, create a primary `zeros-v2-test-e3-source.txt` marker. On each Mac choose its own empty folder. Record the independent replica IDs and initial/final cursors using private Local engine diagnostics. | Checkpoint download and ordered catch-up reach **In sync** with identical allowed content and different device/path bindings. An existing nonempty folder is rejected without overwriting its files. |
| Exclusions | Create harmless markers at `node_modules/zeros-v2-test-e3.txt`, `.env.zeros-v2-test-e3`, and `.zeros/zeros-v2-test-e3.txt` in the primary cloud root. Inspect both downloaded folders and the existing cloud `.git` boundary. | `.git`, dependency directories, secret-like files, and private Zeros state are absent on both Macs. Allowed source changes still arrive. Additional replica exclusions are visible when configured. |
| Cloud edits | Update the source marker twice, add another allowed marker, and delete that marker through the Cloud terminal. | Both replicas converge to the final cloud bytes and deletion in event order. Cloud remains authoritative. |
| Local divergence | Edit the source marker on Mac A, then change the same cloud path. | A preserves its local bytes and shows **Local changes** with that path; B receives the cloud version. A's edit never appears in the cloud source or B. |
| Explicit replacement | Choose **Use cloud version…**, cancel once, then confirm **Save local changes and receive cloud**. | Cancellation preserves A's divergence. Confirmation preserves its local bytes in the recorded sibling `.zeros-local-changes` backup and converges A to cloud content. No local content is uploaded. |
| Independent pause | Pause A, change the cloud marker, then resume A. | A reports **Paused** and keeps its files; B keeps receiving changes. A catches up after resume under current authority. |
| Independent remove | Choose **Remove…** on A, cancel once, then confirm **Remove sync**. Change the cloud marker again. | Cancellation keeps A attached. Confirmation shows **Off**, preserves A's files and backup, and stops further downloads to that folder. B continues. Re-enable A using a new empty fixture folder and record the new replica ID/path. |
| Picker fencing | Hold the native folder picker open, then close details, switch workspace/account, or remove edit access before selecting a folder. | The obsolete selection creates no replica and writes no files. Reopening details reads only the current owner. |
| Restart | Quit and restart the signed Alpha app on A while the workspace remains selected. | Its existing account/device/workspace binding, path, and cursor are retained; no duplicate replica or new Local workspace is created. |
| Offline catch-up | Take A offline, make multiple allowed cloud updates through B, then reconnect A. Also interrupt A's Local engine connection and reopen details. | Existing files and confirmed same-key metadata remain available. Reconnect renews authorization and catches up from durable state; local modifications still become divergence. An unavailable Local connection shows retained status rather than another device's snapshot. |
| Idle sleep/wake | Allow normal idle sleep, then wake through the authorized workspace action. Record generation/authority and accepted pin checks from B8's existing diagnostics. | Metadata reads do not initiate wake. After wake the existing replica rebinds through a fresh grant and converges, retaining the selected template/runtime identity and B10 persistence proofs. |
| Account/role changes | Switch A to another account and back; downgrade its workspace role to prompter/viewer, then restore it. | No prior account's folder/status/actions leak into the new account. Edit controls fail closed on downgrade and become available only after confirmed authorization returns. |
| Membership loss | Remove A's test member from the organization/workspace using the owner account; continue editing through B. | Server access is revoked, A detaches safely and retains downloaded bytes, and B stays independent. If restoring membership permits the same live binding, any resumed download requires fresh authorization. |
| Device revocation | Revoke A's test device through the existing trusted-device management flow. | A becomes **Detached** and cannot resume its terminal replica identity. A pending cloud-replacement confirmation disappears. Already downloaded files remain, and B continues receiving changes. |

Cleanup and evidence:

1. Remove every remaining live test replica through **Remove sync**, including
   replicas created after removal or re-enrollment. Record terminal bindings.
2. Delete the disposable cloud workspace through the owner's normal lifecycle
   action and run the existing fixture cleanup script from the orchestrator's
   credentialed checkout. Record confirmation for every created provider
   resource ID and terminal fixture state. Record any tombstones/checkpoints
   retained by the existing lifecycle separately from provider deletion.
3. Delete only the recorded local fixture folders and sibling local-change
   backups, after recording their preservation results. Restore test account
   roles/device settings as applicable.
4. Keep screenshots, IDs, cursors, revisions, and cleanup receipts in the
   private run log. Publish only the closed pass/fail results and blockers, with
   no credentials, private file contents, or native grant/proof material.
