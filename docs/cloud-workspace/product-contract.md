# Cloud workspace product contract

## Definition

A cloud workspace is a normal Zeros coding workspace whose engine and working
copy run in an isolated remote execution environment. The client controls it
through the same versioned bridge concepts used locally. Remote placement must
not create a second, incompatible workspace model.

Tenant ownership, the workspace's immutable execution placement, and an
optional local replica are distinct. Personal workspaces are permanently
device-local; new Organization workspaces are cloud-owned and provisioned through
the control plane. Their durable records and settings live in cloud storage;
the running engine may keep a recoverable local projection. Legacy local
Organization rows remain readable without silently changing ownership. See
[data, copies, and local sync](data-and-sync.md).

The active desktop milestone is Organization ownership and managed Boat runtime
parity. Later milestones are receive-only cloud-to-device directory sync,
authorized commands on connected Macs, registered machines as primary hosts,
and explicit copies to another host with fresh workspace identities. Directory
sync never uploads device edits. An Apply-local-changes action and continuous
bidirectional sync are outside the product plan.

## User-visible guarantees

- A workspace has one stable identity for its lifetime. Creating a local
  workspace from cloud, or a cloud workspace from local, is a fork with a new
  identity; placement is never changed in place.
- A workspace has exactly one authoritative execution at a time. A receive-only
  cloud-to-Mac sync creates a replica, not a competing writable engine or a new
  owner. Until that replica workflow ships, “open cloud locally” creates a
  separate local workspace with an optional source link.
- Opening an existing workspace reconnects or wakes that workspace; it does not
  silently create a replacement.
- Stop, wake, archive, delete, reconnect, and retry are explicit states with
  observable progress and idempotent operations.
- Closing a client does not stop active agent work unless the user or an
  enforced lifecycle policy requests it.
- Code durability is anchored in the configured Git remote and explicit
  checkpoints. Chat, session, workspace metadata, and recovery state use the
  durable record described in [data and synchronization](data-and-sync.md).
- A client never reports a workspace as ready until the engine, protocol,
  authorization, and repository checkout are ready for the requested action.
- A provider or network failure retains the last confirmed state and reports
  that it is stale; it does not replace known state with an empty workspace.
- Changing the Personal/Organization or local/cloud target changes a future
  creation only; it never retargets an existing workspace. **Create cloud copy**
  and **Create local copy** carry selected files and optional chats/settings
  through an integrity-checked fork record. The source is retained, and
  archive/delete is always a separate owner action.

## Initial product scope

The current backend milestone supports organization-shared workspaces and
exact-workspace guest collaboration. Existing private workspaces stay private;
new shared Pro workspaces admit eligible organization members as Read-only. Invited
guests never acquire organization membership or access to sibling workspaces.
Personal remains permanently device-local; migrations `0018` and `0053` and
server authorization enforce that boundary.

Pro is an individual subscription. A Pro account may join multiple Pro
organizations; there is no purchased Pro organization subscription or five-member
limit. Each actor and the immutable compute sponsor must retain their own current
authority. One member's lapsed subscription does not disable unrelated members.
Write assignments are explicit and limited to ten people per workspace,
including its owner; Read-only Pro collaborators have no total count limit.
Business/Enterprise subscriptions and purchased seat assignments remain separate
historical contracts, with their launch policy deferred.
WorkOS membership alone never authorizes paid compute.

The new [Pro backend](pro-backend.md) replaces staff-only admission for individual
Pro sponsorship and adds an automatic 500-hour monthly allowance for ordinary
Pro. Active `platform_owner` and `developer` staff receive separately audited
complimentary Pro with no monthly machine-hour cap; compute remains user-owned
and subject to ordinary infrastructure safety limits. Alpha cloud execution is
enabled for backend and desktop qualification; Beta and Production remain
disabled. See [qualification status](qualification-status.md) for the live test boundary.
The workspace owner sponsors compute. Agent execution requires `canWrite`;
editing separately requires `canEdit`. Invitations and credential administration
require their current server capabilities. In negotiated `boot-owner-v1`,
granting Prompter/Developer access is consent to owner-funded agent work:
members' agents can use and read the owner's active provider keys. The share
dialog stays unchanged. Legacy cloud retains explicit model delegations.
See [boot funding, next-run cards and removal](agent-authentication-and-language-tools.md#negotiated-boot-funding).
A client detach never stops another participant's active execution.

The first supported release should provide:

1. creation from an authorized repository and revision;
2. deterministic environment setup with inspectable logs;
3. remote engine connection, file operations, PTY, Git, and supported agents;
4. stop, wake, reconnect, archive, and delete lifecycle controls;
5. durable workspace metadata and transcript/session restoration;
6. desktop status, recovery, SSH, authenticated preview/forwarding, and Design
   parity;
7. explicit local-to-cloud and cloud-to-local copy/fork with fresh identities;
8. an optional per-user/per-device receive-only local replica; and
9. quotas, audit records, and owner-visible cost/lifecycle information.

The current implementation and release gates are in
[qualification status](qualification-status.md). Desktop create/catalog/details,
sharing and native access surfaces are implemented; native mobile/Windows clients,
active ownership transfer, bidirectional file sync and collaborative text editing
remain separate future scope. Ordered durable
streams and device-scoped authority are shared backend contracts. Their presence
does not qualify an unbuilt client or promise zero network/cold-start latency.
Release claims require the protected provider and deployment qualification gates.

## Compatibility

Persisted workspace IDs, protocol versions, database fields, lifecycle states,
and externally documented API routes are compatibility contracts. Rename them
only with an explicit migration and mixed-version tests. A newer client must
fail clearly when the remote engine protocol is unsupported; it must never
guess around a version mismatch.

New queue/funding/transport behavior requires explicit boot-mode negotiation,
activation and matching readiness; a missing binding is not permission to use
legacy authority. New desktops keep the legacy path for old-mode engines.
Old desktops on an activated new-mode workspace receive the existing
upgrade-required refusal. Personal Local and organization-local keep their
existing native accounts, queue and reconnect behavior.

## Non-goals

- Cloud workspaces do not make arbitrary repository code trusted.
- A successful provider validation run is not a production security review.
- Sandboxes are not the sole durable store for user work.
- Provider-specific resource identifiers are not public workspace identities.
- The first release does not promise real-time collaborative editing or
  transparent migration between providers.
- A cloud-to-Mac replica is not an automatic bidirectional merge and is not a
  second place to commit Git history.
- A local fork of an Organization cloud workspace is a private, independently
  identified workspace. It never removes, relocates, or takes authority from
  the Organization cloud source.
