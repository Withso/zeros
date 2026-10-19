# Recovery after a stopped snapshot is lost

An organization-cloud workspace whose stopped Boat snapshot is confirmed missing
recovers into a new generation from its latest available durable checkpoint. The
new generation uses the organization's current, ready **named Computer snapshot**
at recovery admission. The source generation keeps its original Computer,
runtime, checkout and provider pins. Later Computer activations do not change the
accepted replacement.

This is an implemented control-plane and desktop contract. Boat response shapes
and the complete recovery path still require live qualification before rollout.
The control plane does not infer loss from a 14-day local timer.

## Verify the checkpoint before provider expiry

Normal stop/archive and idle-stop require a final checkpoint. A forced, failed or
discard stop does not establish the same coverage. Do not declare a stopped disk
safe solely because the database has a durable checkpoint row. Before the provider
retention deadline, verify its retained object bytes and classify its coverage.

`pnpm --dir apps/control-plane exec tsx src/verify-cloud-workspace-checkpoint.ts`
plans by default. It permits Alpha only, requires a matching Alpha Railway
deployment, one exact organization/workspace and an active organization admin or
owner. Personal owners, running workspaces and unconfirmed provider stops are
refused. Supply the normal secure `DATABASE_URL` and these environment variables
with prefix `CONTROL_PLANE_CHECKPOINT_VERIFICATION_`:

- `CHANNEL`: `alpha`, with `RAILWAY_ENVIRONMENT_NAME=alpha`.
- `ORGANIZATION_ID`, `EXPECTED_ORGANIZATION_SLUG`, `ACTOR_USER_ID`: exact owner identity.
- `WORKSPACE_ID`: the stopped organization-cloud workspace to check.

The metadata plan has `state: planned`, a target fingerprint, the current
checkpoint identity, object count/bytes and coverage. It does not read payloads
or load object credentials. Add `--verify` to read and decrypt each retained
object through the deployed storage configuration, validate its length/hash and
recheck authorization, generation, authority, workspace version, checkpoint head
and the complete object set before returning `state: verified`. Manifest, file
entries, legacy artifacts and native `:v2` chunk references are all included.
Recovery admission also rejects unavailable native chunks.

Reads are sequential and bounded to 50,000 objects, 10 GiB total and five minutes.
Any missing/corrupt object, changed authority/head or exceeded bound refuses the
receipt. Plaintext is discarded and wiped; neither payloads nor provider/database
error details are printed. The operator makes no lifecycle/database writes,
Boat calls or implicit wake. Keep its JSON receipt in private rollout evidence,
not committed source. It describes a particular checkpoint at verification time;
workspace/organization erasure remains authoritative.

`coverage: final_checkpoint` means the existing final-stop proof still covers the
current generation and content/record revisions. `checkpoint_only` verifies only
the recorded checkpoint and cannot account for later work on the stopped disk.
For an absent/unverifiable checkpoint or insufficient final coverage, use the
owner-approved start-then-stop fallback before that sandbox's provider deadline,
then verify the new final checkpoint. This resets Boat's stop clock only after
the product path confirms the next stop. Do not infer a reset from a request or
change heartbeat, billing or idle-stop policy for this procedure.

Object verification is separate from import qualification. Before relying on it,
exercise the ordinary checkpoint recovery path on an owned `zd-` Alpha workspace,
checking repository/Git content and supported history after fresh-generation
readiness, then delete the throwaway VM through the product path. Record the
exclusions below. No local test or object receipt claims a whole-disk restore.

## Evidence and authority

The Boat adapter admits `provider_snapshot_missing` only for a journal-owned,
identity-matched sandbox in `archived` state with explicit
`snapshotAvailable: false`, `lastSnapshotStatus: "completed"` or explicit `null`,
and a matching billing wallet. A conflicting source echo is refused. Omitted
fields, pending or failed capture, malformed responses, generic errors and an
unconfirmed 404 do not authorize automatic recovery. Confirmed allocation loss
remains the separate `provider_resource_lost` workflow.

Only the owner of the current, unexpired wake claim can enqueue recovery, bound
to its workspace, organization, generation, provider allocation and authority
epoch. Enqueue revokes source runtime access, advances authority, pins the current
durable checkpoint and queues the normal access/compute drain. The durable worker
then takes organization-first admission locks and rechecks owner, membership,
policy, paid authority, checkpoint availability and lifecycle cancellation.

No candidate is allocated until source drain is confirmed. The existing finite
compute leases, allocation journal, capacity/funding waits, one-hour automatic
recovery budget, deadline and candidate rollback rules apply. A missing or invalid
checkpoint leaves the workspace in `recovery_needed`. There is no same-generation
recreation or passive-read wake.

For this confirmed missing-snapshot cause, automatic recovery can use a periodic
checkpoint that does not prove zero loss: the provider has confirmed the stopped
copy cannot resume. Other immutable-restore failures retain their lossless
checkpoint requirement. Ordinary explicit recovery still requires potential-loss
acknowledgement when its checkpoint is not lossless.

## Selecting the replacement

Recovery selects the current Computer under the organization/head locks. It
requires a ready, verified named artifact with matching source provenance and
provider account/wallet. The current config must include the same canonical
GitHub repository ID and owner/name, with an active installation read grant.
An unmigrated stopped-builder-only current Computer cannot satisfy recovery.

The candidate retains the source CPU, memory and sandbox class, takes the current
Computer's qualified base/runtime/storage, copies accepted checkout metadata, and
resolves settings and repository installation against the new Computer config.
The saved checkpoint restores workspace content; the old builder is never forked.
Retries of a confirmed missing-snapshot incident select the current Computer when
they admit a new candidate. Recovery without that evidence retains its saved
source selection.

## What returns and what does not

Recovery restores the checkpoint's safe repository files, Git state/history,
supported conversation history, selected Design state and attachments. Exact
formats, bounds and exclusions are in the [native checkpoint contract](checkpoint-native-format.md).

This is not a whole-home or machine backup. Recovery does not restore arbitrary
home contents, ignored files or private configuration outside the explicit
checkpoint exports, credential files/provider grants, running agents or terminal
processes, development servers, arbitrary caches, or packages installed outside
the current Computer. Work newer than the durable checkpoint may be missing.
Fresh setup admits credentials and authority separately; saved transcripts do
not resume old execution claims.

A sealed native checkpoint can include the FULL command ledger and NORMAL engine
database main files. Setup verifies their seal/provenance and rebuilds supported
history under fresh authority; it does not reopen old live WAL/`-shm` or restore
the old writer's claims. Periodic checkpoints must not be assumed to contain a
fresh final writer seal. See [local queue recovery](data-and-sync.md#negotiated-local-queue-and-compact-history).

Checkpoint retention is independent of Boat's stopped-sandbox retention. Current
durable heads and generation recovery pins protect their referenced blobs under
the [checkpoint retention policy](checkpoint-native-format.md). Explicit workspace
or organization erasure remains separate.

## Dormant complete-checkpoint coordinator

`CloudCheckpointScheduler` has an optional `complete` mode for a future qualified
complete-data producer. The engine does not select it. The existing periodic
projection and recovery coverage above remain the deployed contract. Local
Personal and organization-local workspaces do not instantiate this cloud mode.

The mode requires explicit bounded scheduling inputs, an exact writer/scope
source, a complete-cut producer, a durable compare-and-swap attempt journal and
an operator observation sink. It has no default producer, journal or measured
production policy. A selected complete mode never falls back to a partial
projection. Its in-process types are not a negotiated server capability or a
public checkpoint wire format.

One coordinator debounces changes without resetting the earliest uncovered
change, applies a separate rate floor and retry time, and journals an immutable
attempt before producer I/O. An unconfirmed journal or producer outcome retains
custody and prevents a successor. Restart sees that pending attempt and requires
external reconciliation; silent change hints cannot establish a clean inventory.
The future change source must cover every writer and explicitly invalidate
coverage after overflow or other lost observations.

Accepted receipts bind the original attempt, writer, scope and covered sequences.
Later changes remain dirty. Operator evidence measures age from the data cut;
an upload acknowledgement cannot make an old cut appear fresh. Dirty age is
unknown until the observation interval is covered. Stale alerts are bounded and
deduplicated, and diagnostic failure has no retirement authority. No new notice
is sent to workspace users. Final capture must join or positively retire the
background lane and obtain its own fresh seal; a periodic receipt cannot finish
a lifecycle operation. Each final caller pairs its completed pause with one
resume; overlapping callers retain their own admission holds.

This coordinator alone supplies no whole-data or native consistency proof. Before
enrollment, qualify all-writer quiescence and immutable staging, the periodic
engine export, complete inventory and encryption, durable journal/storage
adapters, lifetime retention and independent restore. Measure cut pause,
debounce, maximum dirty age, transfer/rate and alert budgets against real data.
Cut, acknowledgement and persisted due times require a qualified common clock
contract; the coordinator's monotonic age floor covers observations within its
own process and is not an independent clock-recovery proof.
Combined abrupt VM and provider-storage loss can still lose changes after the
last complete cut; this design does not claim zero loss.

## User-visible state and rollout

During recovery the existing restoring, waiting and attention states remain.
After qualified candidate readiness, Workspace Details shows **Restored from
checkpoint** and the restored checkpoint time, alongside the exclusions above.
The historical `recovery.restored` projection binds the succeeded transition's
actual checkpoint and candidate generation. It does not follow a newer checkpoint
head, and it does not leave active `recovery.state` set or disable running usage.
Older servers can omit this optional field.

Apply migrations 0145–0146 and deploy compatible readers/workers before enabling
this path. Migration 0146 preserves the original setup evidence requirements,
adds narrow missing-snapshot evidence, and fences a predecessor recovery worker
that would copy the expired Computer. Complete the named Computer migration and
qualify an owned stopped-sandbox missing-capture response, named allocation,
checkpoint import, readiness and cancellation in the rollout channel. No live
qualification or deployment is implied by the local test suite.

Local Personal and organization-local workspaces retain their Host lifecycle.
Cloud details are keyed by exact owner, placement, workspace and generation;
switching to a local workspace or another owner cannot carry the restore notice
or resource usage across identities.
