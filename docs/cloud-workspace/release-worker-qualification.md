# Release worker qualification

Worker qualification is per channel and exact image/source. Keep
`ZEROS_WORKER_PROMOTION` disabled except for an explicitly authorized,
protected-channel rehearsal or a previously qualified channel's guarded release.
A rehearsal must pass the complete protected lane before that channel is treated
as qualified or customer cloud is enabled. Never run it on PRs/forks, from
`.env.agent`, or with Dev fixture identities. Unit tests use fakes and cannot
certify provider behavior, native account availability, quota, cleanup latency
or a Mac release.

## Order and handoff

For a channel's first worker, provision encrypted account keys and release-only
Boat admission first, then deploy the reviewed API/schema with customer cloud
disabled. Owners can connect accounts and record audited canary designations;
the release bearer can qualify native runtimes before an image tuple exists.
These bootstrap surfaces do not admit customer workspaces, execution or
customization. After qualification and tuple selection, redeploy that same API
still cloud-off so `/v1/release-identity` can verify the selected worker's actual
database approval matrix. Only then may cloud provisioning enable customer
cloud; an explicit subsequent deploy/readiness check precedes desktop rollout.
See [channel backend provisioning](../deployment-environments.md#provision-a-channels-cloud-backend).

The release order is exact-SHA Preflight + CodeQL → compatible DB migrations →
API → Pages → WorkOS verification → worker build/native canaries → atomic tuple
selection → same-SHA API redeploy/readiness → hosted receipt → desktop feed.
The worker refuses allocation without the new exact-SHA API/current schema and
the trusted `hosted-services-<channel>-<sha>` receipt. Its independent CI gate
also checks the current branch before mutation.

Worker producer contract:

| Field | Exact value |
| --- | --- |
| Job ID/display name | `worker` (nested producer name ends in `/ worker`) |
| Execution step | `Worker plan or guarded execution` (`promote`) |
| Success upload step | `Save success receipt` |
| Artifact | `worker-promotion-<channel>-<source_sha>` |
| Artifact file | `worker-receipt.json` |
| Callable outputs | `receipt_issued`, `receipt_artifact` |

A success receipt binds the repository, branch, channel, immutable event SHA,
committed input digest, parent run and recorded attempt, profile, three proven
kinds, complete tuple, native contract/evidence/approval hashes, completion time
and cleanup. It contains no account material, credential IDs, user identity,
native stdout, provider responses or prompts. Plans and standalone genuine
reuse emit `receipt_issued=false`, never a synthetic receipt. The hosted guard
normally skips an unchanged, affirmatively qualified selected input tree.
Callable execution defaults `receipt_required=true`: if the guard requests a
worker job, that job must qualify and emit the real handoff even if post-services
identity now permits reuse. Explicit standalone FULL never reuses a worker.

Worker owns the **only** six-field Railway `variableCollectionUpsert`, with
`replace:false, skipDeploys:true`. The adapter validates the exact Boat/source/
architecture/storage tuple and channel marker, reconciles a lost write by
readback without another mutation, and checks final readback. Hosted
finalization authenticates artifact/job/step/run-attempt provenance, reads the
tuple back, redeploys the exact API SHA and checks public qualification/identity
before issuing the hosted receipt. Standalone dispatch needs
`services_run_id`/`WORKER_SERVICES_RUN_ID` for a trusted prior exact-source services
run; its worker receipt remains bound to its own run and cannot be substituted
for a different parent release.

## Infrastructure authority

The channel's non-admin `BOAT_API_KEY` must authorize the actual operations, not
merely carry a channel label or preset name. Worker build/qualification requires
`account.read`, `sandbox.create`, `sandbox.read`, `sandbox.delete`, `exec`,
`file.write`, `snapshot.read` and `snapshot.write`. Private native input uses
`file.write`; it must not be replaced with command interpolation or another
credential path. Managed runtime lifecycle also requires `sandbox.update`,
`sandbox.stop` and `sandbox.resume`. The engine bridge requires `host`:
`BoatRuntimeEndpointResolver.bridge` calls `POST /sandboxes/:id/host` for the
engine endpoint even when optional previews are off.

Protected cloud-off provisioning and exact readback establish the actual
supplied channel binding; inventory labels alone do not. Successful variable
readback does not establish provider permissions. Verify the bound authority's
required actions before qualification and activation. A non-admin key cannot
expand its own scope, and rotation preserves scope. If a required action is
missing, an authorized account owner must supply a correctly scoped replacement
through the provider's browser/session or existing-admin setup path and the
channel's protected secret/configuration/deployment gates. Do not borrow another
channel's infrastructure or native credentials, mint an admin runtime key, or
bypass the Production approval boundary.

## Rotation-safe owner consent

Each channel configures the owner's own active `platform_owner` by UUID in
`RUNTIME_QUALIFICATION_ACTOR_USER_ID`, never by email. That member must own the
configured canary organization and have a live Pro allowance. Connect the
intended Claude Account, Codex ChatGPT Account and Cursor API-key credentials
once through the normal channel app. **Connection alone is not consent.**
Only a per-credential, current-revision, model-specific designation permits use;
default is off. Native credentials and the rotating Codex native cache remain
under the existing control-plane envelope/key/fingerprint/renewal journals.
CI never receives them. Real Codex renewal updates that durable store; the VM
gets only two bound access-only versions and fixed renewal proof, never a
refresh token. This avoids a static CI refresh secret becoming stale after its
first use.

In **Settings → Agents**, the configured `platform_owner` can switch on **Use
for release checks** on each intended connected cloud account. Consent defaults
off. The control shows the approved model and last audited start time; unknown
consent cannot appear enabled. Only Claude Account, Codex ChatGPT Account and
Cursor API-key connections are eligible. Other connection types are disabled,
and non-owner staff and ordinary members cannot see these controls. An enabled
control approves the pinned low-cost model for that kind. Reconnecting or
changing the credential revision visibly turns it off and requires new consent.
Turning it off revokes consent without disconnecting normal agent usage.

The Settings control uses the authenticated, audited designation API:

- `GET /v1/cloud-agent-credentials/<credential UUID>/release-canary` returns
  current designation ID/revision, enabled state, approved models and
  `lastUsedAt` (the last audited canary start, or null).
- `PUT` to that same route accepts only `operationId` (new UUID),
  `expectedDesignationId` (the GET result, initially `"0"`),
  `credentialRevision`, `enabled` and `models` (one to three explicitly approved
  model IDs). Use `enabled:true` to opt in; `enabled:false` revokes designation.
  Replaying the exact operation is idempotent; changed/stale consent is refused.
  After a lost response, Settings reads the current consent before retrying the
  same immutable operation. It does not replace a stale operation silently.
  If Settings becomes inactive, reconciliation waits until active again; Retry
  retains the original operation instead of dispatching another consent change.

The authenticated user must be the configured owner; the request cannot select
another member. Credential revocation/reconnection or a revision change also
invalidates old consent. Designation is available with the actor/organization
configured even while the paid admission switch is off; no CI bearer or native
credential export is needed to operate Settings. The designation/use audit
names the allowance owner by UUID. Native model requests use that member's
explicitly selected provider credentials, so provider token/account limits are
charged to that member's provider allowance. Release VM compute is separately
bounded in the shared infrastructure Boat wallet; this path does not create a
customer workspace or debit a customer workspace's managed-compute credit
ledger. It does not borrow any other credential, personal session or workspace.

The pipeline's release-only bearer can only preflight/admit designated canaries
on authenticated shared-account release receipts: exact channel/source/run/job,
image/model/profile, active lease, fresh clone, correct wallet, machine
attestation and no normal workspace/computer allocation. Consent is rechecked
before preparation/upload. Every use is audited. Uncertain preparation/dispatch
fences the credential even across different operation IDs; a new run cannot
blindly rotate it again. Lost dispatched responses observe the native runner.

Before any allocation, that bearer discovers connections **server-side**, for
the configured actor only. There must be exactly one active, current-revision,
model-approved designation for each required kind. Missing or ambiguous consent
fails closed with `Release canary designation missing/ambiguous for <kind>`;
unapproved SMOKE models fail with `Release canary model not approved for <kind>`.
Revoke additional designations or approve the required model in Settings, then
start a new reviewed run. There is no CI-side connection list to maintain.

Discovery binds the credential UUID, revision, designation audit ID, kind and
approved model into the private run journal, each disposable-canary job and the
hashed approval evidence. Recovery cannot substitute a changed designation.
Admission rechecks live consent before credential preparation/upload. These
bindings contain no credential material and are not included in public receipts,
logs or the uploaded handoff artifact; only verified hashes cross that boundary.

## Protected configuration

All CI credentials belong to the protected channel environment. GitHub masking
is defense in depth, not permission to print secrets. Secret values are supplied
only as step environment, never interpolated into commands or artifacts.

| Protected secret | Purpose |
| --- | --- |
| `WORKER_CANARY_ADMISSION_TOKEN` | At least 32 characters; independent release-only bearer, also held server-side |
| `WORKER_ADMISSION_CONFIG_JSON` | Existing shared R2 registry credentials/encryption key and canonical infrastructure profile |
| `BOAT_API_KEY` | Shared Boat infrastructure authority, never a native model credential |
| `RAILWAY_DEPLOY_TOKEN` | Channel target's complete tuple selection |
| `PLANETSCALE_SERVICE_TOKEN_ID`, `PLANETSCALE_SERVICE_TOKEN` | Short-lived channel owner-role creation/deletion for audited approval |

`GH_TOKEN` comes from the Actions token with contents/actions read permissions.
Discovery rejects extra fields/kinds, duplicate credential identities or kinds,
stale revision, wrong actor/channel/run and unapproved models. There is no
`WORKER_CANARY_CREDENTIALS` interface and no static
`WORKER_CANARY_CLAUDE_API_KEY`, OpenAI API key or Codex auth JSON seed.

Channel variables include the existing Railway/PlanetScale target IDs,
`BOAT_ACCOUNT_SCOPE`, `BOAT_BILLING_ORG`, `BOAT_BASE_SNAPSHOT`,
`BOAT_BUILDER_BUDGET_HOURS` (>0, ≤2), `BOAT_CANARY_BUDGET_HOURS` (>0, ≤1),
`BOAT_WORKER_BUDGET_HOURS` (covers builder, ≤6 account-wide hours), actor UUID,
`WORKER_CANARY_ORGANIZATION_ID` and exactly
`RUNTIME_QUALIFICATION_CREDENTIAL_KINDS=claude-setup-token,codex-chatgpt,cursor-api-key`.
The control plane additionally needs `ZEROS_RELEASE_CANARIES_ENABLED=true`,
the same admission bearer/actor/organization/repository configuration
(`WORKER_CANARY_REPOSITORY`), immutable `RAILWAY_GIT_COMMIT_SHA`, existing
encrypted credential/Codex renewal keys and the same shared admission profile.
No migration or qualification-table fixture seed is required.

Owner setup for each channel is therefore:

1. Configure the owner's UUID and owned canary organization server-side. Connect
   the three intended accounts in that channel's app, using its normal encrypted
   credential flow.
2. In Settings → Agents, enable **Use for release checks** for exactly one
   eligible connection per kind, review its displayed model and allowance cost,
   and leave every other connection undesignated.
3. Install the protected admission bearer and infrastructure secrets/configuration
   listed here. No account session, refresh token or manual connection document
   belongs in CI. Keep execution switches off until the isolated rehearsal is
   approved; then enable the server admission and worker lane in the required
   release order.

The shared admission secret is version 1 with `registry` fields `endpoint`
(HTTPS R2), `bucket`, `accessKeyId`, `secretAccessKey`, `encryptionKey`, and
`profile` fields `boat` (`accountScope`, `billingOrg`, `baseSnapshot`), `railway`
(`projectId`), `planetscale` (`organization`, `database`) and `cloudflare`
(`accountId`). These canonical fingerprint inputs must be identical across
Dev, all release channels and custom-build services, not replaced with each
channel's deployment targets. Initialize/reconcile the existing encrypted
`admission/v1/account.json` authority before execution. Missing/mismatched
configuration fails closed.

## Profiles, cost and qualification truth

SMOKE is the default for non-native worker input changes: start, one combined
read/edit/shell/MCP message, real Codex renewal/adoption, end/load native history,
one history-only resume message, permission-mode selection, stop and revocation.
There are **two message submissions per agent** and no extended paid turns.
Replies are marker-only and bounded to 4096 characters; Codex uses low thinking
effort. The named low-cost families are pinned to the committed catalog above;
this is not a claim that live pricing/availability was checked. The profile
does not advertise native goals, forks, review, apps or multi-agent capabilities.

Automatic FULL is selected for changes to:

- `apps/desktop/src/engine/agents/**` (adapters, containment, native contracts)
  and `apps/desktop/src/engine/cloud-runtime-attestation.ts`;
- protocol `cloud-agent*`/`cloud-mcp*` sources;
- `scripts/cloud-workspace-validation/config.ts`, its `sandbox/**` and
  `lib/native-*` inputs; `scripts/zsr-qualification/**`;
- supervisor build/Codex code-generation scripts, third-party/patch/catalog
  provenance, root `package.json` or `pnpm-lock.yaml` dependency pins.

The comparison is against the **selected worker's committed source**, not just
the last push. Explicit FULL is supported; an explicit SMOKE request cannot
downgrade changed native inputs. FULL retains the extended suite and verifies
the advertised checks before approval. Dev retains its existing FULL default;
the cheaper release profile is not silently applied to Dev.

Each allocation checks the account meter and the persisted total-run ceiling.
Per-canary ceilings and VM TTLs never extend on recovery. Explicit profile
leases are capped by the profile deadline plus cleanup headroom, per-canary
budget and remaining account budget: SMOKE native deadline 420 seconds (at most
720 seconds VM lease); FULL native deadline 2400 seconds (at most 2700 seconds
VM lease). A smaller approved budget shortens the lease; budget failure cannot
become successful qualification. Allocate adequate FULL budget deliberately
instead of raising it automatically. The workflow has a 330-minute outer bound,
but account-hour ceilings, bounded polls and disposable-VM TTLs apply first.

An unsuccessful `errorKind: rate-limited` never consumes Dev's three real
qualification attempts per connection/image. Dev retries automatically after
60-second exponential backoff capped at 15 minutes, with a clear account-rate
message and bounded retired-history compaction. Explicit retry cannot bypass
that delay. Release fails with `canary account rate-limited`, retires its VMs and
does not automatically retry, approve or select a tuple.

`workerQualified` is true only for the entire three-kind, enabled, MCP-qualified
matrix on one `zeros-cloud-worker-v3` contract. A single approved kind is not
readiness. Cloud grant metadata binds the live engine's image/profile/contract
and MCP proof; the renderer excludes unqualified-only providers and prefers a
qualified account grant over a matching unqualified API-key grant. Local
behavior and older additive metadata remain compatible. Anthropic/OpenAI
API-key modes remain unoffered until their exact image/kind is independently
proved.

## Ten-slot account and recovery

| Shared named slots | Budget |
| --- | --- |
| Alpha current + rollback | 2 |
| Beta current + rollback | 2 |
| Production current + rollback | 2 |
| Dev and organization-custom images, combined | 2 |
| Retained clean base | 1 |
| Empty deletion/publication headroom | 1 |
| Total | 10 |

The existing encrypted account ledger, ETag CAS and one-builder cap arbitrate
release, Dev and custom builds. Complete provider inventory plus unresolved
reservation holds count once. No timestamp or absent inventory row frees an
uncertain allocation. Release refuses a third channel slot, missing base,
non-release overflow or exhausted headroom **before paid allocation**. Dev and
custom builds cannot consume any of the six release/rollback slots; custom
capacity errors explicitly say `image capacity reached`. Custom inventory must
fully paginate, rejecting missing/looping cursors or changed duplicate names.

Before a third promotion, the owner must retire an **unreferenced** old rollback
or failed candidate; automatic code never deletes current/rollback snapshots.
On the next release, read-only reconciliation can free an already acknowledged,
ready candidate's named-slot hold only after a certified physically deleted
builder, complete inventory and exact named-snapshot GET 404. It persists a
tombstone before releasing admission. Snapshot-name absence is not proof of
backing-storage erasure. Published snapshots remain intentionally retained.
Historical v1 receipts remain readable: `resourcesDeleted:true` retains its
original physical-deletion meaning for temporary builder/canary allocations,
not the selected named image. New executions issue strict v2 receipts without
that unscoped field. V2 requires `cleanup.credentialCanaryResourcesDeleted:true`
and a separately validated `cleanup.imageBuilder` union, described below.

Interrupted creation uses the original persisted idempotency key/body within
the provider replay window, subject to the retained budget. Native start is
observed, never credential-redispatched. Lost owner-role creation with no
unique provider match remains uncertain; empty inventory is not permission to
create another role. Approval reconciles the exact primary audit/rows before
retry. Lost tuple writes reconcile readback without a second write. Lost VM
deletion responses retain admission holds and prevent approval/receipts until
their exact operation is reconciled. Credential-bearing canaries always require
matching terminal physical-deletion proof; builder storage has only the narrow,
explicit release-owned boundary below.

New disposable native qualification VMs, in both Dev and release lanes, set
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
completion or assurance about inherited/source storage. The release lane sets
`strictCleanup:true` and still requires
the matching terminal deletion operation before freeing compute admission or
issuing a worker receipt. Dev's deferred-storage cleanup policy
remains unchanged.

### Strict native retirement and historical recovery

An allowlisted private-input upload HTTP403 records a bounded
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
the exact sandbox to return 404. Pending storage, an elapsed `expectedBy`, a
cancelled run, snapshots-off or sandbox404 alone never releases that hold.
Lost DELETE responses and malformed or missing ownership/provenance remain
unconfirmed; recovery never dispatches another DELETE or native operation.

Under the current owning lease, the protected release bearer may call
`POST /internal/v1/release-canaries/retirements` to settle the exact historical
operation. The server matches its immutable original audit/request hash,
channel/repository/run/attempt, owner/credential revision/designation/model,
source/image/build, authenticated encrypted journal, original intent, builder
provenance and shared-account binding. It freshly observes the retained terminal
operation and sandbox404 before appending a truthful `cloud.release_canary.retired`
audit event. Earlier events and their original source remain unchanged. Cleanup
may settle an older source under a newer API without opening account material,
renewing credentials or granting new execution consent. A historical named image
need not still exist merely to settle a deleted native VM.

Audit settlement is exact and retryable even if the compute-release CAS already
succeeded or an audit response was lost. The local terminal marker and retired
flag are saved together after acknowledgment. Later guarded executions observe
at most 16 historical canaries within a 15-second budget before fresh preflight;
they never allocate, rebuild, reupload, prune images or release holds by age.
An authenticated unstarted allocation saved before its resource row exists is
nonexecuted history, including a superseded run or truthful empty cleanup after
admission denial. Scanning it never releases admission or fabricates cleanup or
audit proof. Only an unretired current-run job may resume its original allocation
ID; a retired empty job never allocates again. Missing rows for starting/running
jobs or dispatch evidence, and uncertain allocations without retained operations,
remain fenced. An owned pre-dispatch
VM with a retained DELETE is observed strictly after completion and sandbox404
to release its own compute hold without another DELETE or an invented audit.
Existing same-source active jobs remain observation-only. Terminal settlement
permits only a separately fresh operation
with current source, owner allowance and consent; it is not successful native
qualification, a worker approval or permission to enable customer cloud.

### Release-owned builder retirement receipts

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
Native allocation, approval, tuple selection and v2 success all require this
validated builder state **and** strict physical canary cleanup. Unknown stage,
available sandbox, mismatched operation, lost response, malformed recovery or
missing proof withholds approval and success.

Later executions observe at most 16 retained builders within a 15-second provider
read budget under the same owner/account. They keep one compact record per
builder, never rebuild, replay DELETE, prune selected/rollback images, add a
cron service or release by age. Authenticated terminal operation plus sandbox
404 changes the member to `physically-deleted` and sets `builder.deleted:true`,
even if that historical named image has since been retired. Existing operation
recovery checks physical completion before named-image readiness; a ready name
with the exact source builder is still required for pending-storage eligibility.
The name hold remains until separate exact retirement readback releases it;
recovery never deletes or prunes a name. Unknown/malformed historical proof is
retained and blocks new release work for reviewed reconciliation of its exact
saved operation, not a new deletion or inferred success.

The kit journal intentionally excludes the binary source archive. A recovered
source manifest without its archive **before install** fails before allocation/
upload; reconcile or begin a separately reviewed fresh run rather than silently
regenerating partially uploaded bytes. Already-started installs resume their
status/attestation without another install. Custom cleanup may finish a proven
unstarted/no-resource image with missing shared configuration, but never
pretends to free an unknown shared reservation.

Ready candidates with validated builder cleanup discard bulky build-only kit
files only after sufficient authenticated provenance survives; immutable
candidate, original intent and cleanup proof still permit resume. Certificates
are bounded at 4 KiB, run history at 100, and the encrypted registry retains its
existing 1 MiB document cap. Saves/fencing precede provider allocation, so
reaching a bound fails before another allocation. Reconciliation is reviewed,
never automatic removal of uncertain intents or retained storage history.

Rehearse exact-source ordering, all three modes/real renewal, rate limits,
consent revocation, quota/slots, lost responses, physical cleanup, old-generation
compatibility and final API tuple/qualification readback before enabling Alpha.
Beta and reviewed Production require their independent protected configuration
and evidence. Normal cloud Files/Changes/terminal/Git/reconnect/stop/wake/archive
and an actual cloud-enabled macOS release remain separate live acceptance.
