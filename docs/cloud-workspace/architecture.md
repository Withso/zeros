# Cloud workspace architecture

## System boundaries

```text
Mac desktop
  renderer + Design canvas + local engine + replica/forward broker
       │                         │
       │ authenticated control  └── receive-only files / localhost tunnels
       ▼
apps/control-plane ───── stable identity, policy, authorization, audit
       │                         │
       │ lifecycle/grants        └── durable record + encrypted object store
       ▼
Remote execution environment
  repository + Zeros engine + agents + PTY + Design API
       │ versioned bridge / SSH / authenticated preview
       └────────────────────────► authorized active clients

Configured Git remote remains the committed code/review boundary.
```

The design separates four concerns:

1. **Client plane:** desktop and its device-private replica/forward broker first,
   then web control surfaces. Native mobile is deferred.
2. **Control plane:** identity, organization and child-team authorization, workspace registry,
   lifecycle intents, idempotency, audit, quotas, and provider orchestration.
3. **Execution plane:** one isolated environment containing the repository,
   engine, agent processes, and terminals.
4. **Data plane:** the durable workspace record, encrypted checkpoints/blobs,
   per-replica cursors, artifacts/backups, and the user's Git remote.

The engine is the live ordering authority while a workspace is running. The
control plane must not become a byte-by-byte relay for normal engine traffic
unless a future network design explicitly requires it.

## Identity and placement boundary

The stable workspace identity is not the provider resource and is not inferred
from a local worktree path. For a never-cloud workspace, device SQLite owns the
UUID and local record. Cloud, moved, and policy-registered workspaces have a
control-plane record with the same UUID, tenant/team/repository, creator,
billing owner, assignee, visibility, authority epoch, and current placement.
Append-only execution generations describe where they run. Provider bindings
describe only the current disposable cloud resource. Per-user/per-device
replica bindings describe optional local mirrors.

The current desktop uses human-readable workspace IDs and path-derived
repository IDs, while the current control plane uses cloud-only UUIDs. Phase 1
adds global UUIDs and keeps the released local IDs as compatibility aliases.
No move operation may silently replace an ID or infer identity from a path.

## Repository ownership

| Responsibility                                                            | Owner                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Remote engine transport and desktop connection state                      | `apps/desktop/src/engine/transport/` and desktop-owned client modules                             |
| SSH launch, preview admission, and localhost forward broker               | `apps/desktop/electron/cloud-workspace-access-*`; never renderer-owned process or credential code |
| Local replica and authority handoff                                       | Future desktop engine/Electron boundaries; never renderer-only code                               |
| Shared bridge schemas, protocol version, crypto primitives, and redaction | `packages/protocol/`                                                                              |
| Workspace APIs, authorization, registry, audit, quotas, and orchestration | `apps/control-plane/`                                                                             |
| Browser management and authentication handoff                             | `apps/web/`                                                                                       |
| Non-production provider experiments                                       | `scripts/cloud-workspace-validation/`                                                             |
| A future independently deployed execution coordinator                     | A new `apps/<name>/` only when it has a real build/deploy boundary                                |
| Native mobile control clients                                             | Deferred; add `apps/ios/` or `apps/android/` only with real source                                |

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

The desktop connection registry must be keyed by engine/execution identity. A
cloud-authoritative workspace may need the cloud bridge for chat/Git/Design and
a local-engine bridge for a Local terminal or replica broker at the same time.
A process-global `active bridge` is not the target architecture.

The present `CloudTransport` proves only a token-gated remote bridge. The
pre-production control plane now has lifecycle records, fenced setup admission,
and an internal workspace/generation-bound engine registration/heartbeat lease.
It does not yet issue the desktop's account/workspace-bound bridge connection
grant; client routing and resume semantics also remain roadmap work.

The separate Phase-2 access broker is implemented in Electron main without
pretending that bridge routing is complete. It obtains a current account token
from the main-owned auth session, calls the control plane over a bounded HTTPS
client, validates the exact workspace/kind/port/expiry contract, and keeps
provider access material out of renderer state. Terminal/tunnel credentials
live only in main memory or owner-private SSH files. External IDEs receive a
fixed SSH alias and an isolated user-data directory whose Remote-SSH settings
point at the private per-launch config, so the provider username does not enter
child argv or recent-workspace state. IPC returns grant identifiers, expiries,
loopback mappings, and bearer-free preview URLs. Preview capabilities are
injected only for requests whose Chromium frame ancestry contains the exact
authorized Browser iframe. SSH tunnel processes and configuration remain
desktop-owned and are stopped on revocation, sign-out, or app exit. A provider-
wide SSH revocation invalidates only sibling local leases for the same workspace
generation.

This is a native service boundary, not the cloud-workspace product flow. The
workspace catalog/details UI, current-execution selection, engine bridge grant,
port discovery and collision-free selection, and signed macOS/provider E2E are
still required before users can rely on it.

## Provider boundary

Provider operations must be expressed through an internal interface covering
image/version selection, create, inspect, start, stop, delete, endpoint grants,
logs, and usage. Persist both the stable Zeros workspace ID and the current
provider connection/resource ID. A provider connection belongs to a user or
Organization and references encrypted credentials; a workspace never points at
one deployment-wide API key implicitly. Provider-specific state must never leak
into public API identity or serialized client preferences.

## Placement and replica sequence

An authority move records a placement intent before quiescing either engine,
creates an exact checkpoint, prepares and verifies the target execution, then
atomically advances the workspace authority epoch. Old engine and endpoint
grants are revoked at cutover. Reconciliation decides an unknown result from
the recorded source/target epochs; it never permits both to write.

A local replica is different: the control plane authorizes a specific
user/device, and the desktop broker bootstraps from an exact manifest before
consuming ordered file events. Replica paths stay device-local. Pausing one
binding cannot mutate workspace authority or another member's binding. The full
contract is in [data, placement, migration, and local sync](data-and-sync.md).

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
