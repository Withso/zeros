# Agent identity model

Zeros owns product identity and live routing independently of every agent
provider. Provider-native handles are durable bindings attached to a Zeros
conversation; they are not conversation IDs or live route keys.

## Identities and ownership

| Identity          | Owner                      | Lifetime                   | Persisted                      | Purpose                                                                        |
| ----------------- | -------------------------- | -------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `workspaceId`     | Zeros                      | Workspace lifecycle        | Yes                            | Repository/worktree ownership and process policy                               |
| `conversationId`  | Zeros                      | Chat lifecycle             | Yes (`chats.id`)               | Transcript, title, settings, archive/pin, and sync owner                       |
| `executionId`     | Zeros engine               | One live adapter execution | No                             | IPC routing, stream ownership, cancellation, permissions, and in-memory caches |
| `providerBinding` | Provider, wrapped by Zeros | Provider resume lifecycle  | Yes (`chats.provider_binding`) | Opaque input to the selected adapter's resume operation                        |

`providerMetadata` is descriptive provider state stored separately in
`chats.provider_metadata`. It is retained for migration compatibility and
provider diagnostics only. It never reconciles Zeros title, pin, archive, Git
workspace, or lifecycle state, and it never routes a message. The Codex adapter
does not import `thread.gitInfo` into this field.

The protocol aliases in `@zeros/protocol/identities` make these roles explicit.
They are string aliases rather than branded values so the migration remains
wire-compatible with older clients.

## Provider bindings

`ProviderBinding` is versioned and provider-owned:

```ts
interface ProviderBinding {
  version: 1;
  providerId: string;
  kind: "native" | "legacy";
  resumeId: string;
  scopeId?: string;
  legacySessionId?: string;
}
```

- `resumeId` is the value accepted by the provider's resume API.
- `scopeId` is an optional wider provider lineage. Codex stores the server's
  `thread.sessionId` here; forks can share it, so it must be read from the
  provider rather than derived from `thread.id`.
- `legacySessionId` is only a migration/downgrade locator.
- `kind: "legacy"` means the old value is not yet known to be a native provider
  handle. The adapter resolves it when possible and publishes a native binding.

Current mappings are:

| Adapter          | `resumeId`     | `scopeId`          | Legacy interpretation                                                   |
| ---------------- | -------------- | ------------------ | ----------------------------------------------------------------------- |
| Codex app-server | `thread.id`    | `thread.sessionId` | Old Zeros execution locator                                             |
| Claude SDK       | SDK session ID | —                  | Old Zeros session-directory locator, resolved through `claude-sdk.json` |
| Cursor SDK       | SDK agent ID   | —                  | Already a native provider handle                                        |

Future adapters add another mapping behind the same interface. They do not add
another product identity or route namespace.

## Lifecycle

### New conversation execution

1. The durable conversation already has a Zeros `conversationId`.
2. The gateway mints a fresh random `executionId` and supplies it to the
   adapter.
3. The adapter creates provider state and returns a `providerBinding` when the
   native handle is known.
4. The engine routes all live events by `executionId` and binds that execution
   to the conversation in memory.
5. The engine persists only the provider binding (plus optional non-authority
   diagnostics from adapters that expose them); the renderer mirrors those
   durable fields into its chat state. Neither writes the execution ID to the
   chat row.

### Renderer reload or tab remount

The renderer sends the durable `conversationId` and may include its compatibility
mirror of `providerBinding`, without an execution route. The engine's persisted
conversation row remains authoritative for agent, folder, workspace, and
binding; client binding/cwd fields cannot roll it back. A rowless legacy load
may still use the supplied locator during the compatibility window. If the
engine has a live execution for the conversation, it reattaches the renderer to
it without calling the adapter's resume operation. This applies to busy and idle
executions; only an actually live turn is projected as running.

### Engine restart or disposed execution

No live execution survives. The gateway mints a different `executionId` and
passes the same provider binding to the adapter. Transcript and conversation
identity remain unchanged.

### Provider binding refinement

A provider may reveal or replace its native handle after startup. The adapter
emits `provider_binding_update` on the current execution. The engine caches and
forwards it and atomically writes it to the chat row; the renderer applies it
only when the event belongs to the chat's exact current execution and mirrors
the binding into its local chat state. The engine write matters for Claude,
whose native resume id arrives in the first streamed init event: an immediate
tab close cannot unmount React before the durable handle reaches SQLite. The
update never rekeys the live route or changes the conversation.

### Native provider fork

`AGENT_FORK_CONVERSATION` is a provider-neutral Zeros command. Fork follows the
same product-owned ordering as a Conductor-style workspace chat:

1. Zeros creates and persists the destination `conversationId` first, in the
   same workspace, with `sourceChatId` pointing at the source conversation.
2. The engine reads the source binding from its own chat row. The request never
   accepts a raw provider thread/session id.
3. The gateway asks the selected adapter to fork that opaque binding. Codex
   implements this with typed `thread/fork`; future adapters can implement the
   same optional adapter method without adding a provider-specific wire route.
4. While the provider call is in flight, the engine prevents a new source turn
   from racing the latest-completed-state snapshot. It then atomically verifies
   the source still has the exact binding that was forked and compare-and-sets
   the returned native binding onto the still-unbound destination. No execution
   is created.
5. Opening the destination uses the ordinary common `AGENT_LOAD_SESSION` path,
   which mints a fresh Zeros `executionId` and resumes the new binding.

Codex's returned `thread.sessionId` is read and stored as `scopeId`; it is never
derived from the source. PR4 forks the latest completed provider state; it does
not expose a provider-native turn id on the common wire. A future “fork from
this turn” command requires a provider-neutral mapping from a Zeros turn first.
Fork requests defer copied goal continuation until the Zeros destination is
explicitly opened. If the destination changes during the provider call, Zeros
does not issue a destructive native-delete rollback, because Codex deletion can
cascade through descendant threads.

### Agent switch

The Zeros conversation may remain mounted, but a binding belongs to exactly one
provider. Changing `agentId` clears any binding and metadata owned by the old
provider. A binding whose `providerId` does not match the selected agent is
rejected at the renderer reducer, database trust boundary, gateway, and resume
dispatcher.

### Tab close, execution close, archive, and delete

Closing any chat tab is an explicit stop boundary. The renderer discards queued
follow-ups and invalidates create/resume work even when no execution route has
been published yet. The engine cancels and settles every accepted turn for the
conversation before disposing its Claude, Codex, or Cursor execution and
removing both directions of the in-memory conversation/execution mapping.

Tab close does not delete provider history. A used conversation is archived out
of the visible strip with its transcript and durable provider binding intact.
Restoring it from History and sending again creates a fresh `executionId` and
resumes the same provider conversation. Create/load for that conversation waits
for any active close transaction to finish, so provider resume never overlaps
cancel/dispose of the old execution. A pristine unused tab may still be
discarded, while provider thread APIs never own archive/delete policy.

A provider can independently delete its native conversation. While a Codex
execution is live, an exact-parent `thread/deleted` notification produces
`provider_binding_detached`; the engine compare-and-clears only that matching
binding and its compatibility metadata. The Zeros conversation, transcript,
title, pin, archive state, and source relationship remain untouched. A stale
delete event cannot clear a newer binding. If no execution is live, the same
detachment occurs when a later common resume definitively reports the binding
missing.

Zeros does not subscribe product state to provider archive, unarchive, close,
name, or pin notifications, and Zeros rename/pin/archive/delete actions do not
call the corresponding provider lifecycle APIs. This one-way separation is
intentional: provider history is an opaque resume facility, not the product
database.

## Wire compatibility

`executionId` is the canonical agent route, introduced additively in protocol
v8. During the compatibility window, routed frames also carry or accept
`sessionId` as an alias. When both are present they must be identical; the
trust-boundary schema rejects a split value. `AGENT_LOAD_SESSION` alone may
carry the historical provider locator in `sessionId` for an older engine; a
current engine converts that value to a legacy provider binding at the dispatch
boundary and never stores it as an execution.

Protocol v9 adds the common conversation-fork request/receipt and exact
provider-binding-detached update. Older peers continue to use v8 resume and
simply do not expose native fork or live provider-deletion detachment.

`chats.session_id` remains a downgrade locator for older builds. Current code
derives it from `providerBinding.legacySessionId ?? providerBinding.resumeId`
and never persists an execution ID there.

Database migrations are forward-only:

- v28 adds the versioned, provider-neutral `provider_binding` column.
- v29 adds `provider_metadata` and classifies existing Cursor values as native
  while preserving Claude/Codex values as legacy locators.
- v30 repairs development databases that previously used the draft
  Codex-specific `native_session_id` and `native_git_info` columns, including a
  database that stopped after only one draft migration.

## Required invariants

- Workspace and conversation identities never change inside one mounted
  conversation lifecycle.
- Every new or resumed adapter execution receives a fresh Zeros execution ID.
- Execution IDs are never stored in durable chat state.
- Provider bindings are never used as IPC routes or cache keys.
- After start/resume selects a provider, the execution route—not a redundant
  client `agentId` label—selects the live adapter.
- A provider binding can rotate without changing the execution route.
- A stale execution cannot update the current execution's turn state or
  provider binding.
- A provider deletion can detach only the exact current binding; it cannot
  delete or mutate the Zeros conversation lifecycle.
- A persisted conversation's agent, folder, workspace, and binding override
  stale renderer resume couriers and are revalidated before provider startup.
- Native fork attaches to a pre-existing unbound Zeros destination and never
  creates a provider-owned conversation identity or live route.
- Resume ownership is checked before provider code or credentials are invoked.
- Provider Git metadata cannot switch or mutate the Zeros workspace checkout.
