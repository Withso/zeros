# Cloud workspace product contract

## Definition

A cloud workspace is a normal Zeros coding workspace whose engine and working
copy run in an isolated remote execution environment. The client controls it
through the same versioned bridge concepts used locally. Remote placement must
not create a second, incompatible workspace model.

## User-visible guarantees

- A workspace has one stable identity independent of its current machine,
  lifecycle state, client device, or sandbox provider.
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
- Local and cloud target selection changes routing metadata only. Moving work,
  rebasing, publishing, or deleting a checkout remains a separate explicit
  action.

## Initial product scope

Cloud workspaces are organization-owned. Personal is permanently local-only;
see [organizations, teams, and workspace ownership](../organizations-and-teams.md).
Organization capability metadata is necessary but never replaces server-side
membership, plan, quota, and repository authorization.

The first supported release should provide:

1. creation from an authorized repository and revision;
2. deterministic environment setup with inspectable logs;
3. remote engine connection, file operations, PTY, Git, and supported agents;
4. stop, wake, reconnect, archive, and delete lifecycle controls;
5. durable workspace metadata and transcript/session restoration;
6. desktop status and recovery UI; and
7. quotas, audit records, and owner-visible cost/lifecycle information.

Expanded team collaboration, mobile control, provider choice, enterprise deployment, and
cross-device local-workspace synchronization build on these contracts but do not
need to block the first single-owner release.

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
