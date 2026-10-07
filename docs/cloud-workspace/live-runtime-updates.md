# Cloud runtime updates, staging and handoff

Status: runtime selection/pins, installer/controller adapters, retained-allocation
transfer, staging, quiet observation and resident handoff boundaries are
implemented. **Automatic live activation and present-client process survival are
not release-qualified.** The concrete Alpha acceptance adapter remains deferred.
Repository code and synthetic/real-Linux tests do not establish a live ≤2-second
gap. [Runtime bundles](runtime-bundles.md) owns artifact/registry/installation;
this guide owns update states and their one transition journal.

## Update modes and authority

| Mode | Current boundary |
| --- | --- |
| Same-pin resume | Validated preparation reuse may skip clone/hooks/preflight; full final attestation and fresh launch/registration remain. No runtime selection change. See [wake performance](wake-performance.md). |
| Stopped next-wake / explicit upgrade | Existing generation replacement selects a qualified newer runtime for the saved base/source, restores a fresh checkpoint and rolls back on candidate failure. It does not preserve processes. See [runtime lifecycle acceptance](runtime-lifecycle-acceptance.md). |
| Stage while running | Download/verify beside the active tree, preserving source engine/pointers/processes. Stage receipt grants no activation/enrollment authority. |
| Quiet retained-allocation update | New immutable generation on the same allocation through the existing transfer lock/journal. Requires exact pair/controller qualification and current safe-point authority. No production activation worker is enabled. |
| Resident handoff | Separately attested workload host can retain PTYs/user jobs while the engine is replaced. Uses the same transfer/enrollment/recovery journal plus consumption records. Live continuity remains gated. |

A new desktop/control-plane deployment does not modify an existing pinned VM.
Selection rechecks current source/base/runtime/credential qualifications and
revocation, not merely release order. Keep historical generations and immutable
pins; never edit protected base bytes while retaining its compatibility ID.
Legacy executable profiles 1–3/actor protocol 1 are intentionally retired. N/N−1 release
skew covers supported saved-v2/v4/actor2 cohorts; it cannot resurrect those paths
or revoked runtime authority. See [runtime skew](runtime-skew-gate.md).

## Preservation and readiness

Files, working tree/index/refs, Design, engine SQLite and native histories remain
on disk during retained-allocation updates. Their survival is different from
process/connection survival: ordinary retirement kills engine/setup descendants;
PTYs, jobs, SSH/preview and provider SDK state need separately qualified lifetime
owners. Checkpoints are disaster-recovery data, not process snapshots. Never
call final quiescing checkpoint to forcibly manufacture a quiet source.

Before switching, finish non-idempotent Git/Design mutations and durable writes,
close the old SQLite writer, and synchronously fence new mutations/process starts.
Exactly one engine may write/admit work. Recheck activity/authority after every
await. Unknown process/state evidence is busy. Candidate preflight cannot take
the source lifetime lock, overwrite its descriptor/proof, open writable SQLite
or obtain provider authority; current final attestation remains in the fenced gap.

A target and rollback each need a fresh engine UUID, supervisor session,
namespace/cgroup/boot/receipt witness, single-use proof and registration grants,
current qualification, initial durable sync and challenged authenticated health.
A stage receipt or reused prior readiness cannot substitute. Forward and rollback
SQLite/provider-history readability require exact source/target compatibility
qualification; no destructive migration, setup rerun or Git rewrite is implicit.

Retained-allocation registration atomically transfers current binding/logical
allocation owner/generation authority while preserving original funding,
reservation, meter, billing epoch and provider labels. Old in-flight stop/delete/
compute claims block activation; source cleanup may never delete the transferred
VM. Disk selection and PostgreSQL cannot commit atomically, so admissions close
across the journaled gap. Unknown authority retains data and closes admission;
a partition has no finite availability guarantee.

Undispatched queue entries keep command/user-message/operation identity, order
and saved pause state and revalidate actors/models/delegations on the selected
healthy engine. Dispatched/uncertain effects are never replayed. Delivery/claim
idempotency is not exactly-once arbitrary external side effects.

## Staging while work continues

The Alpha control plane can stage a newer qualified runtime on a running
organization workspace without retiring its engine. `CLOUD_RUNTIME_STAGING_ENABLED`
defaults to `false`. It requires the hosted Boat backend and runtime artifact
store. It never enables activation, changes runtime pointers, obtains enrollment
grants or restarts a workspace. Keep it disabled until the staged installer and
transition path are qualified together.

Qualification success, confirmed Alpha release publication and runtime revocation
send an empty PostgreSQL notification in their existing transaction. Notifications
carry no authority, identity or artifact capability. The existing dedicated
worker listener wakes staging after commit and reconnect. A 15-second poll and
startup scan recover lost hints, including qualifications written out of band.

Discovery includes `ready` and `busy` workspaces belonging to staff, with a live
engine and hosted Boat binding. It uses the existing selector for the exact base,
protocol, qualification mode and delegated credential kinds. It does not inspect
client presence, PTYs, idle time or agent turns. Local-owner and organization-owned
local workspaces do not use this control-plane worker. Owner/placement switching
does not change its exact organization/workspace/generation/engine scope.

The worker calls the transfer service’s `offer`, `claim`, `renew`, `reconcile`, `staged`, `release`
and `cancelStaging` APIs. The transfer service owns the common lock and transition journal. No new
migration or supervisor queue is introduced. The operation UUID is derived from
the source identity, discovered target and previous expired cancellation, so duplicate pushes and worker restarts
join the same offer. The service reselects and fences authoritative eligibility when offering.

Each replica runs at most two downloads (the constructor caps this at four),
reads pages of 16, and keeps at most 512 retry records. A transition gets three
attempts per worker process with backoff. The transfer service’s durable 15-minute deadline bounds
retries across crashes; exhaustion cancels that offer without changing the source.
After the cancelled offer's original deadline, polling may create a fresh offer
with a new durable idempotency key. A long-running turn therefore cannot strand
an update permanently. A newly selected target need not wait for an older target's
retry window. Duplicate scans inside each window join the same offer.
The verified installer enforces archive/expanded-size and disk checks. Staging
does not add runtime cache garbage collection.

The worker signs a short-lived artifact capability in memory, then rechecks the
source identity, live lease, qualification and latest eligible target. It invokes
the existing pinned installer over private SSH stdin with `operation: stage`;
every activation callback is denied. The installer verifies bytes beside the
active tree and preserves source processes and selection. A final eligibility
read precedes `staged`. Claim renewal and eligibility monitoring run every 25
seconds; lease loss, shutdown or a changed source discard the result. A cancelled
download can finish verified cache bytes on the VM, but has no activation authority.
Diagnostics use closed labels and contain no provider output or signed URLs.

Superseded and revoked offers are cancelled under the transfer service’s fenced API. A valid staged
offer is released immediately for a future qualified activation caller. That caller must still
recheck current eligibility, latest-target supersession and its quiet/safe-point
policy at activation, then obtain fresh proofs and enrollment. A stage receipt is
neither an attestation nor permission to activate.

Local tests cover busy-source staging, real transition receipts, transactional
notifications, duplicate/lost hints, source and tenant mismatches, revocation,
supersession, worker lease loss, retries and shutdown. No live provider operation
or latency claim is made by these tests. The Alpha acceptance runner separately
verifies actual pointer/process preservation and the subsequent handoff.

## Retained-allocation transfer

`DatabaseCloudRuntimeTransitionService` in
`apps/control-plane/src/cloud-workspaces/runtime-transfer.ts` implements the
retained-allocation executor. It has no automatic scheduler or activation
policy installed. The resident workload host owns process lifetime and the attach fence; the
transfer service owns the database transition,
registration, health verification and crash deadlines. The activation caller must supply a policy appropriate to the qualified VM controller. Presence,
PTY survival and safe points are policy inputs, not hard-coded transfer rules.
There is no measured reconnect-gap claim for this executor.

The executor reuses the existing lifecycle service’s candidate selection and organization/workspace lock,
and the existing single-active-generation-transition journal. Its
`execution_mode='retain_allocation'` never owns provider lifecycle intents.
Staging creates an immutable candidate generation while the source runs.
Activation requires current runtime/base/credential qualification plus a
separate operator-published source/target/controller compatibility record.
Those records start disabled; runtime qualification alone cannot authorize a
reversible database/history downgrade. Activation also rejects pending
provider operations, compute claims and insufficient funded rollback runway.
The trusted policy's decision is followed by another wall-clock authority
check before the source is fenced.

The controller integration contract is:

| Call | Required evidence and result |
| --- | --- |
| `offer` | Current source engine and generation, operation UUID, engine/bootstrap mode. Returns the single transition or joins the existing lifecycle service’s existing one. |
| `claim` / `renew` | Worker lease lasts 90 seconds. Reclaim changes the worker fence; the VM execution fence remains fixed. Renewal cannot extend phase deadlines. |
| `release(claim): Promise<boolean>` | Relinquish an exact live worker claim immediately, retaining phase and execution fence. The next claimant receives a new worker fence. A stale, expired, already released or terminal claim returns false. |
| `cancelStaging(claim): Promise<boolean>` | Cancel only offered/staged work before any activation, under the common transition lock. Requires the current live claim; an exact retry of its completed cancellation returns true even after lease expiry. Other fences and post-activation cancellations return false. Source authority, allocation and pin remain unchanged. |
| `staged` | Called only after the authenticated, pinned installer conversation returns its exact staged receipt. Staging expires after 15 minutes. |
| `activate` | Verified controller descriptor and injected `CloudRuntimeActivationPolicy`. True is the source-admission fence; target registration is bounded to 240 seconds. |
| `enroll` | Fresh verified active/controller identities and the complete normalized v4 attester report from the pinned root channel. Rejects a reused supervisor session, wrong boot/base/pin or incomplete containment evidence. Returns a fresh engine UUID and short-lived, one-use capabilities in memory only. |
| transition registration | `POST /internal/v1/cloud-workspaces/runtime/register`, strict existing registration body, bearer capability. `setupRunId` carries the enrollment UUID and `executionFence` its sequence **only on this endpoint**. It cannot redeem setup, repository or settings grants. Registration moves the binding, logical allocation owner, current generation and ready engine atomically. |
| `verifyHealth` | A fresh challenge sent over the authenticated root controller channel; the reply must bind the execution fence, active descriptor, engine UUID, protocol, ready health and durable-record connection. Ordinary engine HTTP input is never a health proof. A successful probe records evidence but keeps admissions closed. |
| `finish` | Exact final `RuntimeUpdateResult` receipt from that controller's durable journal, matching the registered engine and fresh health evidence. Only this step publishes ready status and ordinary admissions. |
| `beginRollback` / `reconcile` | Revoke target authority before VM rollback. Allocate a fresh source engine/enrollment rather than reviving an old UUID. A lost registration reply can be resolved by fresh health plus the final journal receipt. Activation and rollback each have a fixed 240-second bound. Unknown or expired rollback stays `recovery_required`, with the allocation preserved and admissions closed. |

The pinned controller must expose fresh challenge-bound health and authenticated journal inspection
for recovery after a worker dies. Wire these calls through the existing pinned
installer conversation; do not expose `enroll`, `verifyHealth` or `finish` as
ordinary client/engine routes. A reclaimed worker never reuses a plaintext
registration or readiness capability from storage. The generation and engine
keys are checked again under the common lifecycle lock at every publication.
Only durable-record synchronization and heartbeat are available to a newly
registered engine before the final receipt. Repository credential refresh,
commands, tools, and client admission remain closed.

`cloud_workspace_allocation_owners` records the VM's original provider identity
and its current generation. `cloud_workspace_allocation_transfers` audits each
ownership change. The existing allocation lease, reservations, funding window,
meters and billing epoch retain their original identity, including on subsequent
updates of the same VM. Loss settlement uses the original provider journal plus
the audited current binding; legacy allocations keep their existing checks. Provider receipts and
labels also retain their original generation. The provider adapter projects
only that exact allocation onto its current owner and rejects stale destructive
calls. A provider operation is journaled before I/O; an unknown outcome blocks
activation even after the caller's lease expires. Clearing an unknown provider
outcome requires independent provider completion evidence; a timeout or a
single observation is insufficient. Automatic repair of such provider outcomes
is deliberately not inferred by runtime crash reconciliation.

`readCloudRuntimeResumeProofEpoch` now covers both ordinary setup and retained
engine enrollment. A database-assigned order detects later incomplete launches,
including copied legacy INSERT shapes. Cancellation after activation cannot
resurrect an earlier cached epoch. A successful rollback has its own engine UUID.

Migration 0136 is an expand migration with nine explicit, statement-scoped
exceptions: three validated CHECK widenings, three nullable enrollment columns,
two conditional legacy triggers, and the compute-authority function. The
exception linter accepts only the annotated exact statements in this file; the
function's entire body is pinned for review. Both legacy trigger functions are
unchanged. New enrollment rows have a scoped FK, an immutable enrollment ID and
a separate INSERT/UPDATE guard for pin, witness, sequence and capability state.
The new CHECKs are added NOT VALID and validated before the old restrictions
are removed, within the existing five-second lock timeout. Application RLS
permits qualification row locking but forbids qualification publication. New
workspace-owned records follow the existing workspace-erasure cascade. The
migration is compatible with old-code writes, but activation of the new row
shapes requires all control-plane replicas to run the transfer-aware code.
Keep operator transfer qualifications disabled throughout a rolling deployment.

Local and organization-owned local workspaces have no control-plane transition
rows and keep their existing behavior. Cloud transitions remain scoped by both
organization and workspace. This slice changes no renderer selection or local
engine path. Automatic activation and the concrete Alpha acceptance adapter remain gated;
current staging, resident wiring and queue handoff do not qualify a live swap.


## Quiet observation and activation policy

`apps/desktop/src/engine/cloud-runtime-quiet-state.ts` exports
`CloudRuntimeQuietState`, `CloudRuntimeQuietStateOptions`,
`CloudRuntimeQuietScope` and `CloudRuntimeQuietSnapshot`.
`snapshot(challenge: string): Promise<CloudRuntimeQuietSnapshot | null>` is
read-only: it does not drain work, reserve a safe point, change admission or
stop a process. The resident handoff can consume the same typed snapshot.

Each version-1 snapshot binds a fresh UUID challenge to organization, workspace,
generation and engine instance. It contains the monotonic activity revision,
quiet duration, durable-record synchronization state, idle-stop workload guard,
live PTY guard, process-scan result and presence state. The reader samples guards
before and after process inspection; changed activity marks the snapshot
unstable, a changed identity rejects it, and unavailable process evidence is
unknown. `CloudIdleStopScheduler.readActivity()` does not renew activity or
consume an idle-stop attempt. Idle-stop still includes presence in its busy
check; the update snapshot reports presence separately for policy selection.

The hook is exposed at `GET /internal/runtime-quiet` on the engine's existing
internal-readiness boundary: loopback peer and Host, exact readiness capability,
no query string, and `x-zeros-quiet-challenge`. It rechecks engine readiness after
the asynchronous read. Missing hooks, old engines, invalid challenges and
unavailable readiness never imply quiet. Responses contain only the closed
snapshot schema; errors return the existing fixed unavailable/not-found body.
There is no client RPC for this observation. Local and organization-owned local
engines never perform the inspection.

`CloudUserPresence.snapshot(attached)` requires a fresh admitted report for each
attached cloud client. An explicit negative report proves absence for its
90-second lease; a missing, expired, replaced or revoked client report is
unknown. Any present device blocks the default policy. No attached clients means
absent. The renderer's existing presence rule is a visible window with input in
the last 15 minutes, on a device that is neither locked nor suspended.
The current interaction client sends a negative report on withdrawal, without periodic negative
renewal (`CloudWorkspaceInteraction.refresh`). After 90 seconds an attached
inactive client therefore becomes unknown and this policy defers until a new
report or disconnect. Keeping absence continuously provable requires an interaction-client
renewal change; this slice does not infer absence from an expired lease.

The control-plane module
`apps/control-plane/src/cloud-workspaces/runtime-quiet-trigger.ts` exports:

- `CloudRuntimeQuietReader`: an injected, authenticated pinned-controller reader
  accepting the exact source scope, a fresh challenge and an abort signal.
- `readFreshCloudRuntimeQuietSnapshot`: validates the closed schema, exact scope
  and challenge, and a two-second monotonic bound. It aborts hung reads and
  suppresses raw reader errors. The adapter must additionally bound response
  bytes and authenticate the pinned source; the challenge is not authentication.
- `cloudRuntimeQuietAbsentPolicy`: the default policy, requiring 60 quiet
  seconds, stable activity, ready record synchronization, absent presence and
  all workload/PTY/process guards clear. Unknown evidence defers activation.
- `DatabaseCloudRuntimeQuietTrigger.consider(input)`: an optional quiet offer
  entry point that reuses the existing server workload query and the transfer service's
  selection and single-transition lock. It cannot activate a runtime.
- `DatabaseCloudRuntimeQuietTrigger.prepareActivation(claim)`: returns a
  `CloudRuntimeActivationPolicy` for a staged, live worker claim. Its `authorize`
  callback runs under the transfer service's existing lock, requires the exact
  claim, obtains a new snapshot with the same activity revision, and checks
  server work before and after that read. A refusal leaves the transition staged
  and the source usable; it changes no command or queue pause state.

Background background staging continues to call `offer` independently of quietness;
this module adds no scheduler, poll interval or startup wiring. The resident host owns the
resident-host safe-point/attach fence and must combine it with the final
observation policy before activating. A read-only snapshot cannot close the
last race between an observation and new VM work. The policy is injectable so
qualified live handoff can change the presence/PTY gates without duplicating
selection, enrollment or transition ownership. No gate is relaxed automatically:
that still requires the appropriate runtime/controller qualification and
measured reconnect gap (at most 2 seconds for the live-handoff path). Until then
the default remains absent clients and 60 quiet seconds. Bootstrap qualification
and measurement remain separate.

The hook and policy are implemented, with resident fencing described below.
They do not enable production activation or establish a measured gap or
exactly-once external tool effects. A qualified controller and actual live
acceptance remain required.

## Resident handoff and consumption journal

The control-plane adapter implements the resident VM integration contract. Resident activation is an explicit engine-mode
request with `handoff: {challenge, organizationId, workspaceId, generation,
engineInstanceId, hostId, fence, expiresAtMs}`. It cannot use the bootstrap path
or fall back to ordinary `prepare`. The fixed adapter validates the complete
source, controller, target and resident trees independently. Its cgroup census
permits only the exact root-attested resident workload alongside the host;
every engine/setup scope must be empty after retirement.

Migration **0137** is additive expand; 0136 is unchanged and there are no new
expand exceptions. `cloud_workspace_runtime_handoffs` records these separate
commits under the existing per-workspace transition and worker fences:

| Journal phase | Durable meaning | Recovery action |
| --- | --- | --- |
| `consumption_authorized` | Root supplied the scoped, fenced resident receipt; current candidate and independent resident qualification passed. Source record/heartbeat authority remains live, but new command claims are blocked. | Inspect the exact root receipt; no staging cancellation or ordinary prepare. |
| `consumed` | Root's resident-aware prepare consumed the sealed source, detached its resident authority and proved engine/setup retirement. | A live claim can finish server retirement; `reconcile` does so within the bound. |
| `source_retired` | Server source authority is revoked and the existing transfer phase is `activated`. | Existing fresh enrollment, registration, challenged health and rollback paths apply. |
| `cancelled` | Root confirmed cancellation on the same live, still-attached source before consumption. | Cancel this offer, retain the source pin/epoch and queue pause state, permit a later offer. |
| `uncertain` | The consumption deadline expired without a conclusive root receipt. | Retire server authority, preserve the VM and require recovery verification. Never infer that its writer can resume. |

Authorization expires at the earlier of the resident receipt expiry and 90 seconds.
The original stage deadline and worker claim also apply. The VM retries a lost
prepare reply only with the identical handoff and resident fields, so the
supervisor can replay its unspent one-use session. Neither this session nor
enrollment credentials enter the database journal or diagnostics. A root
process crash with an unfinished local journal blocks an ordinary activation
retry; uncertain disk/controller state requires inspection, not an inferred
rollback. Automatic target-health rollback still runs within the existing
bounded conversation when source retirement is confirmed.

The duplex protocol adds `authorize_consumption`, `consumed` and
`cancel_consumption`. `createResidentRuntimeUpdateHandlers` in
`apps/control-plane/src/cloud-workspaces/runtime-resident-update.ts` binds them
to `DatabaseCloudRuntimeTransitionService.authorizeResidentConsumption`,
`recordResidentConsumption`, `retireResidentSource` and
`cancelResidentConsumption`. Consumption is committed before retirement in
separate transactions. Missing resident handlers fail closed. The caller owns
worker-lease renewal, an injected activation policy, construction of bounded
enrollment material, a fresh pinned-root health probe and `finish` after the
runner's final receipt. There is no new public/client mutation endpoint.

`cloud_runtime_resident_transfer_qualifications` is an operator-published,
revocable record for the exact source engine / target engine / controller /
resident runtime / base / mode combination, with an evidence digest. Ordinary
runtime-transfer qualification alone is insufficient. An older resident host
can remain only when that exact combination qualifies its independent
`zeros.resident-pty/v1` protocol; the current engine protocol does not attest the
host. No broad version-range or N-1 exemption is inferred. Source/target runtime
and credential-kind qualification remain mandatory at their existing joins.

Every resident enrollment records its own detached witness. Target and rollback
start with new engine UUIDs and a higher resident fence. Registration still
uses the immutable generation pin and existing transfer service; authenticated,
challenged health additionally verifies that exact resident host, generation,
engine and attachment fence. Rollback never recycles a prior resume-proof epoch.

A start rejected before attachment can reuse the original detached fence only
when a fresh root status proves the unchanged detached resident and an exact
prepare replay proves the original session is still unspent. The control plane
also requires that candidate registration has not consumed its enrollment.
A failed or lost start retains the planned target authority: rollback must
prove and detach that exact attachment, or remain `recovery_required`. A
rejected response alone never proves that attachment or session state survived.

Queue recovery shares the lifecycle queue rule: undispatched commands retain their pause state
only for the exact successfully enrolled target/rollback engine. Their durable
command/claim identities remain unchanged; interrupted dispatched commands stay
uncertain, and ordinary replacement engines still pause the queue. Actor and
device authorization are checked again before dispatch. Source claims remain
blocked between authorized consumption and confirmed cancellation/retirement.
The client's existing FIFO/reconnect code remains responsible for retrying a
send that has not yet reached the durable queue with the same command identity.

This path changes only organization-owned cloud execution. Local and
organization-owned local workspaces do not call these control-plane adapters;
owner/placement switching retains exact organization/workspace/engine scope.
It does not enable a production activation worker, advertise resident support,
relax presence/PTY eligibility, or claim a measured reconnect gap. Those gates
still require qualification and the disposable acceptance run with actual
workload-survival assertions.
## VM safe point and resident attachment

The VM implementation extends shared `cloud-runtime-quiet-state.ts` and
existing supervisor `prepare` / one-use session / `select-runtime` / `start`
path. It does not enable a control-plane activation policy or change the quiet
path's conservative eligibility rules. Staging is independently gated.

- Root sends `runtime-handoff`, action `prepare` or `cancel`, with `handoff`:
  `{challenge, organizationId, workspaceId, generation, engineInstanceId,
  hostId, fence, expiresAtMs}`. IDs are UUIDs, counters are positive safe
  integers, and expiry is at most 15 minutes away. The private engine endpoint
  uses the distinct readiness credential from root's admitted launch material;
  callers cannot choose its destination or credential.
- `prepare` pauses new queue claims and returns `draining` while admitted turns,
  approvals, tools, mutations, legacy PTYs, active preview/native-service streams
  or unknown user processes remain. Resident terminal processes alone do not
  block. Only the exact kernel resident cgroup is excluded from process census.
- When drained, fence new engine/service admission, recheck activity and
  authority after census, finish checkpoint/event/record writes, and close/seal
  SQLite. A `fenced` receipt repeats the request plus `version: 1`, `phase` and
  `activityRevision`. Before consumption, cancellation/expiry may restore the
  writer and admission only under the same live source authority.
- Root then uses existing `prepare` with both `resident: {hostId, engineId,
  fence}` and the identical `handoff`. It rechecks/consumes the receipt, detaches
  resident authority, and proves engine/setup retirement while preserving that
  resident scope. The response contains the existing one-use session and the
  detached resident witness. A lost response can replay the same unspent
  session; a consumed source writer never resumes, even after expiry.
- Existing `select-runtime` and `start` use that session. Target and rollback
  attachments need a fresh engine UUID, higher resident fence and fresh server
  enrollment/proofs. The controller runtime, resident-host runtime and selected
  engine runtime are distinct proof inputs; selected engine bytes do not attest
  the still-running host. Protected v4-5 base assets are unchanged.

The resident adapter uses the consumption journal above, preserving source
server authority until root consumes its handoff. Missing handlers or ambiguous
receipts fail closed; there is no fallback to destructive ordinary `prepare`.
Ordinary engine-only preparation retires its own scopes and cannot be used to
claim resident process survival.

First qualification must include this resident host and adapter together; no
resident capability is advertised by this slice. The private snapshot request
opts into retained exit status with `includeExit: true`; legacy requests retain
their exact response shape. Replay cursors are per device and reauthorize after
snapshot reads. Root consumes private launch material before user subprocesses
are constructed; the engine's registry is a disposable resident-host view.

Local Linux tests exercise real PTY/dev-server PID survival, repeated attachment,
rollback fences, redaction, two-device ordered replay, fast/disconnected exits,
drain/cancel/expiry, SQLite sealing and active-stream blockers. They do **not**
qualify a live Alpha swap, schema rollback, fresh provider proof or the ≤2-second
gap. Active SSH/preview streams and engine-owned Setup/Run/provider processes
still delay activation. Device-to-engine terminal input has no durable client
acknowledgement today; host-side input deduplication alone does not establish
lossless typing during a client reconnect. Keep present-client activation gated
until live acceptance verifies that path and the agreed client retry contract.

## Gated live acceptance harness

This is a gated harness, not runnable live Alpha acceptance. The harness exposes
[`AlphaLiveUpdateAdapter`](../../scripts/cloud-workspace-validation/live-update-acceptance/contract.ts),
but the concrete adapter/controller is deferred to a separate reviewed slice.
Missing implementation or unqualified capabilities refuse before creation.
Production and present-client activation remain disabled.

Future command, **after the prerequisites below are implemented and qualified**:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/live-update-acceptance/cli.mts \
  --adapter scripts/cloud-workspace-validation/runtime-hot-update-alpha/adapter.ts \
  --config .context/zeros-v2-test-live-update.json
```

The agreed adapter path is not shipped yet. It must export
`createAlphaLiveUpdateAdapter({credentials, configPath, signal})`. The CLI resolves
an explicit config file and passes only allowlisted `.env.agent` entries in a
private map, including `ZEROS_HU_ALPHA_ACCESS_TOKEN` and
`ZEROS_HU_ALPHA_DATABASE_URL`; there is no ambient environment fallback. The
adapter's import, factory, identity and preflight are read-only and silent.

The adapter must validate a strict noncredential config: `version:1`,
`channel:"alpha"`, organization/test-user/template-build UUIDs
(`organizationId`, `testUserId`, `templateBuildId`), `sourceRuntimeId`,
`targetRuntimeId`, `baseCompatibilityId`, a `repository` object with
`forge:"github.com"`, `owner`, `name`, `revision`, `githubInstallationId` (UUID)
and `expectedSha` (reviewed 40-hex source commit), and an `agent` object with
`agentId:"claude"|"codex"|"cursor"`, `modelId` and `credentialId` (UUID).
No endpoint override, existing-workspace ID or credential value belongs in this
file. Config content validation belongs to the reviewed adapter, not this CLI.

Enablement prerequisites remain explicit:

- A concrete Alpha adapter/controller using actual lifecycle APIs, a dedicated
  staff test account/template and the existing Alpha provider credentials.
  Alpha origins must be fixed; no unsupported hosted endpoints are assumed.
- Source A and newer B qualified as the exact resident/rollback pair, including
  compatible SQLite, fresh server-verified proof inputs and qualified first
  resident enrollment. Ordinary setup/bootstrap does not enroll a host today.
- Trusted root quiet/readiness observations and a handoff-aware final policy.
  The ordinary quiet predicate regards a fenced engine as busy. `runtime-observe`
  is a separate proposed supervisor operation; the current supervisor does not
  expose it.
- Real device-to-engine acknowledged input/retry, independently authenticated
  reconnect/replay observations from two devices, an ordinary provider turn
  held at a test tool gate, and candidate-scoped root health-failure injection.
  Host-side input deduplication alone is insufficient; report
  `inputAcknowledgements:false` until the client path exists.
- Idempotent provisioning and verified all-generation cleanup inventory. The
  orchestrator holds credentials and performs live runs; none were run here.

The runner stages B during a held ordinary turn, queues a duplicate prompt,
drains that turn, then injects failed B health and requires **A → B → fresh A**.
The first queued prompt must complete once on fresh A. It starts a second held
turn, stages the same newer B, queues a separate prompt and requires a healthy
**A → B** retry; that prompt completes once on B. It never requests B → A as a
new target selection. Prior input and completed prompts stay exactly once.

Both transitions preserve terminal/server PIDs, boot/allocation/controller/host
identity and sentinel digest; require fresh engine/proof/authority/fence; and
converge on both devices. The runner measures last source to first replacement
response and rejects a gap over two seconds. Synthetic tests verify assertions,
not live timing or continuity. Keep activation gated until real evidence passes.

The adapter exposes independent `identity`, qualified `preflight`, idempotent
`provision`, two-device `connect`, `stage`, `handoff` and `cleanup`. Devices expose
workload start, `holdTurn`, authenticated observation, acknowledged input,
durable enqueue, turn release and close. Observations must use actual engine
round trips and verified enrollment, never locally invented IDs or cached UI.

Before provisioning, fsync a private operation journal in `.context/`, including
the preflight organization and all input/prompt/transition/retry-turn identities.
Only `zeros-v2-test-lu` (default) or `zeros-v2-test-hu` is allowed by
`--name-prefix`. Lost create replies reuse the same identity. Cleanup uses
independent staff/org identity and remains available after pair revocation; it
must match the journaled organization, reconcile ambiguous operations and prove
all generations/resources/pending deletion inventory empty. A DELETE reply is
insufficient. Older journals with a workspace can recover its organization;
older ambiguous journals without either organization source fail closed.

Resume interrupted cleanup with the same future command plus
`--cleanup .context/zeros-v2-test-lu-<operation-id>.json`. Do not discard a
`cleanup_required` journal. Closed reports contain only operation/workspace IDs,
fixed result codes, measured gaps and cleanup state. The adapter must retain
additional provider resource IDs in a credential-free inventory for the
orchestrator's live report; no raw provider errors or workload output is logged.

## Local, devices and qualification

Personal Local and organization Local retain their engine/PTY/filesystem/offline
lifecycle. Cloud updates select only exact organization/workspace/generation/
engine authority; owner switches and late source frames cannot retarget another
workspace. All devices observe one transition and queue with bounded replay.

Required acceptance includes busy/drain/final-switch races, expired/revoked
claims/pins/delegations, stage failure, lost registration/health/prepare replies,
rollback and unknown recovery, compute/source-delete races, queue pause state,
dirty Code/Design/Git/index/chats, exact source/target/controller/resident proof,
real PTY/dev-server PID/output/input continuity and all-generation cleanup.
Measure stage age, drain interval and handoff gap separately. The live target is
≤2 seconds last authenticated source→first authenticated/replayed target;
bootstrap/quiet paths have their own measured bounds. Existing pending/error
presentation remains truthful when a gap exceeds its thresholds.

Current active provider turns, MCP/approval/background leases, engine-owned
Setup/Run processes, SSH/native service and preview streams still block relevant
activation. Client terminal input has no durable acknowledged retry contract;
host deduplication alone cannot establish lossless typing through reconnect.
Keep present-client activation disabled until that client path and exact
controller/workload survival pass live acceptance. Publish sanitized evidence
outside public docs. See [qualification status](qualification-status.md).
