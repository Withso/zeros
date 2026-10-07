# Release worker retirement and cleanup

The opt-in **v3 image-kit worker-promotion lane is retired**. When
`ZEROS_WORKER_PROMOTION=enabled`, release workflows and producer, canary,
readiness and publication entrypoints refuse before allocation, build or
credential preparation with the fixed error:

> v3 release worker images are retired; v4 runtime bundles are the supported artifact

Authenticated release-canary preflight/admission returns HTTP 409 with code
`release_worker_images_retired`; invalid bearers still receive HTTP 401. The old
native runner is refused before commands or uploads and never invokes the
removed `--qualify-agent` entry. There is no frozen engine dependency copy.

Current workspace admission remains saved-v2 Computer source + qualified v4
runtime/base + actor protocol 2. The supported bundle consumers are `release-alpha.yml`
and `alpha-publication.yml`; see [runtime bundles](runtime-bundles.md) and
[qualification status](qualification-status.md). Profiles 1–3 and historical
native-v3 approvals cannot admit current cloud workspaces. Personal Local and
organization Local workspaces do not use the release worker lane.

## Order and handoff

With `ZEROS_WORKER_PROMOTION` absent or different from `enabled`, releases keep
the existing hosted services gate: exact-source CI, compatible migrations,
backup, Railway deployment/readiness, Pages, WorkOS, hosted receipt and desktop
publication. A cloud-enabled signed desktop still publishes after those gates
pass. The current API worker tuple remains pinned to the hosted receipt;
`workerQualified=false` from rejected historical v3 evidence does not introduce
a release qualification requirement on this disabled lane. Existing source,
migration, Pages, cloud-capability and receipt checks still apply.

The enabled retired lane cannot issue a new worker receipt, approve v3 evidence,
select a tuple, redeploy an API for that tuple or publish. This removes the old
v3 approval → v4-only identity readback mismatch without relaxing workspace or
runtime-bundle qualification.

Historical receipt versions 1–3, their exact source/run binding, original cleanup
certificates and audit records remain compatibility contracts. Their readers
cannot issue a new receipt or restart native qualification. The shared Boat
image-kit CLI/templates also have a separate explicit Dev-tooling consumer and
are retained; they are not the supported v4 workspace artifact. The separate
flat OCI publication path still needs its own consumer/base-contract review.

## Infrastructure authority

Cleanup uses the original channel, account, owner, saved generation and provider
operation. Keep the independent Production approval, exact-source CI, encrypted
shared admission ledger, fencing and provider readback. Retirement neither
borrows another channel's authority nor grants new provider permissions. No
credentials, native material or raw provider output belong in command arguments,
logs, public receipts or documentation.

## Rotation-safe owner consent

Recorded owner designations and native audit phases remain readable. Existing
canary retirement can settle after owner credential rotation or revocation; it
uses its bound original operation and never decrypts account material or starts
a replacement native turn. New release-native admission is always refused.

## Protected configuration

For explicit observation of existing release storage, use the protected
`cloud-worker-promotion.yml` dispatch with `reconcile_storage=true` and
`execute=false`, or its equivalent guarded command:

```sh
pnpm exec tsx scripts/release/worker-cli.ts --reconcile-storage
```

This cleanup works while `ZEROS_WORKER_PROMOTION` is disabled. It still requires
protected CI, the same channel/account configuration and bearer, current source
and schema, and the original authenticated registry/admission state. It visits
bounded builder-retention and failed-builder-hold observations, then native
retirement. It does not allocate, capture, upload access, qualify, update the
tuple or emit a receipt. `--plan` writes a credential-free retirement plan;
`--execute` cannot promote a worker. Existing bound builder/native stop/delete
helpers, cleanup certificates and original-operation recovery stay available.

## Profiles, cost and qualification truth

Historical SMOKE/FULL and native evidence schema versions retain their stored
meaning. A historical proof is not current v4 workspace or publication
qualification. No paid native provider turn is part of the retired lane.

## Provider snapshot quota and recovery

Alpha, Beta, Production, Dev and organization-custom images share Boat's
account quota. Boat enforces the current subscription's allowance on capture;
upgrading the plan requires no Zeros snapshot-limit change. Zeros has no
per-channel, custom or spare allocation. The protected base must still exist
in actual provider inventory.

The existing encrypted account ledger, ETag CAS and one-builder cap arbitrate
release, Dev and custom builds. Complete provider inventory plus unresolved
reservation holds count once. No timestamp or absent inventory row frees an
uncertain allocation. A missing base is refused **before paid allocation**.
Candidate channel ownership remains required, and compute/generation caps
are independent of snapshot quota. Legacy `maxNamedSnapshots` and
`snapshotHeadroom` profile fields are ignored; new ledger policies omit them
while old ledgers remain readable. Capacity summaries report known occupancy,
not a claimed provider allowance. Genuine provider rate-limit and budget
errors retain their safe classification and uncertain allocation records.
Custom inventory must
fully paginate, rejecting missing/looping cursors or changed duplicate names.

When Boat refuses a capture for quota, the owner can upgrade the plan or retire
an **unreferenced** old rollback or failed candidate; release admission never
deletes current/rollback snapshots.
During explicit cleanup, read-only reconciliation can free an already acknowledged,
ready candidate's named-slot hold only after a certified physically deleted
builder, complete inventory and exact named-snapshot GET 404. It persists a
tombstone before releasing admission. Snapshot-name absence is not proof of
backing-storage erasure. Published snapshots remain intentionally retained.

A separate reviewed release-only path may settle the named slot while certified
builder/native storage remains pending. It consumes a strict version 2 named
DELETE acknowledgement from a separately reviewed literal action: saved original
intent, then saved/fenced dispatch, then HTTP 200 with the exact
`snapshot.named.deleted` name and deleted status. A lost response, HTTP404,
version 1 intent or mere deletion request cannot authorize this path. The
maintained worker exposes no named DELETE entrypoint.

The encrypted journal retains the complete original builder provenance,
candidate, creation/save bindings and admission reservation; every allocated
native's canonical admission, creation, cleanup and committed primary retirement
audit; and the actual reviewed non-reference and finite writer-exclusion
projections. All configuration, deployment, release/Dev/custom registry,
archive, application, primary-audit and reference-writer authorities must be
covered. Review follows the retained plan observations and dispatch remains
within their original 60-second freshness bound and a maximum five-minute exclusion
window. Later captures revalidate the reviewed facts without extending those
timestamps. Expiry requires another plan and actual review. Namespace settlement
may use a separate later reviewed capture; static source review alone is
insufficient. These private projections remain bounded inside the existing
encrypted registry document limit and do not enter public receipts.

GET-only reconciliation freshly reads every original operation, then its exact
sandbox GET 404, plus exact named GET 404 and complete inventory preserving the protected
base and every other name. It saves a separate namespace witness and tombstone,
then uses one guarded admission CAS to remove only the exact original named
reservation. `snapshotDeleted` is set with committed readback, so an interrupted
tombstone cannot trigger the ordinary broad admission-release helper. The saved
before/after transition permits recovery of a lost CAS response from the exact
authenticated ledger; absence alone does not. A conflict or failed save retains
the incomplete history, without repeating DELETE or creating a reservation.
Caps, Dev/customer policy, old helpers and the physical-only fallback stay
unchanged. Logical namespace settlement preserves all original operations and
pending/unmeasured storage certificates and never marks backing bytes erased.

Historical v1 receipts remain readable: `resourcesDeleted:true` retains its
original physical-deletion meaning for temporary builder/canary allocations,
not the selected named image. Historical executions issued v2 when credential-bearing
canaries are physically deleted, or v3 for the release-only storage deferral
described below. V2 still requires
`cleanup.credentialCanaryResourcesDeleted:true`. V3 instead requires that field
to be false and a bounded `pendingNativeStorage` count/proof digest with
`status:pending` and `physicalBytes:unmeasured`. Both versions separately validate
`cleanup.imageBuilder`; neither changes v1's physical-deletion meaning.

Interrupted creation uses the original persisted idempotency key/body within
the provider replay window, subject to the retained budget. Native start is
observed, never credential-redispatched. Lost owner-role creation with no
unique provider match remains uncertain; empty inventory is not permission to
create another role. Approval reconciles the exact primary audit/rows before
retry. Lost tuple writes reconcile readback without a second write. Lost VM
deletion responses retain admission holds and prevent approval/receipts until
their exact operation is reconciled. Credential-bearing canaries require
matching physical-deletion proof or the explicit release-only native storage
certificate below; unmarked history remains physically gated.

Historical release-native VMs, and the separate Dev allocation policy, set
`snapshots:false` when created from the qualified named image. Marked new intents
require authenticated provider readback of `sandbox.snapshots === false` at
allocation/readiness and again at fresh server dispatch, before native material
is opened and immediately before upload. This per-VM policy prevents new
background capture of owner credentials; it does not change shared-account
retention settings, image builders that must publish snapshots, or customer VMs.
Native resume and fork checks exercise agent session history inside the same live
VM, not provider VM resume or snapshot operations. A stopped or failed disposable
VM has no provider backup and cannot resume. Historical recovery replays its exact
persisted creation key/body, including an omitted or enabled snapshot flag; it
never retrofits the new policy onto an existing intent. Requested snapshots-off
is only intent; observed snapshots-off is policy proof, not physical-deletion
completion or assurance about inherited/source storage. Historical release allocations set
`strictCleanup:true` and explicitly enabled the certified storage boundary
below. Dev's existing deferred-storage cleanup behavior remains unchanged.

### Strict native retirement and historical recovery

Native outcomes may retain an optional, allowlisted diagnostic projection in the
private encrypted release journal before retirement: fixed producer phase and
failure identifiers, bounded exit/activity integers and a truncated message
digest, never message text or native output. Missing fields remain unobserved,
including in historical outcomes. This projection survives completed-job
reentry but does not change qualification, rate-limit or cleanup policy and is
not copied into approved evidence or public worker receipts.

Optional versioned event summaries retain only counts capped at 2048 and an
overflow flag. The initial MCP prompt snapshots the assertion's canonical tool
accumulator even when the prompt rejects, before assertions or cleanup: unique
rows, exact canary matches, terminal/pending/unknown status, native-ID presence
and successful matches. Later turns cannot replace that snapshot. The question
summary counts the canonical source, blocking state and maintained MCP decline
marker, without inferring other RPC subtypes. Neither summary retains tool or
question identities, content, arguments or output. Incomplete or incoherent
summaries are omitted independently; older reports do not acquire measured
zeros. The question failure latch and every qualification predicate stay intact.

An allowlisted private-input upload HTTP 403 records a bounded
`prelaunchFailure`, separate from qualification outcome, and stops promptly.
Resume cannot restart absent-runner polling or reupload account material.
Generic transport failures and lost acknowledgments remain uncertain; an absent
result without a confirmed runner is not reported as a running native test.
Neither failure classification fabricates a result, clears the immutable
dispatch fence, or permits a credential retry.

Strict cleanup retains the original DELETE operation and persists a versioned,
source/image/build/creation/account-bound physical cleanup proof before marking
the builder deleted or releasing its compute reservation. It requires the exact
authenticated operation to be completed with coherent provider timestamps and
the exact sandbox to return 404. An elapsed `expectedBy`, a cancelled run,
snapshots-off or sandbox 404 alone never releases that hold. Pending storage
without the release-only certificate and server acknowledgment below remains
unconfirmed.
Lost DELETE responses and malformed or missing ownership/provenance remain
unconfirmed; recovery never dispatches another DELETE or native operation.

Under the current owning lease, the protected release bearer may call
`POST /internal/v1/release-canaries/retirements` to settle the exact historical
operation. The server matches its immutable original audit/request hash,
channel/repository/run/attempt, owner/credential revision/designation/model,
source/image/build, authenticated encrypted journal, original intent, builder
provenance and shared-account binding. It freshly observes the retained terminal
operation and sandbox 404 before appending a truthful `cloud.release_canary.retired`
audit event. Earlier events and their original source remain unchanged. Cleanup
may settle an older source under a newer API without opening account material,
renewing credentials or granting new execution consent. A historical named image
need not still exist merely to settle a deleted native VM.

Audit settlement is exact and retryable even if the compute-release CAS already
succeeded or an audit response was lost. The local terminal marker and retired
flag are saved together after acknowledgment. Explicit guarded cleanup observes
at most 16 historical canaries within a 15-second budget;
they never allocate, rebuild, reupload, prune images or release holds by age.
Default-disabled release publication skips the retired worker lane. Existing
journals and reservations remain; `--reconcile-storage` observes historical
builder/native cleanup without a new reservation or preflight. It can observe an
acknowledged failed image build occupying the original owner's compute slot,
as described below.

An authenticated unstarted allocation saved before its resource row exists is
nonexecuted history, including a superseded run or truthful empty cleanup after
admission denial. Scanning it never releases admission or fabricates cleanup or
audit proof. A retired empty job never allocates again. Missing rows for starting/running
jobs or dispatch evidence, and uncertain allocations without retained operations,
remain fenced. An owned pre-dispatch
VM with a retained DELETE is observed strictly after completion and sandbox 404
to release its own compute hold without another DELETE or an invented audit.
Existing same-source active jobs remain observation-only. Terminal settlement
settles the original cleanup/admission record; it cannot authorize new native
qualification, worker approval or allocation.

### Release-only native storage deferral

A disposable credential-bearing release canary may become logically retired
while provider storage deletion continues. It must retain its exact acknowledged
irreversible sandbox DELETE, original creation/source/image/build/account and
parent builder provenance, plus a marked `snapshots:false` intent and the bound
actual snapshots-off observation before dispatch. Fresh authenticated reads must
observe that same operation, then sandbox 404. Only documented blocked stages
`waiting_for_uploads`, `kept_for_newer_snapshots` and `waiting_for_restore` qualify;
upload retention requires a coherent provider estimate bounded by the documented
six-hour upload-link fence. Estimates are never completion proof. Unknown,
missing, foreign or lost operation evidence and available sandboxes stay fenced.
This boundary does not apply to customer VMs, Dev policy or unmarked histories.

The source/image/creation/account-bound `storageRetirement` certificate is saved
under the owning lease before the server appends
`cloud.release_canary.storage_retired`. The matching version 2 local audit marker
and retired flag are saved together before compute admission is released. No
physical proof or `builder.deleted:true` is invented; the original operation and
certificate remain observable after admission compaction. The old operation is
terminal before credential access in the historical contract. Historical
publication required three native successes, exact artifacts, audited approval,
owner-role deletion and selected tuple/readiness. Retirement refuses every new
operation, and old partial results never qualify a new image or source.

V3 receipts bind the pending certificate count/digest to the exact qualified
jobs, with `credentialCanaryResourcesDeleted:false`; they do not claim retained
native storage is sanitized or erased. Only unavailable compute is released,
not named-image slots or retained storage accounting. Native storage, inherited
source storage and intentionally retained published images are distinct.

Bounded historical recovery visits deferred records before retired shortcuts.
The certificate remains pending through authenticated processing/removing or
retrying observations. Actual matching operation completion plus a subsequent
sandbox 404 persists physical proof and appends `cloud.release_canary.retired`;
earlier audits and issued v3 receipts remain truthful historical observations.
No named-image existence is required merely to settle physically deleted native
storage. Recovery never reallocates, executes native work or reissues DELETE.

For later observation without a new qualification, the maintained protected
`cloud-worker-promotion.yml` entrypoint accepts default-off
`reconcile_storage:true` with `execute:false`, invoking
`worker-cli.ts --reconcile-storage`. It acquires the existing registry lease with
`create:false` and retains current channel/ref/source, CI, API/schema and
Production approval gates. It performs bounded retained cleanup observation,
not allocation, credential execution, tuple selection or a success receipt.
There is no production worker preflight or automatic recovery scheduler for the
retired lane. Existing pruning policy and physical-erasure requirements remain.

### Release-owned builder retirement receipts

An unsuccessful build that never requested capture has no publishable image.
Its compute slot can be released after validating the original owning
lease/account/run/source, acknowledged credential-free creation, retained
source archive identity, acknowledged deletion operation, sandbox GET 404 and
named-image GET 404. The separate `failed-build-unavailable` proof is saved
before its compute-terminal marker and ordinary admission release. A blocked
storage operation remains pending/unmeasured with `builder.deleted:false`;
the unused name reservation is released because capture was never dispatched.
The proof cannot satisfy the image-cleanup or publication schemas. Candidate,
capture or uncertain-create records remain ineligible. Diagnostics and original
storage history are retained, and recovery never replays an acknowledged DELETE.
The encrypted owning journal keeps only the latest attestation command receipt;
large responses retain bounded excerpts and their complete digest. Public
errors identify the failed stage without printing the private command output.

An image builder may contain committed application source, previous base/source
content, build/cache/log data and synthetic Setup fixtures. Sanitation does not
prove arbitrary historical filesystem erasure or that the builder contains no
data. The existing protected source/base trust remains necessary. The eligible
path never injects live native credentials, infrastructure bearers or owner/user
fixtures: Boat authority stays in host HTTP headers, and the original protected
base creation intent uses `noEnv:true` and an empty environment. Image builders
must still capture/save snapshots; their snapshot policy and global/customer
retention settings do not change.

Deferred eligibility is restricted to `purpose:release-worker`. Before deletion,
a bounded, versioned provenance certificate binds the authenticated repository,
channel/run/source/input digest, lease owner/generation and shared-account
admission hold; original creation key/body/account/base/builder; exported
commit/tree/archive hash; generation contract/attempt/script hash; qualified
secure-Setup/source/build/storage attestation; and ready save ledger/candidate.
Sanitation must be source/build-bound and fresh within 60 seconds **at save**,
never a newly fabricated observation after retirement. Original intent and proof
survive compaction/recovery; a historical intent missing this provenance cannot
gain deferred eligibility and must use strict physical deletion instead.

The adapter freshly reads the ready named image and exact source builder, the
authenticated sandbox deletion operation (same ID/kind/target), and sandbox GET
404. A name retirement or 404 alone is never proof. Only then may the v2 builder
member be `release-owned-sanitized-unavailable`, with its complete certificate,
operation and explicit `storage.status:pending`. Allowed pending stages are
`waiting_for_uploads` (a valid provider `expectedBy`, bounded by the documented
six-hour upload-link fence), `kept_for_newer_snapshots`, and `waiting_for_restore`.
The last two may retain dependencies indefinitely; no deadline is invented.
`expectedBy` passing is not erasure evidence.

Pending storage is scoped to `sandbox-unshared-snapshots-and-machine-data` with
`physicalBytes:unmeasured`; qualified VM `storageMiB` is not a measurement of
ordinary historical or deduplicated storage. Published/shared named-image data
remains independently retained. The complete cleanup/provenance/storage record
is saved before the compute-terminal marker or admission release. Only compute
is released: `builder.deleted` stays false and named-image/storage holds survive.
Historical native allocation, approval, tuple selection and v2/v3 receipts required this
validated builder state and the matching physical or certified logical native
retirement. An unknown stage,
available sandbox, mismatched operation, lost response, malformed recovery or
missing proof cannot qualify a historical record or settle incomplete cleanup.

Explicit cleanup observes at most 16 retained builders within a 15-second provider
read budget under the same owner/account. They keep one compact record per
builder, never rebuild, replay DELETE, prune selected/rollback images, add a
cron service or release by age. Authenticated terminal operation plus sandbox
404 changes the member to `physically-deleted` and sets `builder.deleted:true`,
even if that historical named image has since been retired. Existing operation
recovery checks physical completion before named-image readiness; a ready name
with the exact source builder is still required for pending-storage eligibility.
The name hold remains until separate exact retirement readback releases it;
recovery never deletes or prunes a name. Unknown/malformed historical proof is
retained for reviewed reconciliation of its exact
saved operation, not a new deletion or inferred success.

After the separately reviewed named settlement above, only the combined
`observeOnly:true,historical:true` builder path may replace ready-name and active
reservation prerequisites with the committed namespace witness. It authenticates
the current account ledger, rejects any replacement reservation or reappeared
alias, and freshly observes the same original operation, sandbox GET 404 and name GET 404.
The retained review can expire after commitment; it authorized that historical
settlement, not another action. Initial/current provenance and admission remain
strict. Later physical completion uses the original operation proof and retains
the earlier pending-storage and named-retirement history.

Historical kit journals, immutable candidates, original intent, cleanup proof,
reviewed named settlement and issued receipts remain readable. New release
source export, build, image attestation, native dispatch, approval and tuple
selection are refused. Retained records must be reconciled using their exact
owner/account and original provider operation; retirement does not authorize
another build, credential upload, snapshot capture, or synthetic success.

Follow-up: **re-qualify a v4 release-worker lane if needed**. This requires a real
bundle/base installation and current runtime qualification, exact publication
identity, and a separately reviewed producer/canary contract. A marker relabel,
frozen engine copy, or historical native-v3 receipt is not that qualification.
Actual cloud-enabled macOS release and live Alpha behavior remain separate
acceptance checks.
