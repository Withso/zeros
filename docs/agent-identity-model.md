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
`chats.provider_metadata`. It may help labels or reconciliation, but it never
selects a workspace, changes a checkout, or routes a message.

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
5. The renderer persists only the provider binding and metadata. It never
   writes the execution ID to the chat row.

### Renderer reload or tab remount

The renderer sends the durable `conversationId` and `providerBinding`, without
an execution route. If the engine still has a live execution for that
conversation, it reattaches the renderer to it without calling the adapter's
resume operation. This applies to busy and idle executions; only an actually
live turn is projected as running.

### Engine restart or disposed execution

No live execution survives. The gateway mints a different `executionId` and
passes the same provider binding to the adapter. Transcript and conversation
identity remain unchanged.

### Provider identity reconciliation

A provider may reveal or replace its native handle after startup. The adapter
emits `provider_binding_update` on the current execution. The engine caches and
forwards it; the renderer applies it only when the event belongs to the chat's
exact current execution, then persists the binding. The update never rekeys the
live route or changes the conversation.

### Agent switch

The Zeros conversation may remain mounted, but a binding belongs to exactly one
provider. Changing `agentId` clears any binding and metadata owned by the old
provider. A binding whose `providerId` does not match the selected agent is
rejected at the renderer reducer, database trust boundary, gateway, and resume
dispatcher.

### Close, archive, and delete

Closing a live chat disposes the execution and removes both directions of the
in-memory conversation/execution mapping. Durable chat state and the provider
binding remain available for reopening. Archive/delete policy continues to be
owned by the Zeros conversation/workspace lifecycle, never by a provider
thread API.

## Wire compatibility

`executionId` is the canonical agent route. This is an additive protocol-v8
extension so already-paired remote peers are not disconnected. During the
compatibility window, routed frames also carry or accept `sessionId` as an
alias. When both are present they must be identical; the trust-boundary schema
rejects a split value. `AGENT_LOAD_SESSION` alone may carry the historical
provider locator in `sessionId` for an older engine; a current engine converts
that value to a legacy provider binding at the dispatch boundary and never
stores it as an execution.

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
- Resume ownership is checked before provider code or credentials are invoked.
- Provider Git metadata cannot switch or mutate the Zeros workspace checkout.
