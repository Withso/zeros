# Cloud workspace infrastructure and operations

## Build and image contract

The remote image must be reproducible from reviewed source and a pinned runtime
set. It must include only the engine, approved agent runtimes, native modules for
the image ABI, and documented operator tooling. Image creation fails when a
native rebuild, license-generation step, integrity check, or required runtime
stage fails.

Record an immutable image identifier with every workspace generation. A
workspace may be upgraded only through a versioned, observable operation with a
rollback or recovery path.

Record the provider connection, environment-profile version, redacted settings
snapshot, repository identity/revision, and engine protocol with that
generation. Changing shared Cloud settings creates a new candidate generation;
it does not mutate a running environment invisibly.

## Lifecycle states

Use explicit states such as requested, provisioning, setting-up, ready, busy,
stopping, stopped, waking, archiving, deleting, deleted, and failed. The exact
wire values become compatibility contracts when introduced.

- Create, stop, wake, archive, and delete accept idempotency keys.
- Reconciliation compares desired state, provider-observed state, engine health,
  and durable-record state.
- Setup execution uses a bounded renewable lease and an incrementing fence.
  Sandbox commands run after the claim transaction commits; every heartbeat and
  result locks/rechecks workspace, generation, lifecycle, and provider binding.
- Daytona commands resolve the exact bound resource id, reject unbounded
  execution, and carry a positive provider-side timeout. Local cancellation may
  stop waiting before the SDK call returns, so the remote timeout plus the
  durable execution fence are both mandatory.
- The setup executor invokes one fixed image-owned helper. Its one-use admission
  is bound to the setup run and fence, and must be retired before success can be
  published. Repository-controlled values never become shell syntax.
- Production setup has its own operator gate. The image entrypoint is a
  root-only Unix-socket supervisor; one prepare session authorizes one fixed
  engine launcher and stops an older process group before replacement. The
  helper performs exact-revision Git and declared setup commands as UID/GID
  10001, then requires live image attestation and durable engine registration.
  Its journal skips durably completed commands, but setup commands remain
  at-least-once across the command-success/journal-write crash window and must
  be written to tolerate replay.
- Engine heartbeats renew a bounded lease and can carry a secret-free GitHub
  credential refresh request. The control plane rechecks authority before and
  after minting; only the replacement projection crosses the response, while
  database/audit records contain no raw token.
- A failed setup retains bounded logs and a safe retry/delete path.
- Idle policy never stops a workspace with active agent work, an acknowledged
  interactive terminal, or an in-flight durable write.
- Delete revokes grants first and completes only after provider inspection says
  the execution resource is gone.
- A local↔cloud fork has a record-before-upload intent, distinct source/target
  UUIDs, an expected snapshot/checkpoint, bounded staging, and a deadline. It
  completes only after the destination is integrity-verified; it never revokes
  or changes the source.

## Readiness and health

Provider process health, engine health, repository readiness, protocol
compatibility, and user-action readiness are different signals. A listening
port alone is not readiness. Publish a workspace as ready only after an exact,
durable attestation matches the claimed fence, pinned image/source commit,
repository revision/resolved commit, settings version/hash, engine instance and
protocol health, and durable-record connection.

Health endpoints disclose no secrets, repository names, user identity, or
internal stack traces. Privileged diagnostics require normal workspace
authorization.

## Observability

At minimum, record:

- lifecycle transition latency and failures;
- setup step timings and bounded sanitized logs;
- engine reconnects, protocol mismatches, and revision-gap recovery;
- resource allocation, active/idle time, and quota decisions;
- durable-write lag and restore results;
- reconciliation drift and orphan cleanup; and
- generation-replacement rollback and fork results, checkpoint integrity,
  replica lag and divergence, SSH/preview/forward grant outcomes, and
  per-device tunnel health.

Do not set public reliability or latency promises until measurements exist from
representative regions, repositories, agents, stop/wake cycles, and long-lived
connections.

## Provider portability

The provider interface owns compute/image identifiers, endpoint grants,
lifecycle calls, usage, and logs. Application schemas store a provider name and
opaque provider connection/resource ID behind the stable Zeros workspace ID.
Resolve a connection's credential only inside the coordinator. Provider
features such as snapshots, volumes, and preview URLs are optimizations, not the
only recovery or public identity mechanism.

## Durable services

PostgreSQL owns structured tenant identity, authorization, lifecycle, settings
versions, cursors, audit, usage, and ordering. The
`CloudWorkspaceObjectStore` boundary owns encrypted file blobs, checkpoints,
transcript artifacts, and full bounded logs. The hosted implementation can use
a private mounted Railway volume through the hardened filesystem adapter; a
future S3-compatible or customer-owned adapter must preserve conditional
publication, strong read-back, integrity, deletion, and tenant-key contracts.
An optional queue/cache may accelerate workers but cannot be the sole durable
record. Use a transactional outbox so database commits and asynchronous work do
not diverge.

The hosted Railway deployment keeps database, object-storage, worker, and
encryption endpoints configurable. A future template must ship health,
migration, upgrade, backup/restore, key-rotation, and deletion procedures; a
deploy button by itself is not a supported self-hosted product.

## Controlled migration rollout

`0023_cloud_workspace_engine_authority.sql` is deliberately marked
`zeros:requires-controlled-downtime`. It takes an `EXCLUSIVE` lock on
`cloud_workspaces` before altering the engine table so a live workspace-first
transaction cannot form a schema-lock/row-lock cycle. Reads may continue, but
workspace row lockers are drained and blocked until that migration commits.

For every environment that has not yet applied `0018`:

1. stop API, reconciler, setup, and access-revocation processes that can mutate
   cloud workspace tables; do not use a rolling old/new process overlap;
2. take and verify a PostgreSQL backup and record the currently deployed commit
   and migration ledger;
3. set
   `CONTROL_PLANE_MIGRATION_APPROVALS=0023_cloud_workspace_engine_authority.sql`
   only on the one migration runner and apply the same reviewed commit that will
   be deployed;
4. verify `schema_migrations`, the authority-retirement triggers, queued provider
   deletion for any already-deleted owner scope, and normal health checks;
5. remove the one-time approval, deploy the matching processes, and monitor lock
   waits, lifecycle/setup queues, access-revocation backlog, and provider drift.

If the migration cannot obtain its boundary in the approved window, stop it and
investigate the remaining workspace transaction. Do not bypass the marker or
start a second migrator. PostgreSQL rolls an uncommitted migration back; service
rollback must still use binaries compatible with the ledger actually observed.

## Current validation harness

The operator-only harness in
[`scripts/cloud-workspace-validation/`](../../scripts/cloud-workspace-validation/README.md)
tests image creation, engine boot, bridge and PTY round trips, stop/start
reconnect, egress, lifecycle latency, socket soak, production-adapter private
preview and SSH forwarding, a managed drain/candidate-delete/source-wake
rollback matrix, and cleanup. The adapter-created qualification resources have
a one-hour auto-stop plus the configured auto-delete backstop in case the
runner dies before its `finally` cleanup. Public CI cannot claim those provider-
account checks passed.

Before production setup execution is enabled, complete the full sequence and
store dated results in the private operational system. Never commit provider API
keys or generated connection state.

## Current desktop access boundary

Electron main owns cloud access issuance, provider credentials, native SSH
configuration, Terminal/IDE launch, preview-header admission, and tunnel process
lifetime. The renderer receives only bounded receipts, bearer-free navigation
URLs, and exact loopback mappings. App exit or account replacement clears local
preview authority and stops tunnels immediately; remote revocation is attempted
while a valid account session remains, with provider TTL and durable lifecycle
revocation as backstops.

The service boundary is unit-tested on Linux, but Terminal/IDE launch, pinned
OpenSSH host-key behavior, tunnel teardown, app signing/notarization, and
provider token revocation still require the protected macOS/live-Daytona
qualification. Production builds fail closed without a verified key for every
allowed gateway; TOFU exists only as an explicit development escape hatch. The
desktop catalog/details UI and automatic collision-free local-port selection
are later product wiring, not evidence supplied by this boundary.

## Deployment ownership

- Railway deployment configuration stays with `apps/control-plane/`.
- Cloudflare Pages management UI stays with `apps/web/` while it shares that
  deployment.
- Provider-validation scripts stay outside shipping application graphs.
- Add a separate execution-coordinator app only if it becomes independently
  built, deployed, scaled, and operated.
