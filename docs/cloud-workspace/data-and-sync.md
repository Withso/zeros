# Cloud workspace data and synchronization

## Sources of truth

| Data                                                                       | Live authority                     | Durable authority                                                              |
| -------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| Repository content                                                         | Running engine/working tree        | Configured Git remote plus explicit checkpoints for uncommitted recovery       |
| Workspace identity, owner/team, lifecycle intent, provider binding         | Control plane                      | Control-plane database                                                         |
| Chat, turns, agent sessions, run state, and recoverable workspace metadata | Running engine while active        | Durable cloud record                                                           |
| Presence and transient UI state                                            | Active client/engine session       | Not durable unless explicitly promoted to a product preference                 |
| Secrets                                                                    | Narrow runtime credential boundary | Approved server secret store or user OS credential store; never the transcript |

The execution environment is disposable. It may cache durable data, but it must
not be the only location from which a user can recover workspace identity,
history, or committed code.

## Event and revision model

- Every durable stream is scoped by stable tenant, workspace, and semantic
  owner IDs.
- Events carry a monotonic workspace revision or another explicit ordering
  token. Timestamps are metadata, not the conflict resolver.
- Writes are idempotent. A reconnect may resend an event without creating a
  duplicate message, session, checkpoint, or billing record.
- The server publishes a complete exact-key snapshot plus the revision it
  represents. Incremental events apply only after that revision.
- Consumers detect gaps and request a bounded catch-up or a new snapshot.
- Deletion tombstones and membership revocation outrank late-arriving writes.

## Restore order

1. Authorize the actor and resolve the stable workspace record.
2. Restore or clone the repository at its recorded Git identity.
3. Apply an approved uncommitted-work checkpoint, if one exists.
4. Initialize the engine schema and restore durable chats, turns, sessions, and
   workspace metadata through versioned migrations.
5. Start the bridge and publish readiness only after integrity checks pass.
6. Let clients reconcile from the returned exact revision.

Restore must be repeatable into a fresh environment. A provider snapshot can
accelerate startup, but the product must have a documented recovery path when
that snapshot is corrupt, expired, or unavailable.

## Local and multi-device synchronization

Cloud-workspace durability ships before optional local-workspace synchronization.
If local engines later write to the same durable record, users must receive a
clear privacy control and the record must preserve the same workspace-scoped
ordering and deletion rules.

Multiple clients may observe one running engine. The engine remains the live
sequencer; clients do not merge agent turns independently. Collaborative source
editing is a separate feature and requires its own conflict/ownership model.

## Data lifecycle

- Document retention separately for active, stopped, archived, and deleted
  workspaces.
- Make export and deletion available at the same semantic workspace boundary.
- Encrypt data in transit and at rest, and document which operator roles can
  access each store.
- Backups need tested restore procedures, retention limits, and deletion
  propagation. A backup existing is not evidence that restoration works.
- Keep analytics, diagnostics, and billing data minimized and separate from
  source content and prompts.
