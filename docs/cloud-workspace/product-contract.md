# Cloud workspace product contract

## Definition

A cloud workspace is a normal Zeros coding workspace whose engine and working
copy run in an isolated remote execution environment. The client controls it
through the same versioned bridge concepts used locally. Remote placement must
not create a second, incompatible workspace model.

Tenant ownership, authoritative execution placement, and an optional local
replica are independent. Personal and Organization workspaces may run locally
or in cloud. A local Organization workspace remains Organization-governed but
its live source, chat, paths, and processes remain private to its device. See
[data, placement, migration, and local sync](data-and-sync.md).

## User-visible guarantees

- A workspace has one stable identity independent of its current machine,
  lifecycle state, client device, or sandbox provider.
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
- Changing the Personal/organization or local/cloud target in the UI changes
  routing metadata for a future explicit creation only; it never retargets an
  existing workspace. Creating cloud from local, opening cloud locally, or
  forking cloud are copy-like workflows with separate identities. Transferring
  uncommitted work, rebasing, publishing, or deleting a checkout remains a
  separate explicit action.
- The distinct future Move action is a checkpointed, idempotent authority
  handoff that preserves workspace identity. A copy/fork always receives a new
  workspace identity and is never presented as a move.

## Initial product scope

The target product permits both Personal and Organization cloud workspaces.
Personal is single-member and cannot enable multiplayer. Organization
capability metadata is necessary but never replaces server-side membership,
role, plan, quota, repository, provider-connection, and policy authorization.

The current migration `0009_organization_team_hierarchy.sql` deliberately marks
Personal as local-only, and the current cloud create route enforces that
constraint. Enabling Personal cloud therefore requires a reviewed forward
migration, route/RLS changes, quota ownership, and mixed-version tests; this
document does not claim it already works.

The first supported release should provide:

1. creation from an authorized repository and revision;
2. deterministic environment setup with inspectable logs;
3. remote engine connection, file operations, PTY, Git, and supported agents;
4. stop, wake, reconnect, archive, and delete lifecycle controls;
5. durable workspace metadata and transcript/session restoration;
6. desktop status, recovery, SSH, authenticated preview/forwarding, and Design
   parity;
7. explicit local-to-cloud and eligible cloud-to-local authority handoff;
8. an optional per-user/per-device receive-only local replica; and
9. quotas, audit records, and owner-visible cost/lifecycle information.

Phase 5 is the seamless single-member release for Personal and Organization
ownership. Phase 6A adds Organization multiplayer, presence, shared live chats,
per-member replicas, assignment, and ownership transfer. Native iOS/Android,
automatic bidirectional file sync, and collaborative source/Design editing are
deferred and do not block either release.

## Compatibility

Persisted workspace IDs, protocol versions, database fields, lifecycle states,
and externally documented API routes are compatibility contracts. Rename them
only with an explicit migration and mixed-version tests. A newer client must
fail clearly when the remote engine protocol is unsupported; it must never
guess around a version mismatch.

## Non-goals

- Cloud workspaces do not make arbitrary repository code trusted.
- A successful provider validation run is not a production security review.
- Sandboxes are not the sole durable store for user work.
- Provider-specific resource identifiers are not public workspace identities.
- The first release does not promise real-time collaborative editing or
  transparent migration between providers.
- A cloud-to-Mac replica is not an automatic bidirectional merge and is not a
  second place to commit Git history.
- Moving a shared cloud workspace onto one member's Mac does not preserve live
  multiplayer; the UI offers a policy-checked copy when an authority handoff is
  unsafe.
