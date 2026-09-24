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

## Health alerts

`/healthz` reports aggregate cloud health: `operationalState` is `healthy` or
`degraded`, with machine-readable `reasons`. It carries no tenant, workspace,
user, provider-resource or repository identifier, and neither do alerts.

- **In-service alerts.** With `OPERATIONS_ALERT_EMAIL` set and Resend
  configured (`RESEND_API_KEY`, `EMAIL_FROM`), the service reads health every
  60 seconds, including while background workers are paused. Two consecutive
  degraded reads open a numbered incident and email its reasons. A different
  reason set that holds for two reads, or each new six-hour window, sends an
  update, and two healthy reads send the recovery. Alert state is one locked
  row (migration `0097`), so replicas and deploys agree, and a failed send is
  retried with the same Resend idempotency key and body. An invalid mailbox
  disables alerts with a warning rather than failing boot.
- **External uptime.** `.github/workflows/uptime.yml` probes the HTTPS
  `/healthz` URLs in the repository variable `UPTIME_HEALTH_URLS` every ten
  minutes, with three attempts 20 seconds apart. An unreachable, non-200,
  `ok: false` or unreadable-health target fails the run, and GitHub Actions
  notifies the workflow owner. Route that account's Actions notifications to
  the operator mailbox. Degraded cloud health appears in the run summary
  without failing it, because the in-service worker already emails it.

## Health alert runbooks

Each reason names the exact `/healthz` condition. Start from the reason, not
from a single workspace: several workspaces can share one cause. Operator
commands below run from a database-owner shell, print a read-only plan with a
target-bound approval, and change nothing until rerun unchanged with
`--execute` and that approval.

| Reason | Condition | First response |
| --- | --- | --- |
| `lifecycle_stalled` | A queued or observing lifecycle intent has not advanced for 15 minutes. | Confirm background workers run, then read the intent `error_code` (for example provider rate limits, `compute_previous_lease_pending` or `provider_absence_unconfirmed`). Fix the provider or credential cause. For a create the provider can no longer certify, prove absence from the full account inventory with `cloud-provider-absence:manage`. |
| `setup_lease_expired` | A running setup run's lease expired. | The setup worker or its provider exec died mid-run. Check the setup worker log and the provider; recovery re-admits the generation. Repeats point to a crash loop or an exec that exceeds the setup timeout. |
| `engine_lease_expired` | A ready engine missed its 90-second heartbeat lease. | Check the sandbox at the provider and the engine log. A healthy engine that cannot reach the control plane (network, TLS or a 429 on registration or heartbeat) stops itself when its lease runs out. |
| `access_revocation_stalled` | A client access grant failed or waited more than 15 minutes for revocation. | Check the provider's revoke API and credential. The worker retries; a failed grant needs the provider cause fixed first. |
| `outbox_stalled` | A cloud outbox entry is dead, or queued or processing for 15 minutes. | Check the configured outbox sink's reachability and signing secret. |
| `deletion_jobs_failed` | A workspace deletion job failed. | Read the job error and resolve it through the staff deletion operations; never purge around a provider that has not confirmed deletion. |
| `deletion_provider_stalled` | A deletion waited more than 24 hours for the provider. | Look up the provider deletion receipt (Boat `bdop_*`). Boat reports `blocked` while it retries; receipts have completed up to about 20 hours later, so keep the job waiting. Once every receipt has completed, the job also needs each generation's binding verified deleted (`deletion_verified_at`). |
| `object_rotation_failed` | A blob rotation failed, or cleanup is stuck for 15 minutes or three attempts. | Fix the object-store or key cause, then queue a fresh target with `cloud-object-rotation:retry`. |
| `object_deletion_stalled` | An unfenced blob deletion is 15 minutes old or failed three times. | Check object-store credentials, reachability and the bucket's retention settings. |
| `provider_orphans_stalled` | A provider orphan has been unverified for an hour. | Compare the provider inventory for the account scope with the bindings and remove the orphan through the provider after confirming it is not bound. |
| `durability_stalled` | A ready or busy workspace has had non-durable content or record state for 15 minutes. | Check the engine's checkpoint uploads, object-store health and the byte limits (`cloud-object-storage:manage`). |
| `compute_settlement_stalled` | An unsettled compute lease has had an error for 5 minutes, or its next check is 5 minutes overdue. | Read the lease `last_error_code`; failing leases retry with backoff up to five minutes. Meter or provider errors need provider access fixed; `compute_absence_unconfirmed` means the create journal cannot close until absence is proven with `cloud-provider-absence:manage`. `provider_not_found` or `compute_final_meter_unavailable` on a bound allocation the provider lost needs `cloud-provider-loss:manage`. |
| `compute_lease_expired` | An active or draining lease is 5 minutes past its provider expiry. | Check renewal, the Organization's credit (`cloud-compute:grant`) and the provider's TTL. A sandbox may be running unfunded. |
| `compute_platform_exposure` | Provider overrun was recorded as platform exposure in the last 24 hours. | Reconcile the provider meter against the ledger and review the affected credit period. |
| `health_query_failed` | The aggregate health query itself failed. | Check database connectivity, pool saturation and whether a migration is pending. |

## Recovery drills and measured limits

Batch 7 measured the isolated Alpha qualification deployment on September
23–24, 2026: one Railway control-plane replica, a single-node PlanetScale PS-5
cluster, private R2 object storage and managed Boat sandboxes, driven from
clients in another US region. These are single-region engineering baselines,
not public reliability or latency promises.

| Area | Measured | Limit or rule |
| --- | --- | --- |
| Database and object restore | A point-in-time PlanetScale branch at an exact timestamp was ready in 102 s, and a control-plane service on it passed health 17 s later. Verifying 144 unchanged tables and decrypting all 4,363 live objects took another 254 s: 6 min 41 s in total. | RPO is the chosen restore point: every row committed before it was present and none after. Point-in-time restore reaches back about 48 hours. Expect about 7 minutes of operator work before a traffic cutover. |
| Objects referenced after restore | Every object the restored rows referenced was present. | Live objects outlive their last reference by `CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS` (48 hours). Key rotation deletes superseded ciphertext at once, so restore to a point after a rotation finished. |
| Provider-host loss | The engine's authority lapsed 90 s after its last heartbeat. The workspace became `failed` (`provider_not_found`) 5 min 20 s after the sandbox was destroyed, when the provider first returned not found for it. After `cloud-provider-loss:manage` recorded the loss, the compute lease settled 5 s later at its last meter. Recovery from the last checkpoint reached `ready` 73 s after the request: the file written before that checkpoint came back, and the one written after it did not. | Work since the last durable checkpoint is lost. Engines checkpoint every 5 minutes, and stop or archive takes a final checkpoint. An operator must attest the loss with `cloud-provider-loss:manage` before recovery. |
| Engine process loss | Compute stopped 106 s after the engine was killed mid-command: its 90 s lease plus reconciliation. The interrupted command's receipt became `uncertain`, it was never re-dispatched, and the conversation paused. Wake reached `ready` in 68 s. | The owner decides whether to repeat an uncertain command. |
| Control-plane outage | A normal deploy during a turn kept the engine and the turn running; device bridges reconnected. During a 12-minute crash, engines lost authority when their leases expired (81 s). On recovery the engine was revoked and the workspace stopped within 10 s. The sandbox kept billing throughout. | Recover a crashed deployment with a redeploy: restarting a deployment whose restart policy is `NEVER` left it crashed. The uptime probe checks every 10 minutes. |
| Approvals | From a second device seeing a permission prompt to its durable approval receipt, with Claude Haiku 4.5: about 6.2 s before the September 23 round-trip changes and 4.8–5.5 s after them. The approval's own receipt transaction takes 2.2–2.7 s of that. | Each engine request is one transaction of sequential statements. Each statement costs about 25 ms between the control plane and the database, and the receipt transaction also waits on the agent-execution checks running beside it. |
| Event streams | Over 30 minutes, two workspaces with three devices each answered 408 of 408 pings with no reconnects. Fan-out lag was 3 ms at p95 and 89 ms at most. Replay after a 20 s disconnect was contiguous and complete: 86 and 63 frames in one page, in about 1.1 s. | — |
| API | 11,292 requests in 25 minutes at four-way concurrency: p50 about 440 ms, p95 1.2 s, p99 2 s. | Each user gets 240 `/v1` requests per minute; the API returns 429 beyond that. Engine lifecycle routes use a separate per-address bucket. |
| Database connections | PS-5 allows 25 connections. Peak use was 19 backends, 7 of them the application. | Keep every replica's pool plus operator sessions under the cluster limit. |
| Control-plane resources | CPU peaked at 0.15 vCPU and memory at 475 MB. | — |
| Object-key rotation | 4,366 objects (75 MB) moved to a new key with no failures in 3 h 7 min: about 1.9 s per object, one at a time, in batches of up to 100 with a minute between batches. Afterwards every object was read back with only the new key in 3.5 minutes. | About 23 objects per minute per worker, so a large store takes days. Keep the old key in the keyring until rotation finishes. |
| Lifecycle races | Two deletes and an archive sent at once produced one outcome: the newest intent ran and the others were superseded. A wake over the running quota returned 409 `cloud_quota_exceeded`. | — |

### Disaster recovery drill

Run the drill against a disposable restore target. It does not replace the
production source.

1. Record row counts and hashes, plus the live object inventory, around a chosen
   restore point. Include a probe row written just before it and one just after.
2. At least five minutes later, create a PlanetScale branch from the source
   branch at that point in time. Mint a short-lived runtime role on it.
3. Start a temporary control-plane service on the branch with
   `CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED=false`, so it does not reconcile
   providers, deliver the outbox or send invitations. Leave
   `OPERATIONS_ALERT_EMAIL` unset: health alerts run even while workers are
   paused.
4. Verify:
   - health and an owner's authenticated API calls
   - the probe boundary: the earlier probe is present and the later one absent
   - identical hashes for every table that did not change after the point
   - the migration ledger
   - every live object read through the application decryptor and matched to
     its plaintext digest
5. Delete the temporary service, its variables and the branch.

A real restore then fences the old writers and reconciles provider outcomes and
revocations before it resumes background work, as described in
[database qualification](database-qualification.md#recovery-and-cutover).

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
a private S3-compatible bucket through the shared S3 adapter or a mounted volume
through the filesystem adapter. Both preserve conditional publication, bounded
read-back, integrity, deletion fences, and tenant-key contracts.
An optional queue/cache may accelerate workers but cannot be the sole durable
record. Use a transactional outbox so database commits and asynchronous work do
not diverge.

For R2/S3, set `CLOUD_WORKSPACE_OBJECT_STORE_KIND=s3`, the HTTPS service origin
in `CLOUD_WORKSPACE_S3_ENDPOINT` (no bucket path), `CLOUD_WORKSPACE_S3_REGION`,
`CLOUD_WORKSPACE_S3_BUCKET`, and bucket-scoped `CLOUD_WORKSPACE_S3_ACCESS_KEY_ID`
and `CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY`. Omit the filesystem directory. Keep
the bucket private, with public development URLs and public custom domains
disabled. The adapter publishes ciphertext with `If-None-Match: *`; deletion
atomically replaces the same key with a permanent zero-byte fence. A late PUT
cannot recreate that key. Do not apply lifecycle rules that remove these
fences, and preserve them in disaster recovery. Provider delete permissions are
not required by this adapter. R2 documents its [S3 operation and conditional
request support](https://developers.cloudflare.com/r2/api/s3/api/).

Shared storage removes the filesystem single-writer restriction, but does not
by itself qualify API/relay replicas. Replica rollout also requires concurrent
command/replay, route ownership, lease fencing, and reconnect load tests.

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

A Boat create journal whose outcome can never be certified (a pre-0093
untracked journal, or dispatches whose refusal was not recognized) keeps its
reservation open and blocks deletion and purge. Resolve it only through
`pnpm --dir apps/control-plane cloud-provider-absence:manage` (or
`node dist/manage-cloud-provider-absence.js`) with the same plan-then-execute
approval, from a database-owner shell holding the deployment's `BOAT_API_KEY`
and `BOAT_ACCOUNT_SCOPE`. Name the workspace, generations, the Boat account that
owns the scope and any known non-workspace sandboxes, such as an image builder,
in `CONTROL_PLANE_PROVIDER_ABSENCE_*`. The command reads the complete Boat
account inventory, proves the key owns the scope by reading back one of its
deletion receipts, and refuses a listing that omits a sandbox the scope still
holds, any listed sandbox not bound in that scope's journal, dispatches newer
than two hours, and an active create, wake or generation transition.
Generations the service can already close are reported unchanged. Its
append-only attestation covers dispatches only up to a recorded instant; the
service then closes each generation and releases its reservation through the
ordinary absence check. Attest untracked journals only after every pre-0093
writer has been retired.

A bound Boat allocation the provider lost (its sandbox and usage meter return
404) leaves the workspace `failed` with `provider_not_found` and its compute
lease draining; `compute_settlement_stalled` alerts after five minutes. First
confirm the loss with the provider. Then run
`pnpm --dir apps/control-plane cloud-provider-loss:manage` (or
`node dist/manage-cloud-provider-loss.js`) with the same plan-then-execute
approval and credentials, naming the workspace, generation, exact sandbox id and
Boat account in `CONTROL_PLANE_PROVIDER_LOSS_*`. The command reads the complete
account inventory and looks the sandbox up directly. It refuses a listing that
still contains the sandbox or omits another sandbox the scope holds, any lookup
other than not found, an allocation Zeros is already deleting, and a live
engine. Its append-only attestation marks the journal lost and asks the lease to
settle now: reservations finalize at the last meter and the health reason
clears. The owner then recovers the workspace's durable checkpoint into a new
generation; work after that checkpoint is lost with the allocation.

`CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED=false` makes a process an API-only
replica: cloud reconciliation, access retirement, checkpoint/fork, object
maintenance, operations/outbox, invitation and setup loops do not start.
`/healthz` reports `cloudWorkspaces.backgroundWorkers=paused`. The default is
`true`. Running workspaces require an enabled worker replica; the flag is not a
provider kill switch for explicitly invoked API operations. Isolated account
and collaboration qualification can use it with setup disabled while compute
qualification is paused. Authentication and current-authority checks remain
active on API requests.

Durable object-storage limits are a second, independent owner-managed boundary.
Provision or change them with
`pnpm --dir apps/control-plane cloud-object-storage:manage`, using the same
read-only-plan/exact-approval pattern and active platform-owner attribution.
Inside the production image use the supported
`node dist/manage-cloud-workspace-object-storage.js` entrypoint. Append
`--execute` only after copying the exact target-bound approval from the
read-only plan.
The Organization byte limit covers physical tenant blobs, detached-upload
deletion tombstones, and copy-on-write rotation reservations. Physical blobs
include content deleted within the restore window (48 hours by default),
which keeps counting until collection; the workspace
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
   CONTROL_PLANE_MIGRATION_APPROVALS=0009_organization_team_hierarchy.sql,0025_cloud_workspace_engine_authority.sql,0060_cloud_workspace_pending_blob_deletions.sql,0061_workos_provider_erasure_fences.sql,0073_cloud_workspace_compute_leases.sql,0075_security_event_commit_order.sql,0076_cloud_workspace_individual_pro_and_pilot.sql,0079_cloud_workspace_user_compute_funding.sql \
   node dist/migrate.js
   ```

   (`pnpm --dir apps/control-plane migrate` is the source-checkout equivalent.)
   The command serializes against every boot runner. The command includes all
   eight exact approvals: the core-schema boundary and seven cloud-era controlled
   boundaries. Every pending controlled migration requires its approval. It never
   skips an unapproved migration to apply a suffix, and service boot cannot use
   these approvals to execute a migration.

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
   CONTROL_PLANE_MIGRATION_APPROVALS=0009_organization_team_hierarchy.sql,0025_cloud_workspace_engine_authority.sql,0060_cloud_workspace_pending_blob_deletions.sql,0061_workos_provider_erasure_fences.sql,0073_cloud_workspace_compute_leases.sql,0075_security_event_commit_order.sql,0076_cloud_workspace_individual_pro_and_pilot.sql,0079_cloud_workspace_user_compute_funding.sql \
   node dist/migrate.js
   ```

   Without the exact approval for every pending controlled migration it fails
   before applying any migration. A standing approval on the web
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
