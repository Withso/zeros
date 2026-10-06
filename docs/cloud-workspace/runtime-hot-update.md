# In-place cloud runtime updates

Status: approved internal Alpha design; implementation is staged. This document does not enable updates or
claim live qualification. It extends the [runtime bundle contract](runtime-bundles.md).
Automatic wake upgrades and quiet running updates must use one transition owner;
they differ in whether they replace the allocation or retain it.

## Existing lifecycle and preservation boundary

1. The control plane selects a confirmed Alpha release, a nonrevoked base and
   qualifications in the configured `smoke`/`full` mode. Creation currently
   requires the three subscription credential kinds; runtime credential
   admission additionally joins the actual credential kind. Selection and
   revalidation lock the revocable registry rows. A generation saves six runtime
   fields; ordinary wake/setup retry reloads that pin instead of channel head.
   See [runtime-selection.ts](../../apps/control-plane/src/cloud-workspaces/runtime-selection.ts).
2. Setup sends the strict, bounded `zeros.runtime-install/v1` document on the
   fixed installer's stdin over pinned SSH. The base verifies compatibility,
   HTTPS artifact host/expiry, archive size/hash, canonical manifest digest,
   complete inventory, ownership/modes and link confinement. It extracts into a
   fresh `/opt/zeros-infra/<runtimeId>` with an incomplete marker, then publishes
   the receipt. Cached trees are verified too. Boat persistence requires atomic
   **file/symlink** publication, never renaming an existing runtime directory.
   [Bootstrap.install](../../scripts/cloud-workspace-validation/runtime-base-v4/bootstrap.py#L1268)
   then unconditionally calls `switch`, stops `zeros-host.service`, changes
   `current`/`previous`, and starts the host. There is no staging-only command.
3. Dispatch verifies the chosen tree and publishes the boot/session/receipt-bound
   active descriptor. The root supervisor pins its runtime and launcher when it
   starts; its `prepare` operation retires the old engine/setup scopes. Setup
   redeems a one-use grant, prepares the supervisor, attests before repository
   hooks, prepares repository/settings, attests again, starts the engine and
   checks authenticated readiness. See
   [executeSetup](../../scripts/cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs#L2678)
   and [supervisor](../../scripts/cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs#L265).
4. The v4 attester holds the engine lock. `verify_tree` verifies installation and
   helpers; `qualify_engine` runs containment/security/resource checks (including
   `containment_smoke`); `run_setup` runs the setup **containment probe** and checks
   `setup_exit`, including detached-descendant and timeout retirement. It is not
   the repository's setup hook. `publish_proof` rechecks runtime and namespace
   identity and writes a short-lived, single-use launch proof. Installer
   `run_setup` is a different stage: it invokes the complete setup helper and
   reports nested failure as `setup_exit`. Neither check may be skipped merely
   because the checkout is already set up. See
   [attestV4CloudWorker](../../scripts/cloud-workspace-validation/sandbox/attest-cloud-worker.mjs#L925).
5. Setup redemption inserts a starting engine with the generation's six fields
   plus installer receipt digest, boot ID and supervisor session ID. Registration
   consumes its exact setup/fence-bound grant and compares the reported identity;
   record synchronization and authenticated readiness precede workspace-ready
   publication and immutable setup attestation. Database triggers prohibit
   changing either generation pins or engine identities. Agent discovery,
   execution and renewal use `runtimeCredentialQualificationJoin`, requiring
   exact engine/generation equality and live registry qualifications. See
   [setup-materials.ts](../../apps/control-plane/src/cloud-workspaces/setup-materials.ts#L1060),
   [setup-worker.ts](../../apps/control-plane/src/cloud-workspaces/setup-worker.ts#L806)
   and [migration 0124](../../apps/control-plane/migrations/0124_cloud_runtime_registry.sql#L175).

An engine restart is not process preservation:

| State | Same VM, engine replacement |
| --- | --- |
| Files, Git working tree/index/refs, Design source | Remain on the existing files bind; no clone or checkpoint restore. |
| Engine SQLite and native histories | Remain under `/srv/zeros/state`; reopen only with compatible formats. Flush durable record writes before the switch. |
| Chats and command receipts | Remain in the control-plane durable record and local persisted state; resynchronize before admission. |
| PTYs, agents, background jobs, setup/run processes | Shutdown and cgroup retirement can kill them. Their absence is mandatory, including sleeping/detached processes. |
| Preview/SSH connections and language services | In-memory connections do not survive. Live sessions/traffic block the update; restartable idle infrastructure may pause and resume. |

These paths are grounded in [engine stop](../../apps/desktop/src/engine/zeros-engine.ts#L3116),
[idle guards](../../apps/desktop/src/engine/zeros-engine.ts#L3246) and the
[v4 persistence layout](../../scripts/cloud-workspace-validation/runtime-base-v4/README.md).
Preservation of application data does not prove downgrade compatibility of a
new CLI history format or SQLite migration.

Checkpoints are encrypted application recovery points, not VM/process snapshots.
They retain the documented safe file projection, native Git state, selected
provider histories, Design state and attachments; they exclude credentials and
arbitrary ignored/home data. Periodic capture can run with writers and defer on
changes. Final lifecycle capture quiesces by stopping jobs and terminals, so HU
must not call that path to *make* a busy workspace quiet. HU captures after a
non-destructive quiet reservation, keeps the checkpoint as disaster recovery,
and normally reuses the full existing disk. See
[checkpoint semantics](checkpoint-native-format.md) and
[performCloudCheckpointRequest](../../apps/desktop/src/engine/zeros-engine.ts#L3293).

## One transition, two triggers

RU owns candidate selection, wake/start admission, the per-workspace transition
lock and fallback. HU consumes those operations with trigger `running_quiet`
and execution mode `retain_allocation`; RU uses trigger `wake` and mode
`replace_allocation`. These names describe the proposed interface, not shipped
exports. Both return the same transition ID/source/candidate generations and
join an existing transition on concurrent requests. PERF owns worker scheduling
and notification; HU supplies bounded work steps, not another polling system.

Selection preserves the source base image, base compatibility, provider
connection/version, resources, Cloud Computer template/environment/settings and
repository pins. Require a strictly later confirmed release, supported engine
protocol, live qualifications in the configured mode, and qualification for
every credential kind delegated to this workspace (including API-key kinds and
MCP requirements where used). Never weaken current required-kind qualification.
Recheck delegation changes and revocation at activation and registration. No
candidate or unsupported base means defer, without disturbing the source.

Choose a **new immutable generation on the same allocation**. Do not update the
source's runtime columns or weaken engine/generation equality. Insert candidate
pins and copied setup/template provenance through RU's existing copy boundary.
Retain the source row for rollback and audit. A dedicated transition sidecar
records execution mode, source engine, allocation identity, activity revision,
phase/deadlines, target descriptor, receipt/proof identities and worker fence.
An additive migration must receive its number from the orchestrator first.

The existing transition schema requires drain/provision lifecycle intents and
its completion schedules source deletion. Retaining an allocation therefore
needs an explicit schema/dispatcher extension; a fake successful provider stop
or create is forbidden. Retain the single-active-transition constraint. Every
completion, rollback, cancellation and cleanup path branches on execution mode.

### Allocation transfer and admission

At candidate registration, one transaction under the workspace/transition lock:

- Confirms the exact source engine is fenced/retired, the allocation has not
  changed, and target proof and qualifications remain valid.
- Moves the unique provider binding to the candidate, records immutable transfer
  evidence, updates `current_generation` and authority epoch, and admits a fresh
  target engine whose complete pin equals the candidate. No resource is marked
  physically deleted. Source cleanup must never target the transferred VM.
- Transfers the existing funded allocation and credit-reservation association
  consistently, preserving meter/coverage/deadline and allocation identity. This
  must include compute-worker claim fencing: an old generation's already-claimed
  worker must not stop the transferred VM. Do not create a second reservation,
  reset spending or extend a provider deadline as a side effect of HU.

Keep the reservation's originating identity immutable. Add an audited current
allocation-to-generation association and make compute authority/worker scope
resolve that exact association; do not rewrite old ledger rows to manufacture a
candidate reservation. The association, binding and `current_generation` change
in the same transaction and reverse together on rollback. A source binding loses
its live resource pointer with transfer evidence retained, not a false deletion
receipt. Until all existing workers understand this fence, HU remains disabled.

This is a required compute-lifecycle change, not billing feature work. Current
[compute authority](../../apps/control-plane/migrations/0073_cloud_workspace_compute_leases.sql#L62)
joins generation, binding, lease and reservation; the
[lease worker](../../apps/control-plane/src/cloud-workspaces/compute-leases.ts#L935)
stops an allocation on generation mismatch. Binding transfer alone is unsafe.
Likewise the unique provider-resource index forbids two simultaneous live
generation bindings. All provider stop/delete paths need the transfer fence,
including calls claimed before activation; an in-flight destructive call blocks HU.

Candidate enrollment uses a new, one-use **transition-scoped** registration
capability and exact candidate identity. It cannot reuse the old setup grant or
heartbeat token, redeem repository secrets, or authorize agent/tool execution.
It permits enrollment into the candidate only for the recorded execution fence;
registration transfers authority atomically as above. The workspace stays
unavailable for ordinary admissions until durable-record synchronization,
authenticated health and an exact transition attestation complete. Do not mark
ordinary repository setup as rerun. A lost registration response is reconciled
by transition/engine identity, never by minting another active engine.

PERF's resume cache keys `(generation, runtime_id, manifest_sha256,
base_compatibility_id, engine_instance_id)` remain exact. HU never reuses cached
functional qualification or workspace preparation during a runtime transition;
it runs fresh attestation even if the source previously qualified. Slice 2 exposes `readCloudRuntimeResumeProofEpoch(tx, { workspaceId, organizationId,
generation })` from
`apps/control-plane/src/cloud-workspaces/runtime-transition.ts`. Its epoch is the
enrolled engine instance UUID, rather than a second mutable counter. A completed
epoch may survive stopping the same generation, so the hook does not itself
disable PERF's resume cache. It returns `null` during any unsettled/uncertain
transition, incomplete enrollment or engine/generation pin mismatch. Every target and rollback enrollment uses a fresh
UUID, including after a failed launch; rollback never restores a cached epoch.
PERF may reuse evidence only for the same non-null epoch and full cache key,
under the shared lifecycle lock, with its fresh launch and restored-tree checks.
The adapter's `validate_enrollment_environment(...)` independently rejects the
source engine ID and any candidate ID previously used by the same invocation.

The disk pointer and PostgreSQL cannot commit atomically together. The durable
transition journal and closed admission interval bridge that gap: at no point
may a ready old engine use the new generation or a candidate use the old pin.
During the gap there is no usable engine, rather than an admission exception.

## Quiet reservation and execution

The engine and control plane must both prove quiet. Use the idle-stop workload
guards and IW2 interaction revision, with **60 seconds** since the last actual
user interaction or busy-to-idle edge. Passive reads, snapshots, heartbeats and
mere attachment do not reset it. A fresh engine observes its own full interval.
Unknown/stale observations, failed record sync or an unavailable process scan
are busy. Required guards include turns, approvals/questions, background leases,
native processes, commands in dispatch, mutation/process starts, setup/run,
live PTYs, SSH/tunnels and active preview traffic. Read process identities/state,
never argv or environments. Keep the existing UID process scan conservative.

Until the disposable acceptance runner measures a reconnect gap **at most 10
seconds**, automatic activation also requires **no present client on any device**.
Use IW2's presence signal: no window focused with input in the preceding 15
minutes. Unknown/stale presence blocks activation. After measured qualification
establishes the 10-second bound for the applicable execution path and runtime
pair, a present user may be merely quiet under the same 60-second rule. Bootstrap
and engine-only measurements are separate; a fast engine swap does not qualify
the one-time host restart. Recheck presence at the final activation decision.

| Phase | Authority and failure behavior |
| --- | --- |
| Offer | RU selects and records the candidate under its transition lock. Source remains usable; intent has a 15-minute staging deadline. |
| Stage | Trusted installer verifies/downloads/extracts beside the source. It does not switch pointers, invalidate source proof, stop the host, or run repository hooks. Failure leaves the source untouched. |
| Reserve | Record the source engine/activity revision. Close engine process-start/mutation admission synchronously and reserve server-side admission under the same workspace lock used by enqueue/claim/service grants. Pause only restartable idle infrastructure. |
| Verify quiet | Rescan processes, flush record writes and finish a bounded checkpoint without killing user work. Repeat all guards and the activity revision after every awaited preparation step. Any new work before activation cancels the reservation and resumes the source. |
| Activate | A compare-and-set on the reservation/fence is the point of no return. Subsequent user actions queue. Retire only the idle engine scope, prove it empty, atomically select the verified target, create its active descriptor, attest and launch it. |
| Register and health | Use the transfer transaction above, then exact authenticated readiness plus durable-record connection. Proposed activation-to-health bound: 240 seconds, including attestation; measure and tighten it before rollout. |
| Complete | Mark RU's transition successful, preserve undispatched queue pause states, release admission and notify clients. Keep the previous verified runtime available for rollback; never enqueue VM deletion. |
| Roll back | Fence/retire the candidate, verify the saved runtime, switch back and reattest; register a fresh source engine and atomically reverse binding/lease/current-generation transfer if it occurred. Proposed recovery bound: 240 seconds. Never reuse expired grants or resurrect revoked qualifications. |

Before activation, even a new unpaused queued command cancels HU. After the
activation decision, incoming commands are held for the selected healthy engine.
The lock orders that race; a cached `busy=false` value cannot authorize a switch.
Unknown crash state is reconciled from the durable phase and exact disk/engine
witnesses. A VM-local watchdog survives engine exit; it does not infer rollback
from a lost HTTP response. If the control plane cannot confirm which generation
owns authority, or rollback fails, admission stays closed and disks are retained.
No design can guarantee bounded *availability* through an unbounded partition.

## Installer and bootstrap rollout constraint

The intended execution path needs a verified `stage` operation and an
authenticated engine activation operation, reusing the existing installer
verification and publication primitives. The stable privileged controller must
live outside the engine it replaces. It selects launchers from verified runtime
descriptors, never an engine-supplied path or command. Root-only stdin/socket
messages bind workspace, organization, source/candidate generations, source
engine, boot/session, target digest, transition ID/fence, nonce and expiry.
Capabilities and artifact URLs are memory-only and absent from journals/logs.

Full `verify_tree`, engine/containment and setup-containment checks remain
mandatory; `publish_proof` binds the final descriptor and launch namespace. The
current attester takes a lifetime engine lock and resolves only the active
runtime. A preflight of a staged target must not overwrite that descriptor or
its proof while the source runs. Until isolated preflight is implemented and
qualified, final attestation runs during the fenced gap. Its current probe
bounds (180 seconds plus 30 seconds) mean a sub-10-second reconnect gap is an
acceptance target, not an established property.

The authorized rollout has two paths:

| Path | Mechanism and user-visible effect |
| --- | --- |
| Existing v4-5 VM, first migration | Once, use the protected install-and-switch command on the same VM to install a runtime qualified for its **existing** base compatibility. The host service and idle engine restart; the VM and persisted files/Git/SQLite/chats/Design stay. Existing connections reconnect and queued sends wait. No live PTY, job, setup, SSH or preview is allowed to be interrupted. The reconnect gap includes host start, attestation, engine registration and health; it is unmeasured and may exceed 10 seconds. Proposed activation/rollback bounds are 240 seconds each, not a measured latency promise. |
| Update-capable resident supervisor | Stage a verified runtime, reserve quiet, restart only the engine, attest and register. The host PID, VM and base identity remain unchanged. The gap still includes required final attestation and must be measured; it is not assumed to fit U5's 10-second presentation threshold. |

The first path needs a control-plane worker/watchdog outside the host service
being restarted. It retains the exact previous descriptor and a bounded rollback
capability, bounds retries, and restores the saved runtime on failed
registration/health. The old installer has no cancellation handshake between
verification and switch. Use a fixed deployment-owned root adapter around the
protected `Bootstrap.install` path, with a final guarded host-stop callback:
recheck source/boot identity and obtain the one-use activation decision before
delegating to the unchanged host stop. Never override verification or use a
best-effort process signal as the final cancellation fence. The adapter is part
of the reviewed control-plane fixed-command allowlist, delivered only over its
pinned root SSH channel; no engine/client-supplied code is accepted. Its exact
compatibility with the protected base must be tested before migration is enabled.
New activity before that decision cancels; later activity joins the waiting queue.
Do not send `workspace-setup` and accidentally rerun repository hooks. Enrollment
and launch use the transition-specific, verified helper after installation.

Old engines cannot be assumed to implement new quiet RPCs. Bootstrap admission
must prove cooperative quiescence with a qualified existing idle-stop/checkpoint
fence plus server-side interaction evidence, or defer. Its existing ten-minute
idle interval is an acceptable conservative wait. An unknown old-engine busy
state is never converted into permission to restart it. The bootstrap adapter
must prove that work arriving before switch cancels; the existing monolithic
installer alone does not provide that protocol.

For v4-5, the update-capable runtime must own a tested adapter to the protected
installer's verification/extraction primitives, stopping before its destructive
switch. No protected file is changed. Qualification must demonstrate that
staging cannot stop the host, change either pointer/active descriptor, or bypass
any archive/tree/receipt check. The resident supervisor selects the target only
after retirement, and records its own pinned controller runtime separately from
the new engine runtime: remaining old controller code must not be attested as
new code. Qualification covers that controller/target/base combination, including
its Node ABI; unsupported combinations defer rather than hot-loading arbitrary
modules or silently recycling the host again.

If these operations cannot be implemented safely through the unchanged v4-5
primitives, add explicit stage/activate support to the next qualified v4-6 base
for new Cloud Computer builds. Bootstrap/systemd bytes are hashed into
`baseCompatibilityId` by the
[base builder](../../scripts/cloud-workspace-validation/boat-image/templates/v4/build.sh#L70).
Never patch them while retaining the old compatibility ID. The one-time quiet
host restart remains the approved migration for existing VMs; it is not proof
that their unchanged base supports subsequent engine-only updates. That capability
must be demonstrated before advertising ongoing HU on those VMs.

## Clients, queues and data compatibility

Use the existing automatic reconnect and ordered replay. U5 owns presentation of
short gaps; IW2 owns durable submission while no engine is available. These are
dependencies, not proof of delivery. Reuse RU's automatic-transition queue rule:
carry **only undispatched** commands to the new generation/engine, preserve
position, command/operation/user-message IDs, actor evidence and saved pause
state, then revalidate actor/delegation/model admission. Duplicate submissions
return the same receipt. Never replay `dispatching` work; it blocks HU, and
ambiguous crash outcomes retain the existing `uncertain` semantics in
[commands.ts](../../apps/control-plane/src/cloud-workspaces/commands.ts#L213).
Exactly-once here means queued-command admission/claim across this controlled
handoff, not a promise about arbitrary external side effects after a crash.

Require a separately recorded HU compatibility qualification for the source to
target pair: engine DB migrations and provider history formats must remain
readable by both runtimes throughout the rollback window. Base/credential
qualification alone does not prove this. No automatic destructive migration,
repository setup rerun, Git rewrite or checkpoint restore is part of HU.

## Implementation slices and verification

1. Verified installer/controller adapter and v4-5 bootstrap.
2. Additive migration **0136** (assigned by the orchestrator), allocation transfer
   and enrollment service, based on RU after its merge.
3. Quiet trigger, including the measured-gap presence gate above.
4. RU/IW2 durable queue integration.
5. Disposable Alpha acceptance runner, executed by the orchestrator.

The first slice adds a fixed deployment-owned Python adapter, shipped both with
the isolated control plane and in the runtime bundle. It imports the unchanged
protected v4 installer, stages through its complete verification path, and
intercepts only the destructive switch. Staging and activation share the
existing setup/install locks. The adapter's bounded root SSH conversation asks
for a final transition decision before retirement, then for one-use enrollment
and authenticated health. A small fixed loader verifies the deployment's exact
adapter digest before execution; source and request bytes travel on the pinned
channel's stdin, within the SSH forced-command size limit. It never executes
repository hooks. Root journals
contain identities and closed phases, never grants or artifact URLs.

The update-capable supervisor accepts `select-runtime` only after a one-use
prepared session and confirmed retirement. It reuses the protected full-tree
verifier and keeps its resident controller identity distinct from the selected
engine identity. Legacy status/prepare/start behavior is retained. Bootstrap
activation is refused once the resident supervisor supports engine selection.
Failed target health requests a fenced rollback decision and fresh source
enrollment. Unknown authority or failed recovery leaves `recovery_required`;
ordinary update retries refuse that journal until the transfer service
reconciles it. This foundation has no automatic lifecycle caller, registry
qualification claim, or measured live reconnect gap.

Local tests must cover every phase edge and crash boundary: each busy guard;
60-second monotonic interval; stale identity/epoch; work arriving during staging,
checkpoint and the final switch race; both competing triggers; revocation or
credential-kind changes; invalid archive/manifest/proof; stage failure; target
registration/health timeout; lost success response; rollback success/failure;
source-worker stop/delete races; exact binding/lease/reservation/pin consistency;
paused and unpaused queue preservation; duplicate sends; old-engine claim/settle
refusal; and local-engine nonparticipation. Keep attester/installer golden
diagnostics and protocol/standalone-control-plane parity tests.

The planned `scripts/cloud-workspace-validation/runtime-bundle/hot-update.mjs`
runner reads Alpha-only configuration from `.env.agent`. It must fail before
mutation unless deployed endpoints support this protocol and a **staff-only,
qualification-checked create pin** can select an older runtime. Normal creation
selects the latest eligible release today; do not edit registry rows, revoke
shared releases, or pretend an unsupported old-runtime create API exists.

The runner creates only `zeros-v2-test-hu-*`, journals its idempotency/resource
IDs before each action, seeds synthetic files, staged/unstaged/unpublished Git
state, Design source and chat records, then closes PTYs/processes. It triggers
the ordinary quiet transition and measures last successful exact-source event
to first authenticated/replayed target event with monotonic timestamps. Require
unchanged provider allocation and boot identity, a new generation and engine,
exact target pin, preserved state and one queued-command receipt. Exercise busy
abort and bounded failure/rollback on disposable fixtures only. Real provider
turn/history-resume checks remain an owner-run Mac checklist, without copying
provider credentials into this runner.

Always delete the runner's workspace in `finally`, recover lost-create replies
with the same idempotency key, and verify pending-deletion inventory is empty for
all its generations. Report resource IDs, closed checks, gap timings and cleanup
confirmation; no raw responses, prompts, URLs, tokens or exception text. Live
execution belongs to the credentialed orchestrator; none was performed for this
design. Product rollout stays gated until success, abort, rollback and transfer
cleanup are demonstrated. No Beta/Production, deployment or workflow mutation
is authorized by this document.

## Local workspace impact

Local-owner and organization-owned local workspaces keep the existing local
supervisor, filesystem identity and offline behavior. Gate all HU paths at the
control plane/cloud-worker boundary. Shared code changes require a test proving
the local path is untouched; macOS engine smoke remains a separate platform gate.

## Cloud workspace impact

Organization cloud workspaces retain their `cloud://` identity across generation
changes. Reconnect and cached reads remain keyed to exact organization/workspace;
late source-engine events cannot replace the target snapshot. Owner/placement
switching never transfers update state to another workspace. Multiple devices
observe one transition and one queue. Local-owner cloud placement remains invalid.


## Implemented control-plane transfer contract (slice 2)

`DatabaseCloudRuntimeTransitionService` in
`apps/control-plane/src/cloud-workspaces/runtime-transfer.ts` implements the
retained-allocation executor. It has no automatic scheduler or activation
policy installed. LU owns the resident workload host, engine adapter, resident
scope and supervisor attach fence; this service owns the database transition,
registration, health verification and crash deadlines. The subsequent trigger
must supply a policy appropriate to the qualified VM controller. Presence,
PTY survival and safe points are policy inputs, not hard-coded transfer rules.
There is no measured reconnect-gap claim in this slice.

The executor reuses RU's candidate selection and organization/workspace lock,
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
| `offer` | Current source engine and generation, operation UUID, engine/bootstrap mode. Returns the single transition or joins RU's existing one. |
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

LU must expose fresh challenge-bound health and authenticated journal inspection
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
engine path. Automatic triggers, LU's VM-side behavior, RU/IW2 command-queue
handoff and the disposable Alpha acceptance runner are separate slices; they
must be integrated and verified before enabling automatic transfers.
