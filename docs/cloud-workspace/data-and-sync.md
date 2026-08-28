# Cloud workspace data, placement, migration, and sync

This document defines the target product and engineering contract for running a
Zeros workspace locally or in the cloud, moving its authoritative execution,
and keeping private device replicas. It is a target contract: the current
desktop and control-plane schemas require the forward migrations listed in the
roadmap before these behaviors are available.

## The three independent dimensions

Do not encode ownership, execution placement, and replication in one `location`
field. They answer different questions:

| Dimension               | Values                                            | Meaning                                                                                   |
| ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tenant ownership        | Personal or Organization/Team                     | Who owns policy, repository access, retention, and the workspace record                   |
| Authoritative execution | This Mac or Cloud                                 | Which single engine may sequence source, Git, chat, terminal, and Design writes           |
| Device replica          | Off, Syncing, In sync, Paused, Diverged, or Error | Whether one member's device has a private local mirror of a cloud-authoritative workspace |

Local placement does **not** imply Personal ownership. An Organization workspace
may run on one member's Mac and inherit Organization repository policy while its
files, chats, paths, processes, and terminals remain private to that device.
Likewise, a Personal workspace may run in the cloud without becoming
collaborative.

This separation produces four valid creation combinations:

| Tenant       | Runs on this Mac                                         | Runs in cloud                                        |
| ------------ | -------------------------------------------------------- | ---------------------------------------------------- |
| Personal     | Private local workspace                                  | Private single-member cloud workspace                |
| Organization | Organization-governed but device-private local workspace | Shared cloud workspace when collaboration is enabled |

## Sources of truth

| Data                                                                                                                | Live authority                      | Durable authority                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Repository content                                                                                                  | Authoritative engine/working tree   | Configured Git remote plus explicit encrypted checkpoints for uncommitted recovery |
| Never-cloud local workspace identity and runtime metadata                                                           | Local engine                        | Device SQLite                                                                      |
| Cloud/moved/registered workspace identity, tenant/team, creator, billing owner, assignee, placement/authority epoch | Control plane                       | Control-plane database                                                             |
| Local replica path and device-only overrides                                                                        | Desktop replica broker/local engine | Device SQLite/OS credential store; never the cloud record                          |
| Replica desired state, health, and cursors                                                                          | Desktop broker + cloud engine       | Tenant-scoped control-plane record                                                 |
| Chat, turns, agent sessions, run state, and recoverable workspace metadata                                          | Running engine while active         | Durable cloud record                                                               |
| Presence and transient UI state                                                                                     | Active client/engine session        | Not durable unless explicitly promoted to a product preference                     |
| Secrets                                                                                                             | Narrow runtime credential boundary  | Approved server secret store or user OS credential store; never the transcript     |

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

- **Move to Cloud** changes authoritative execution and preserves workspace
  identity.
- **Move to this Mac** changes authoritative execution and preserves tenant
  ownership and workspace identity.
- **Sync to this Mac** creates or resumes this member's receive-only local
  replica; cloud remains authoritative.
- **Pause sync on this Mac** affects only that replica and leaves its files on
  disk.
- **Remove local copy** affects only that replica and requires explicit
  confirmation before deleting its directory.
- **Make a local copy** forks a new workspace with a new identity. The user
  chooses Personal or an Organization they may create in.
- **Make personal copy** is the only action that changes Organization-owned
  work into Personal ownership. It is a policy-checked fork, never an implicit
  side effect of local placement.

Routine remote editing uses **Open via SSH**. Moving authority is for users who
need the workspace to continue as a local workspace, not merely for opening a
local IDE.

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
- An Organization cloud workspace is the only initial multiplayer execution
  mode. Every member sees the same cloud engine state according to role.
- Moving a shared Organization cloud workspace to one Mac suspends
  multiplayer. The action requires owner/manager authority, no active agent or
  Design write, no other active member, a completed durable checkpoint, and an
  explicit warning. Otherwise the UI offers **Make a local copy**.
- Moving an Organization workspace to a Mac does not move it to Personal. Its
  Organization metadata and policy remain; runtime data produced after the
  move stays private until the workspace moves back to cloud through an
  explicit checkpoint.

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

Cloud creation and every explicit rebuild record an immutable, redacted
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
- Organization MCP definitions may share names, commands/URLs, capabilities,
  and policy. Authentication headers, OAuth tokens, and environment values use
  separate bindings.
- User-delegated MCP identity is resolved per actor when the MCP protocol
  supports it. Workspace service credentials are resolved from an approved
  Organization or billing-owner binding and are never revealed to members.
- Ownership transfer invalidates owner-scoped bindings. The new owner must
  approve replacements before a new cloud generation can become ready.

## Authority and revision model

A workspace has exactly one current authoritative execution lease. The lease is
identified by workspace, placement generation, engine instance, epoch, and
expiry. Every source, Git, chat, terminal-control, and Design mutation carries
that epoch and an idempotency key. A stale local engine or cloud generation
fails closed after a move, delete, membership revocation, or ownership transfer.

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

## Phase-5 local replica contract

The first production sync mode is **cloud-to-device, receive-only, safe**:

1. Each member/device pair has its own replica identity, grant, desired state,
   cursor, local path, and health. No Organization-wide `sync_enabled` boolean
   exists.
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
8. Pausing one replica revokes only that replica's live grant. Other members,
   devices, cloud agents, terminals, previews, and replicas continue normally.

A Local terminal is offered only when that device has an `In sync` or
`Diverged` replica. Its tab is visibly marked `Local`; a Cloud terminal is
marked `Cloud`. The local terminal is useful for Mac-only tools and local dev
servers, but source writes do not flow back in Phase 5. Use Cloud terminal/SSH
to change authoritative files, or perform **Move to this Mac**. This limitation
must be stated in the terminal tooltip and first-run explanation.

Automatic bidirectional synchronization is not part of Phase 5 or Phase 6A.
If added later, it requires a separately reviewed three-way reconciliation
protocol based on a last-agreed manifest, per-file base revisions, durable
conflicts, deletion tombstones, and multi-device tests. Timestamp-based
last-writer-wins is prohibited.

## Migration workflows

### Move a local workspace to cloud

1. **Preflight:** resolve the stable tenant/repository identities; authorize
   repository and cloud creation; validate provider connection, quota, settings,
   paths, case/symlink compatibility, checkpoint size, and excluded secrets.
2. **Prepare:** allocate a global workspace UUID if the legacy local row does not
   have one. Keep its current human/local ID as a compatibility alias.
3. **Quiesce:** acquire the local authority lease and finish, stop, or explicitly
   cancel active agent turns, Git mutations, Design transactions, and PTYs.
4. **Checkpoint:** record base remote/commit, branch, working-tree manifest,
   staged/unstaged state, untracked files selected by the user, modes, and
   content hashes. Secret-like or ignored files default to excluded and require
   an explicit reviewed inclusion policy.
5. **Provision:** create an idempotent placement intent, clone the repository in
   a new cloud generation, apply the checkpoint, run setup, and verify the
   resulting manifest and engine handshake.
6. **Cut over:** atomically advance the authority epoch and route the workspace
   to cloud only after readiness. The existing local checkout becomes a
   receive-only replica when `Keep synced on this Mac` is selected.
7. **Recover:** before cutover, every failure leaves local authoritative. After
   cutover, reconciliation either completes cloud authority or rolls back using
   the recorded checkpoint; it never creates a second writable authority.

Personal stays Personal and Organization stays Organization during this move.

### Sync or download a cloud workspace

**Sync to this Mac** creates a device replica and does not change authority.
Every Organization member may create their own replica when their role and
Organization policy allow it. The local absolute path remains only in that
device's SQLite database; the server stores at most a user-chosen device/path
label and the sync state needed for authorization and recovery.

**Make a local copy** bootstraps the same code/checkpoint into a new workspace
ID. Chat/history copying is a separate, policy-controlled option. Copying
Organization data into Personal requires explicit confirmation and may be
disabled by Organization export policy.

### Move a cloud workspace to this Mac

This is an authority handoff, not file sync:

1. Require workspace owner/manager permission, a trusted target device, and a
   healthy full replica or enough disk to create one.
2. Reject or defer while another member is active, an agent/PTY/Design/Git write
   is running, the durable record is degraded, or any source conflict exists.
3. Quiesce the cloud engine, commit a final durable checkpoint, and pin its
   authority epoch.
4. Bootstrap and verify the local Git checkout plus uncommitted checkpoint
   without copying cloud `.git` metadata.
5. Atomically grant the target local engine the next authority epoch, revoke
   cloud mutation/SSH/preview grants, and stop or archive the sandbox.
6. Retain Organization ownership when applicable. Teammates see that it is
   running privately on the owner's Mac and cannot open its live chat/files
   until it moves back to cloud.
7. If cutover fails, keep cloud authoritative and remove only the incomplete
   local replica after user confirmation.

Cloud history remains Organization-governed and available according to its
retention policy. New local chats and runtime events remain device-private.
Moving back to cloud publishes a verified code checkpoint; publishing selected
local chat history is a separate, explicit, policy-controlled choice.

The UI recommends **Make a local copy** instead when a shared cloud workspace
has collaborators. A future product may support an owner-hosted shared local
engine, but it is not implied by this contract.

## Multiplayer replica behavior

For an Organization cloud workspace, the cloud engine remains authoritative
for every member:

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
uses the same cloud Design API. When authority moves to the Mac, the existing
local engine/Design API becomes authoritative after the placement epoch changes.

## Target durable data model

Names below are conceptual. Exact SQL names are fixed in a reviewed forward-only
migration and then become compatibility contracts.

| Relation                                                | Purpose and important constraints                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositories`                                          | Stable tenant + forge repository identity; unique on tenant/forge/provider-repository ID; rename-safe                                                                                                                                                                        |
| `repository_device_paths`                               | Device-local stable repository ID to canonical path mapping; SQLite only                                                                                                                                                                                                     |
| `repository_settings_versions`                          | Immutable schema-versioned Shared/Local/Cloud non-secret documents with creator and provenance                                                                                                                                                                               |
| `environment_profiles` / `environment_profile_versions` | Named Personal or Organization placement profiles and immutable build inputs                                                                                                                                                                                                 |
| `provider_connections`                                  | User/Organization-owned encrypted Daytona or future provider binding; no raw credential in workspace rows                                                                                                                                                                    |
| `secret_bindings`                                       | Opaque secret-store references scoped by tenant, owner, purpose, placement, and rotation version                                                                                                                                                                             |
| `workspaces`                                            | Server record for cloud, moved, or policy-registered workspaces: global UUID, tenant/team/repository, legacy alias, creator, owner, assignee, visibility, authority placement/epoch, optimistic version; local SQLite retains equivalent identity for never-cloud workspaces |
| `workspace_members`                                     | Explicit workspace role/following/presence eligibility; membership is always bounded by Organization/Team membership                                                                                                                                                         |
| `workspace_settings_versions`                           | Redacted effective snapshot, source versions, environment profile, and policy version used by one workspace generation                                                                                                                                                       |
| `workspace_executions`                                  | Append-only local/cloud authority generations; at most one current authoritative execution per workspace                                                                                                                                                                     |
| `cloud_workspace_generations`                           | Pinned image/resources/source commit/settings snapshot for cloud execution; extends the existing generation contract                                                                                                                                                         |
| `cloud_workspace_provider_bindings`                     | Opaque provider resource observed state keyed by provider connection and generation                                                                                                                                                                                          |
| `devices`                                               | Per-user public-key identity, trust/revocation state, platform, and last-seen metadata                                                                                                                                                                                       |
| `workspace_replicas`                                    | Workspace + user + device binding, mode, desired/observed state, authority epoch, checkpoint and event cursors; one live binding per tuple                                                                                                                                   |
| `workspace_replica_events`                              | Bounded state/error history for diagnosis; no absolute local path or source bytes                                                                                                                                                                                            |
| `workspace_content_revisions`                           | Monotonic engine sequence and parent/checkpoint identity                                                                                                                                                                                                                     |
| `workspace_file_entries`                                | Current manifest projection: normalized relative path, type, mode, content hash, size, revision, tombstone                                                                                                                                                                   |
| `workspace_file_events`                                 | Idempotent ordered changes used for catch-up; payload refers to encrypted object blobs                                                                                                                                                                                       |
| `workspace_checkpoints`                                 | Git base/ref plus encrypted manifest/artifact reference, reason, author, integrity state, and retention                                                                                                                                                                      |
| `workspace_blobs`                                       | Tenant-scoped content-addressed encrypted objects with reference accounting and deletion state                                                                                                                                                                               |
| `workspace_placement_intents`                           | Idempotent record-before-dispatch move/copy operations, phases, lease, source/target epochs, and recovery outcome                                                                                                                                                            |
| `workspace_ports`                                       | Engine-observed sandbox listeners and health, never an unauthenticated public endpoint                                                                                                                                                                                       |
| `port_forward_sessions`                                 | Actor/device/remote/local mapping, bind address, grant, expiry, and observed status                                                                                                                                                                                          |
| `ownership_transfers`                                   | Offered/accepted/cancelled transfer, old/new owner, cutover checkpoint, provider rebind, and billing epoch                                                                                                                                                                   |
| `usage_events`                                          | Immutable provider/agent usage with actor, billing-owner snapshot, billing epoch, source idempotency key, quantity, and timestamps                                                                                                                                           |
| `outbox_events`                                         | Transactional publication of lifecycle, sync, audit, usage, and notification events                                                                                                                                                                                          |

Normalize authorization, ownership, lifecycle, billing, grants, provider
bindings, and cursors. JSONB is appropriate for bounded versioned settings,
provider observations, and redacted event metadata; it is not a substitute for
foreign keys or queryable security state.

Every tenant relation carries `org_id` (including Personal's tenant shell) and
uses composite foreign keys where that prevents cross-tenant references.
Application authorization and forced row-level security both apply. Background
workers set an explicit system/tenant context. Mutations use optimistic version
checks or row leases, idempotency keys, and a transactional outbox. Large file,
checkpoint, transcript artifact, and log payloads live in encrypted object
storage rather than PostgreSQL rows.

The current desktop's human-readable workspace ID and path-derived repository
ID are not safe global identities. A forward migration adds UUID global IDs and
preserves current IDs as local compatibility aliases. The existing control-plane
cloud workspace UUID becomes that same global workspace ID; public API routes
do not expose provider resource IDs.

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
- Ownership transfers across provider accounts: checkpoint and reprovision;
  changing an owner column alone is forbidden.
- A move times out after dispatch: reconcile source and target epochs before
  retrying. Never start a second provider resource or writable engine merely
  because the client timed out.
- Cloud is unreachable: retain the last confirmed files and Git snapshot, mark
  them stale/read-only, and never promote the local replica automatically.

## Acceptance matrix

Before Phase 5 can be called seamless for a single member, automated and
end-to-end tests cover:

- Personal/Organization × local/cloud creation and exact settings provenance;
- local-to-cloud move with clean, staged, unstaged, untracked, ignored,
  secret-like, large, symlink, executable, Unicode, and case-collision trees;
- failure before and after authority cutover, including process crash and
  duplicate request replay;
- cloud-to-local move with active collaborators, turns, terminals, Design
  transactions, degraded durability, and ownership/policy restrictions;
- one member syncing separate trusted devices, independent
  pause/remove/reconnect, device revocation, and offline deletion tombstones;
- local divergence preservation and explicit replace/export resolution;
- exact-revision Design writes followed by local replica convergence;
- SSH expiry/revocation, Cursor/terminal launch, localhost-only port forwarding,
  mapping collisions, workspace sleep/wake, and membership loss;
- RLS and composite-FK cross-tenant attacks, stale authority epochs, grant
  replay, idempotency, outbox replay, usage deduplication, and ownership cutover;
  and
- backup/restore into a fresh provider environment without relying on the old
  sandbox or a Mac replica.

Before Phase 6A multiplayer can ship, extend the same matrix to two or more
members and prove independent device paths/cursors, role and membership
revocation, owner transfer, billing-epoch cutover, active-collaborator move
blocking, and the absence of cross-member replica side effects.
