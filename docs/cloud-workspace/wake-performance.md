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

No matched after-run, full intent→paint trace or successful live performance
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
enabling it elsewhere is rejected. Materials still require a live staff account,
Boat, qualified v4 pin and negotiated `X-Zeros-Resume-Existing: 1`. Old material
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

Workers read durable eligible retry/lease deadlines after each pass and debounce
already-due/locked work by 100 ms. Independent periodic maintenance remains at
its configured cadence; notification passes do not repeat maintenance. Original
claim locks, due dates, fences and prerequisites decide execution. No hint or a
failed deadline read falls back to scanning. Serial in-flight work is not
preempted; a newly committed deadline without a hint may await the fallback.

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
