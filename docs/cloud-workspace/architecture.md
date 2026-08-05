# Cloud workspace architecture

## System boundaries

```text
Desktop / web / future mobile clients
              │ authenticated control requests
              ▼
apps/control-plane ───── workspace metadata, authorization, audit
              │ provision / stop / wake / delete
              ▼
Remote execution environment
  repository + Zeros engine + agents + PTY
              │ versioned bridge
              ├──────────────────────► active client
              │ durable events/checkpoints
              ▼
Durable record and configured Git remote
```

The design separates four concerns:

1. **Client plane:** desktop first, then web and mobile control surfaces.
2. **Control plane:** identity, team authorization, workspace registry,
   lifecycle intents, idempotency, audit, quotas, and provider orchestration.
3. **Execution plane:** one isolated environment containing the repository,
   engine, agent processes, and terminals.
4. **Data plane:** the durable workspace record, artifacts/backups where needed,
   and the user's Git remote.

The engine is the live ordering authority while a workspace is running. The
control plane must not become a byte-by-byte relay for normal engine traffic
unless a future network design explicitly requires it.

## Repository ownership

| Responsibility                                                            | Owner                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Remote engine transport and desktop connection state                      | `apps/desktop/src/engine/transport/` and desktop-owned client modules |
| Shared bridge schemas, protocol version, crypto primitives, and redaction | `packages/protocol/`                                                  |
| Workspace APIs, authorization, registry, audit, quotas, and orchestration | `apps/control-plane/`                                                 |
| Browser management and authentication handoff                             | `apps/web/`                                                           |
| Non-production provider experiments                                       | `scripts/cloud-workspace-validation/`                                 |
| A future independently deployed execution coordinator                     | A new `apps/<name>/` only when it has a real build/deploy boundary    |
| Native mobile control clients                                             | `apps/ios/` and `apps/android/` only when source exists               |

Do not put provider credentials, provisioning code, or tenant authorization in
renderer/shared code. Do not extract a generic cloud package until at least two
deployables consume the same stable contract.

## Connection sequence

1. A client authenticates and requests a workspace by stable workspace ID.
2. The control plane authorizes the actor and returns the current lifecycle
   record. Creation and wake requests carry idempotency keys.
3. The control plane provisions or wakes the execution environment and starts
   the engine with a short-lived, workspace-bound connection grant.
4. The client connects through the provider/network boundary and performs the
   normal Zeros protocol handshake.
5. The engine verifies protocol compatibility and account/workspace binding
   before accepting privileged messages.
6. Reconnect resumes from acknowledged revisions rather than replaying an
   unbounded transcript or assuming the client is current.

The present `CloudTransport` proves only a token-gated remote bridge. Production
account/workspace grants, control-plane lifecycle records, client routing, and
resume semantics remain roadmap work.

## Provider boundary

Provider operations must be expressed through an internal interface covering
image/version selection, create, inspect, start, stop, delete, endpoint grants,
logs, and usage. Persist both the stable Zeros workspace ID and the current
provider resource ID. Provider-specific state must never leak into public API
identity or serialized client preferences.

## Failure model

- Every lifecycle mutation is idempotent and reconciled from observed provider
  state.
- The control plane records intent before dispatch and records the observed
  result afterward.
- A timeout means the result is unknown, not necessarily failed. Reconciliation
  must inspect before retrying creation or deletion.
- Clients retain the last confirmed exact-workspace snapshot during
  revalidation and label stale data.
- Deletion is complete only after execution resources, connection grants,
  provider credentials, and retention-scoped data are handled according to the
  product contract.
