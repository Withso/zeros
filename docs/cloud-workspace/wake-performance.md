# Cloud wake and create performance

The engineering budgets are **1–2 seconds** for true stopped wake to usable and
**3–4 seconds** for create from an existing Computer template to usable.
Usable requires actor admission, bridge connection, CONNECTED-first handshake
and a successful correlated `workspace.list` probe. Provider-ready, a process
health response or a provisional create row does not establish it. Transcript
paint/first text and still-running reattach are separate endpoints.

## Historical baseline and evidence limits

The owner-supplied Alpha timeline recorded five completed setup intervals:
116.422 / 128.850 / 133.063 / 130.325 / 130.399 seconds, median 130.325 seconds.
A cancelled 112.935-second execution is excluded. Queue-to-first-claim was
0.372–1.202 seconds; engine-row creation→registration was approximately 17–23
seconds; five actor-create→consume samples ranged 2.718–3.447 seconds,
median 2.999 seconds. The Stop example queued for 6.166 seconds.

Setup `started_at` survives reclaim, so these intervals include retries and
backoff. Five default claims can contribute 5 + 10 + 20 + 40 = 75 seconds of backoff;
historical claim counts are unavailable. Engine rows exist before spawn, so
row→registration is not Node initialization or registration HTTP latency.
Actor intervals include client/bridge work and do not measure paint. The
historical setup record proves repeated setup intervals, not loss of persistence
or 130 seconds of guest attestation. Existing journals preserve completed hooks.

No matched wake/create after-run, full intent→paint trace or successful live performance
qualification of this overhaul is available. The VM inspected during the
read-only audit was archived before per-stage probes could run and remained
asleep. Configured timers and fake-clock regressions establish code behavior,
not latency percentiles.

The [measurement runbook](../../scripts/cloud-workspace-validation/workspace-perf.md)
separates read-only timeline, authorized disposable workspace cycle and isolated
VM probe. Labeling a result before/after does not deploy code. Record runtime/
base/template, deployment/client versions, region, claim count, failures and
cleanup evidence. Compare matched configurations and retain failed/time-out
samples. Overlapping spans must not be summed; one run cannot establish p95.

## Agent Send measurements

The [measured legacy controls](qualification-status.md#measured-legacy-controls)
record real renderer Send through typed invalid-auth results for all three
providers, with 0/100 ms injected CP delay. They measure agent dispatch, not
stopped wake or first output. Different source snapshots and single samples
cannot establish a speedup or percentile. The negotiated warm path removes
per-send grant/admit/validate dependencies; its native latency and total/background
request comparison remain pending integrated evidence.

### Baseline / after ledger

Keep historical intervals separate from the effects of current code. The entries
below are the comparison ledger, not evidence that a new runtime is deployed.

| Endpoint | Historical evidence | Current repository change | Matched after evidence |
| --- | --- | --- | --- |
| Completed setup interval | Five samples; median 130.325 seconds, including possible retries/backoff. | Validated preparation reuse; every launch still needs fresh final attestation and registration. | Not collected. |
| Queue to first setup claim | 0.372–1.202 seconds. | Commit hints and nearest eligible retry/lease deadlines, with fallback scanning. | Not collected. |
| Engine row to registration | Approximately 17–23 seconds; not a process-start or HTTP-only interval. | Required startup recovery remains; optional Design capture leaves the readiness path. | Not collected. |
| Actor create to consume | Five samples, 2.718–3.447 seconds; median 2.999 seconds. | Exact actor/engine admission still applies. | No matched attach/consume trace. |
| Fresh create to usable | No complete intent-to-usable trace. | Pending create row paints immediately; confirmed readiness still requires all usable checks. | Not collected. |
| True stopped wake to usable | No complete stopped-wake trace. | Preparation reuse and ready-event settlement with a 2-second fallback. | Not collected. |
| Transcript paint and first text | No signed Mac comparison trace. | Bounded durable provisional transcript cache and separate renderer spans. | Not collected. |

## Current critical path

| Stage | Current code | What remains to measure |
| --- | --- | --- |
| Desktop create/wake | Renderer `state/cloud-workspace-create.ts` publishes a scoped pending row; `cloud-workspace-wake.ts` settles exact catalog events with a 2-second fallback. | Receipt, confirmed UUID, navigation and visible paint separately. |
| CP queue/claim | `worker-scheduler.ts`, `reconciler.ts`, `setup-worker.ts` consume commit hints and nearest eligible retry/lease deadlines, retaining periodic fallback. | In-flight work, lock/prerequisite and first/reclaimed claim delays. |
| Funding/allocation | `compute-leases.ts`, `boat-provider.ts`, `boat-setup-runner.ts` bind finite funded authority and inspect/resume/fork the exact allocation. | API request, provider-running observation, restoration and protected-base readiness. |
| Preparation | `sandbox/setup-cloud-workspace.mjs`, `setup-resume.ts` choose validated reuse or full preparation. | Hydration, installer/tree verification, preflight, checkout/settings/hooks. |
| Fresh launch | `sandbox/attest-cloud-worker.mjs` and protected supervisor verify current tree/containment, mint/consume proof and start an exact engine. | Final attester stages, supervisor/namespace/cgroup and process spawn. |
| Required engine state | `zeros-engine.ts` completes startup ownership recovery, lifecycle handlers, registration and initial durable sync before ready; optional cloud Design capture starts afterward. | Process entry, SQLite/schema, ownership recovery, registration HTTP and durable sync separately. |
| Ready observation | Setup helper retries at 125 ms within the existing 90-second budget, including remaining-budget request cancellation. | Probe/request overhead; exact instance/protocol/health/durable proof still required. |
| Client attach | Actor admission and `ws-client.ts` CONNECTED-first correlated probe. | Admission, scheduling, relay/provider hops, consume and initial replay. |
| Transcript paint | Renderer latency spans and bounded durable initial-window cache. | Signed Mac disk/IPC/frame timing, confirmed replacement and first agent text. |

Abbreviations in the table: renderer=`apps/desktop/src/renderer/`,
CP=`apps/control-plane/src/cloud-workspaces/`, sandbox=
`scripts/cloud-workspace-validation/sandbox/`. A large checkout's required
ownership repair is part of readiness and cannot be deferred as optional work.

## Preparation reuse and fresh authority

`CLOUD_WORKSPACE_RESUME_EXISTING_ENABLED` defaults true only when
`RAILWAY_ENVIRONMENT_NAME` resolves to Alpha. Explicit false disables it;
enabling it elsewhere is rejected. The rollout admits live staff accounts and
the exact configured Alpha zeros-dev account plus organization. The canary is
deliberately non-staff and still needs ordinary Pro admission; the exception
grants no staff authority and admits no other non-staff account or organization.
Move the general rollout to per-organization flags when that control-plane
rollout mechanism lands. Materials still require Boat, a qualified v4 pin and
negotiated `X-Zeros-Resume-Existing: 1`. Old material
negotiation uses full preparation. Code default is not proof of a deployed value.

The preparation key binds organization/workspace/generation/account, provider/
allocation, runtime/manifest/base/profile/protocol, image/resources, settings/
repository/spec and saved Computer config/build/environment. Ephemeral launch
witnesses and replaced compute-lease IDs are excluded. Under the lifecycle/setup
locks, `readCloudRuntimeResumeProofEpoch` selects the last completed exact
engine enrollment; incomplete or uncertain enrollment invalidates reuse. Check
identity/authority again after external credential minting.

A protected, bounded mode-0600 completion record, completed repository journal,
unchanged managed-settings bytes and physical checkout identity must agree.
A hit skips repository preparation/hooks and duplicate preflight. It preserves
owner commits, HEAD/index/dirty Code, Design, engine SQLite and conversation
state. Missing/corrupt/unsafe/mismatched evidence selects full preparation
without deleting user data or resetting history.

Every launch still verifies template/runtime and the **full final attestation**,
including restored-tree integrity and functional containment qualification.
It obtains fresh host/supervisor session, namespace/cgroup identity, engine UUID,
one-use launch/registration capabilities, proof consumption, registration and
initial durable sync. Old grants/proofs/tokens are never reused. Runtime changes
remain the existing generation-transition owner's decision; ordinary wake
cannot silently select today's template or change immutable pins.

A matching digest string, metadata timestamp or provider ID does not authenticate
restored bytes. Future qualification caching needs exact signed/root-controlled
artifact/base/profile evidence, revocation/expiry and tested invalidation.
Preparation reuse is already implemented; qualification reuse remains a
[follow-up](warm-pool.md), not permission to skip launch confinement.

### Retained setup evidence

An authorized status read may opt into `setupEvidence=true`. It returns the
current generation, setup run/fence, runtime ID, queue/start/completion times,
and at most five claim receipts. Longer histories retain the first failed claim
and the latest four, with `truncated=true`. Each receipt can include bounded
stage clocks, the control-plane reuse decision, the helper's closed preparation
miss and last readiness probe, a closed startup failure, and engine-row creation
and registration timestamps. The evidence is observational; registration alone
does not establish readiness, and row creation does not establish process spawn.

Success and failure audits retain clocks before setup rows are purged. The
zeros-dev harness captures the opt-in document in its signed receipt before
deletion. Clocks keep their source and monotonic offsets; UTC correlates clocks
but does not synchronize them. Attester spans overlap their parent setup span
and must not be added to it. Old helpers keep the previous envelope; a new helper
emits version 5 only after `X-Zeros-Setup-Observations: 1` and timings have both
been acknowledged. Malformed optional telemetry is discarded without changing
the readiness predicate. Existing runtime pins need an ordinary qualified runtime
upgrade to gain the helper observations.

## Desktop and scheduler behavior

Pending create identity binds account/catalog epoch, organization and idempotency.
The server receipt binds the final key before confirmed catalog publication.
Failure/late receipts affect only their own placeholder. No provisional row
admits an engine/prompt; account retirement invalidates even an empty catalog.
Local create remains on its original path.

Wake/restart can settle from current ready catalog events even during a hung
refresh. Account, target generation, operation version and Stop guards remain
unconditional. Restart fixtures cover source-generation replies arriving after
ready target publication; widening timeouts is not the production behavior.

Workers read durable eligible retry/lease deadlines before claiming and after
each pass. An empty queue incurs one read and no claim transaction. Already-due
or locked work is debounced by 100 ms. Migration 0143 adds empty, commit-bound
notifications for newly scheduled work, including future deadlines; rollbacks
emit nothing. LISTEN reconnects rescan every registered queue, and a hint that
arrives during a drain remains pending. Original claim locks, due dates, owner
and generation fences, and prerequisites still decide execution.

The default fallback is jittered between 30 and 60 seconds. Outbox, access,
invitation and security/directory publication, forks, checkpoints, setup and
restore incidents, deletion/retention, historical retirement and Computer builds
use the shared scheduler. Runtime staging also retains its shorter retry
deadlines. Lifecycle scheduling keeps separate health, funding and paid-authority
deadlines; a quiet fallback does not extend an engine lease, funded deadline or
the current stop policy. Provider drift and orphan inventory are maintenance
work. Local Personal and organization-local Host execution are unchanged.

Runtime-image retirement and object rotation/garbage collection use a separate
maintenance cadence: one startup pass, then a jittered 150–300-second sweep.
Runtime registry and Computer-builder completion hints wake image maintenance
sooner through the existing shared listener. A lost hint still has the bounded
sweep fallback. These sweeps do not replace the 30–60-second queue fallback.
Image passes inspect at most 18 ready candidates, keep the two newest usable
images and attempt at most 16 eligible named-snapshot removals. A cursor advances
past unconfirmed removals so one failing name cannot starve the following page;
account, channel, wallet and recorded-builder fences still govern every action.
Presence checks reuse the kept-image inventory instead of querying it again.

A full image page or object batch continues after 100 ms, with at most four
passes in an automatic burst. The burst limit also applies when failed garbage
collection keeps returning an attempted item. Object reference-count repair
still precedes every collection pass; object retention, restore windows, holds,
lease checks and explicit workspace deletion keep their existing authority.
Shutdown drains the active pass and drops pending continuations. Sweep discovery
may wait up to five minutes, including discovery of expired maintenance leases;
interactive lifecycle claims and funded/engine deadlines are unchanged.

Account maintenance uses one shared deadline read for WorkOS commands, security
mail and account/organization deletion. Migration 0144 adds empty commit-bound
wakes, including future retries, organization provisioning and completion of
ordered predecessors. Each queue retains its own in-flight work and existing
batch cadence, so a slow provider command cannot block security mail or deletion.
The Events API repair sweep retains its 60-second cadence. These account paths
serve Local and cloud users even when cloud workspaces are disabled; deletion
still waits for its existing controlled-migration boundary.

Notifications are hints, not a durable queue or an authority grant. Missing
hints or a failed deadline read retry within the fallback. A healthy notification
path targets claim p99 below one second; an outage uses the bounded fallback.
In-flight commands are not preempted. Fake-clock and local Postgres tests
verify these mechanisms; Alpha's quiet ≤0.5 tx/s and claim percentile require a
deployed measurement with the worker replica count recorded.

For rollback, `WORKER_POLL_INTERVALS_MS` accepts a JSON map of explicit fallback
intervals, for example `{"outbox":5000,"setup":1000}`. Keys are `outbox`, `access`,
`invitations`, `security`, `setup` (including recovery), `forks`, `checkpoints`,
`lifecycle`, `operations`, `retirement`, `templates`, `runtimeStaging`,
`runtimeImages`, `objects` and
`workos` (the shared account-queue fallback).
An override disables jitter for that worker; deadlines and notifications still
wake sooner. Remove a key to restore its default. Explicit legacy
`CLOUD_WORKSPACE_RECONCILE_INTERVAL_MS` and `CLOUD_WORKSPACE_SETUP_INTERVAL_MS`
settings remain honored; remove those short-interval overrides when enabling
quiet scheduling. The per-worker map takes precedence. Invalid keys/intervals
fail configuration without reflecting values.

Deploy the additive migration before the compatible control plane. Older
replicas ignore the new hints and keep polling, so code rollback does not
require dropping triggers or cancelling queued work. Security/directory
publication and its dedicated listener remain active when cloud workers are
disabled. Reassess temporary short-interval overrides after the Alpha soak;
do not use the global worker pause as a scheduling rollback for running VMs.

## Bounded setup execution

`CLOUD_WORKSPACE_SETUP_CONCURRENCY` limits setup executions on each control-plane
process. It defaults to **2**, accepts integers from **1 to 8**, and can be set to
1 to restore serial execution. Total capacity also depends on the worker replica
count. This setting does not raise compute credits or change managed-wallet
admission; setup uses the already admitted workspace resource.

Claims remain short transactions in workspace → setup-run lock order. Provider
commands run outside those transactions, with independent heartbeats, timeouts
and execution fences. A workspace with a live setup lease cannot start another
attempt, even on a different replica. The same process also excludes its still
executing workspaces until their fenced result handling finishes. Candidate
ordering favors organizations with fewer live setup leases, then the oldest due
work; it is a fairness preference, not a separate organization quota.

Completing an execution wakes the scheduler to refill its slot. Notifications can
fill a spare slot during another execution. A full pool skips queue reads and
claims until capacity returns, while the existing quiet fallback remains armed.
Retry dates and other replicas' lease expiries still determine the next eligible
claim. Shutdown aborts all owned executions, waits for current claim/result
handling, and prevents a late claim from starting a provider command. Fresh
admission, runtime qualification and readiness publication remain mandatory for
every execution. Local workspace setup uses its existing path.

## Closed setup clocks

Migration 0135 adds nullable `stage_timings` on setup runs. The negotiated version 1
document is capped at 8 KiB, five unique clocks and 32 spans. Sources are
`control_plane`, `boat_transport`, `setup`, `attester_preflight` and
`attester_launch`; stages/outcomes are closed enums. Each clock has UUID/UTC
anchor and monotonic offsets bounded to one hour. No raw stdout, paths, provider
messages, repository names or credentials belong in it.

Publish through existing fenced result/progress transport, not one HTTP request
per stage. Current execution fence prevents stale overwrite. Missing/bad timing
cannot make verification pass or block safety Stop. Failed/cancelled spans remain
explicit. Final successful clocks are available in current code; the historical
runs lack them. They do not independently isolate Node/SQLite/registration HTTP.
Never subtract timestamps from independent machine clock epochs.

## Unmatched VM probes

Earlier disposable cold-fork probes observed provider running in 2.860–5.017
seconds and protected base readiness in 36.723–43.555 seconds. All failed later,
so none proves usable create or true stopped-wake performance. One VM's boot
oneshot took 5.662079 seconds, including about 4 seconds of hydration; host start
followed 9.895 ms later. Those are same-VM intervals. A missing operator bracket
prevents an exact restore→unit offset; preceding delay is still unproven.

An early probe discarded rejection reasons and produced excessive retries.
A later probe incorrectly treated base-ready as installed-runtime-ready, then
failed because the pinned Node path did not exist. The revised runner invokes
the same protected installer on the disposable child before Node, records that
interval separately and retains allowlisted diagnostics. No successful follow-up
or attester timing was supplied. Compute cleanup was observed; storage upload/
erasure receipts remained pending and must remain in the private cleanup ledger.

Current probe attribution brackets allowlisted systemd observations with
operator request start/end, then translates same-VM monotonic differences to
intervals. `firstUnitStartFromCycleMs` is the earliest observed allowlisted unit,
not provider boot time. Provider-running is an observation, not hypervisor start.
Critical-chain/blame retain systemd semantics; early negative intervals are not
clamped into fresh restore work. Missing evidence stays missing. Raw journals,
argv/environments and unknown unit details do not leave the VM.

## Follow-up order and acceptance

1. Collect stopped-wake/fresh-create traces on the exact adopted runtime, with
   separate first/reclaimed claims, closed stages and Mac paint/first text.
2. Optimize the measured dominant stage. Keep hydration/persistent-bind and
   restored-tree barriers. Hydration training requires a separately authorized
   disposable template copy and a newly qualified template/base.
3. If restore dominates cold create, evaluate the bounded accounted
   [warm pool](warm-pool.md). An unassigned prebooted slot cannot represent a
   stopped user's mutable filesystem. Still-running retention has an explicit
   compute cost and is a reattach metric, not stopped wake.
4. Measure registration/attach/relay round trips before replacing transport.
   VM outbox, multiplexed device stream, Mac send ACKs and incremental durable
   feed are separate reliability/latency slices in that same follow-up guide.

Regression/qualification must preserve dirty Code/Design/chats, owner commits,
failed-hook retry and all identity/mount/settings invalidations; obtain fresh
proofs on hits, fallbacks, target and rollback; fence concurrent wakes and Stop;
and retain Personal Local, org-Local, denied roles, second device and A→B→A.
Linux fake clocks/storage fixtures prove behavior, not a live latency budget or
signed Mac continuity. No pool is enabled and neither usable endpoint is met
by the current evidence.
