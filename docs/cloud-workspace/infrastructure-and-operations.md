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
- resource allocation, active/idle time, compute-quota decisions, durable
  object-storage admission/rejection, and rotation-reservation backlog;
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

For the filesystem adapter, attach one Railway volume to one control-plane
service instance and mount it at a parent such as `/data`. Configure
`CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY` as a dedicated child such as
`/data/zeros-workspace-objects`, never as the mount root. The child must already
be, or be creatable as, mode `0700`, owned by the exact runtime UID; the adapter
rejects a different owner or any group/world permission before object access.
Railway [mounts volumes as
root](https://docs.railway.com/volumes#permissions), and the current
control-plane image runs as root. If that image changes to a non-root user,
update volume ownership deliberately and validate the runtime UID before
enabling cloud storage.

Railway [volumes do not support replicas and prevent two deployments from
being active on the same mounted
service](https://docs.railway.com/volumes/reference#caveats). Keep the
filesystem-backed control plane at one replica and do not introduce a sidecar,
shell, maintenance process, or second service that writes the live directory.
Move to a shared object-store adapter before horizontal scaling. The
`.uploads-v2` tree is adapter-owned, bounded staging state; operators must not
edit or clean it manually. Permanent per-key fence directories retain opaque
Organization/blob UUID path components after database tombstone privacy purge
so a delayed writer cannot resurrect an erased immutable key. They contain
neither plaintext object bytes nor account identifiers and must remain in
backups and restores.

Organization compute quotas are operator-approved admission records, not
Organization-admin settings. Provision or change them only through
`pnpm --dir apps/control-plane cloud-quota:manage` from a source checkout, or
the supported `node dist/manage-cloud-workspace-quota.js` entrypoint in the
production image. First generate a read-only target-bound plan, then execute
its exact approval with `--execute` from a controlled database-owner shell. The
command refuses Personal/deleted/ineligible tenants, non-platform-owner
attribution, stale plans, and limits below current usage; the same transaction
writes append-only owner evidence. Quota provisioning is independent of
`CLOUD_WORKSPACES_ENABLED` and
`CLOUD_WORKSPACE_SETUP_WORKER_ENABLED`.

Durable object-storage limits are a second, independent owner-managed boundary.
Provision or change them with
`pnpm --dir apps/control-plane cloud-object-storage:manage`, using the same
read-only-plan/exact-approval pattern and active platform-owner attribution.
Inside the production image use the supported
`node dist/manage-cloud-workspace-object-storage.js` entrypoint. Append
`--execute` only after copying the exact target-bound approval from the
read-only plan.
The Organization byte limit covers physical tenant blobs, detached-upload
deletion tombstones, and copy-on-write rotation reservations; the workspace
byte limit covers logical unique blob reservations and cannot exceed the
Organization byte limit. The command
rejects an incoherent pair or a limit below either current measure and writes
append-only evidence. It does not change provider sandbox
`storage_mib`, resize the Railway volume, or enable either cloud feature gate.

The physical object-store quota remains an infrastructure backstop. Keep it
above the aggregate application limits with reviewed allowance for filesystem
metadata, atomic-publication temporaries, backups, and incident response.
Alert before that headroom is consumed; application rejection is not a
substitute for provider capacity monitoring.

Terminal object-key rotation failures are owner-managed recovery events, not
automatic scheduler input. The ordinary scheduler never rewrites a failed job.
From a database-owner shell, use
`pnpm --dir apps/control-plane cloud-object-rotation:retry` (or
`node dist/manage-cloud-workspace-object-rotation.js` in the production image)
to generate a read-only plan for one exact Organization/blob/target version;
then rerun the unchanged request with its target-bound approval and `--execute`.
The command requires an active `platform_owner`, the complete source-and-target
keyring, a terminal released job, and a durable zero-byte fence for the prior
target. It appends immutable evidence and queues a fresh unpredictable target;
workers still have to claim, reserve capacity, copy, verify, publish, and clean
up before the rotation is successful. Deploy the corrected full keyring to
every replica first, preserve copy-on-write headroom, monitor health and the
rotation/deletion backlogs, and retain the old key until live rows and required
backups prove it is no longer needed. The detailed one-shot variables and
production confirmation are documented in the control-plane README.

Secret bindings and one-use setup material share a versioned coordinator
keyring, but their persisted rows retain the exact encryption-key version used.
During rotation, deploy every readable old key plus the new key, select the new
current version, rotate bindings and replace affected generations, then prove
that no live/retained row or restorable backup requires the old key before
removing it. The object-storage keyring is separate and follows its own
copy-on-write rotation workflow.

The hosted Railway deployment keeps database, object-storage, worker, and
encryption endpoints configurable. A future template must ship health,
migration, upgrade, backup/restore, key-rotation, and deletion procedures; a
deploy button by itself is not a supported self-hosted product.

## Controlled migration rollout

Two exact cloud migration ladders existed before their main merge: commit
`a80ac25` used `0013`–`0018`, and commit `c2b7418` used `0018`–`0050`. The
runner has explicit filename maps from those two histories to canonical
`0020`–`0052`; it does not guess by subtracting a sequence number or matching a
cloud prefix. It records a checksummed canonical alias instead of replaying DDL.
Migration `0053` then restores the permanent Personal local-only constraint. If
it finds a legacy Personal-owned cloud workspace, it stops without deleting or
reassigning data; move that workspace to an Organization before retrying.

Migration `0055` backfills logical reservations for existing blob references
but deliberately creates no Organization limit. After applying it, configure a
reviewed limit for every active cloud Organization before resuming object
writes or key-rotation workers. Existing bytes remain readable and count toward
the first plan. Migration `0056` removes the legacy raw secret-value digest;
existing AES-GCM rows remain at verifier scheme 0 until a normal binding
rotation writes a keyed verifier. Keep version 1 in the deployment keyring while
those ciphertexts or backups remain readable. Migration `0057` adds only the
blob-deletion foreign-key and previously uncovered `SKIP LOCKED` claim indexes
identified by the catalog/query audit; it changes no serialized state.
Migration `0058` forward-applies the object-storage ceiling relationship for
databases that recorded an earlier feature-branch draft of `0055`. Migration
`0059` makes entitlement activation time a lower bound in both admission and
live runtime authority. Migration `0060` durably retains the exact object key
and physical-byte charge when an expired pending upload is detached. Successful
physical deletion reduces the row to a permanent zero-byte database fence so a
late writer can never republish that immutable key; tenant privacy purge removes
the database identity only after readiness is proven. Migration `0061` adds the
append-only exact-subject WorkOS erasure fence and historical-purge
reconciliation ledger. Until every old purge has evidence, unknown WorkOS
subjects fail closed while exact active mappings remain usable.

`0025_cloud_workspace_engine_authority.sql`,
`0060_cloud_workspace_pending_blob_deletions.sql`, and
`0061_workos_provider_erasure_fences.sql` are deliberately marked
`zeros:requires-controlled-downtime`. Migration `0025` takes an `EXCLUSIVE` lock
on `cloud_workspaces` before altering the engine table so a live workspace-first
transaction cannot form a schema-lock/row-lock cycle. Migration `0060` changes
the live blob uniqueness and deletion protocol, backfills every reconstructable
terminal object key, and moves old failed rotations into owned target cleanup.
The pre-`0060` uploader cannot target its partial uniqueness rule and the old
garbage collectors do not create durable deletion fences, so no old API or
worker may overlap `0060` or the binaries deployed after it. A pre-`0061`
deletion worker can erase a WorkOS mapping without an exact durable subject
fence, so every old deletion worker must be stopped and drained before `0061`
is applied. Do not restart one after the boundary.

For every environment that has not yet applied `0025`:

1. Set both `CLOUD_WORKSPACES_ENABLED=false` and
   `CLOUD_WORKSPACE_SETUP_WORKER_ENABLED=false`. Do not put
   `CONTROL_PLANE_MIGRATION_APPROVALS` on the Railway web service; production
   boot ignores it even if it leaked from an earlier operation.
2. Determine whether any pre-`0025` cloud state exists, including a quota,
   workspace, generation, provider resource/orphan, lifecycle intent, endpoint
   or client grant, setup record/material, engine instance, or generation
   transition. The boot runner repeats this under system RLS context and fails
   closed if it finds any row.
3. Stop any older API, reconciler, setup, access-revocation, or other process
   that can mutate cloud workspace tables. Take and verify a PostgreSQL backup;
   record the deployed commit, full migration ledger, and runtime flags. Do not
   use an old/new process overlap at the migration boundary.
4. If the state check is empty, deploy the reviewed release with no approval on
   the service. This is Alpha's safe `main` autodeploy path: boot applies only
   the safe prefix, stops before `0025`, and serves the non-cloud API. Require
   `/healthz` to return HTTP 200 with
   `migrations.state=controlled_migration_pending` and the exact filename.
   Every public/internal cloud route must return the non-cacheable
   `503 controlled_migration_pending` response, while unrelated API smoke tests
   pass. Confirm the canonical ledger has no row beyond `0024`.
5. If any pre-boundary cloud state exists, the new web process intentionally
   cannot enter that healthy-pending mode. Keep the environment drained and
   proceed directly with the strict migrator from the reviewed production image.
6. From a controlled database-owner shell in that exact image, run the compiled
   one-off command with the approval scoped to that process only:

   ```bash
   NODE_ENV=production \
   CONTROL_PLANE_MIGRATION_APPROVALS=0025_cloud_workspace_engine_authority.sql,0060_cloud_workspace_pending_blob_deletions.sql,0061_workos_provider_erasure_fences.sql \
   node dist/migrate.js
   ```

   (`pnpm --dir apps/control-plane migrate` is the source-checkout equivalent.)
   The command serializes against every boot runner. All three exact approvals
   are required because this path crosses all three cloud-era controlled
   boundaries. It never
   skips an unapproved migration to apply a suffix, and service boot cannot use
   either approval to execute a migration.

7. Verify that canonical `schema_migrations` now runs contiguously through the
   release tip with non-null checksums, then inspect the authority-retirement
   triggers and queued provider deletion for any already-deleted owner scope.
   Run `node dist/manage-workos-provider-erasure.js --status`; reconcile every
   unresolved historical purge from provider-side audit evidence before
   accepting new WorkOS subjects.
8. Remove the one-time approval everywhere and restart/redeploy the same commit.
   Require `/healthz` to omit the pending migration state and pass normal API
   smoke tests.
9. Enable cloud runtime, if planned, only in a separate deployment after its
   live qualification. Monitor lock waits, lifecycle/setup queues,
   access-revocation backlog, and provider drift.

For every environment whose canonical ledger is already through `0059` but not
`0060`:

1. Set both cloud feature defaults to `false`. Stop and prove stopped every old
   API, reconciler, setup, object-maintenance, retention, deletion, fork,
   checkpoint, replica, access-revocation, and operations process that can read
   or mutate cloud state or the object store. Take and verify a PostgreSQL
   backup, preserve the object-store snapshot, and record the deployed commit,
   complete ledger, keyring versions, and runtime flags.
2. Inventory `pending_upload`, `deleting`, and `deleted` blob rows, every
   non-terminal or failed rotation, storage reservations, and physical object
   keys before approval. Migration `0060` reconstructs fences from retained
   deleted blobs and successful rotation source keys and conservatively queues
   failed rotation targets. It cannot reconstruct an abandoned-upload identity
   that a pre-`0060` garbage collector already removed from PostgreSQL. If such
   a worker ever ran, reconcile object-store keys against retained blob and
   rotation identities and quarantine any unexplained key before proceeding.
3. Deploy the reviewed `0060`/`0061`-aware image to the web service without a
   migration approval. With cloud runtime disabled, service boot must remain at
   `0059`, `/healthz` must report `controlled_migration_pending` with the exact
   `0060` filename, every cloud route must return the non-cacheable
   pending-migration `503`, and unrelated API smoke tests must pass. Existing
   cloud rows are expected and do not prevent this pause. Confirm no `0060`
   ledger row exists.
4. From a drained database-owner shell in that exact image, run only the strict
   one-shot migrator with the approval scoped to that process:

   ```bash
   NODE_ENV=production \
   CONTROL_PLANE_MIGRATION_APPROVALS=0060_cloud_workspace_pending_blob_deletions.sql,0061_workos_provider_erasure_fences.sql \
   node dist/migrate.js
   ```

   Without both exact filenames it fails. A standing approval on the web
   service is ignored and must never be used as a substitute for the drained
   window.

5. Verify that the canonical ledger is contiguous through the release tip with
   non-null checksums (including `0061`). Inspect the new deletion-fence backlog,
   confirm old failed rotations
   are in `target_cleanup_pending` with conservative reservations, and confirm
   retained deleted blobs and successful old rotation sources have an unfenced
   tombstone ready for the new worker. Run the WorkOS provider-erasure status
   command and reconcile every unresolved historical purge from provider-side
   evidence. Remove the one-time approval everywhere.
6. Restart only `0061`-aware binaries. Keep cloud runtime disabled until normal
   qualification is complete, then enable it in a separate deployment and
   monitor the object-deletion/rotation backlog and physical-byte headroom. Do
   not roll an environment whose ledger contains `0060` or `0061` back to a
   binary from before the recorded boundary; restore the coordinated backup or
   roll forward instead.

For an environment already through `0060` but not `0061`, use the same drained
deployment discipline without repeating the object migration: stop and prove
stopped every old deletion worker, verify a database backup, deploy the reviewed
image without approval, and require `/healthz` to report exact pending migration
`0061_workos_provider_erasure_fences.sql`. Run the strict migrator with only
that exact one-process approval. Verify the checksummed ledger, run
`node dist/manage-workos-provider-erasure.js --status`, reconcile every
unresolved request from provider-side evidence, remove the approval, and only
then restart the same `0061`-aware image. Known active WorkOS mappings remain
usable while `0061` is pending; unknown subjects return a retryable unavailable
response and no raw callback or event payload is persisted.

If the migration cannot obtain its boundary in the approved window, stop it and
investigate the remaining workspace transaction. Do not bypass the marker or
start a second migrator. PostgreSQL rolls an uncommitted migration back; service
rollback must still use binaries compatible with the ledger actually observed.
The migration client deliberately has no ordinary request statement timeout;
operator cancellation or the deployment window is the boundary for this
controlled lock wait.

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
