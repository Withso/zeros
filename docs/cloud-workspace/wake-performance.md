# Cloud wake and create performance (Alpha)

Owner targets: wake a stopped workspace to usable in **1–2 seconds**, and
create a workspace from an existing Cloud Computer template in **3–4 seconds**.
“Usable” requires authenticated actor admission, the bridge connection, the
CONNECTED-first handshake and a successful correlated `workspace.list` probe.
A provider `ready` state, engine health response, or WebSocket upgrade alone
does not establish usability. Desktop paint is a separate, additional endpoint.

## Evidence and current limits

Audit date: 2026-10-06. Code baseline: `0600b6f5` (main before PERF's worker
notification change). PERF has no `.env.agent`; the orchestrator supplied a
closed read-only Alpha timeline for workspace
`c5f68576-41cb-4d1a-af6f-60b07f42e5fe`. Five completed setups took 116.422,
128.850, 133.063, 130.325 and 130.399 seconds (median 130.325 s); a sixth was
cancelled after 112.935 s. Setup repeats on wake. Queue-to-start was only
0.372–1.202 s. This makes **avoiding repeated full setup the primary lever**;
notifications alone cannot meet the goal. No matched after-run or complete
client-to-paint measurement is available. Provider claims and configured timers
remain separate from those historical measurements.

The repeatable [measurement runbook](../../scripts/cloud-workspace-validation/workspace-perf.md)
provides a read-only historical timeline, a disposable real workspace
create/stop/wake/attach cycle, and a separate isolated VM fork/resume probe.
Run the same harness against the baseline and changed Alpha deployment; the
`before`/`after` argument labels a result and does not deploy anything.

| Stage | Evidence in today's code | Available timing / limitation |
| --- | --- | --- |
| Client wake status | `apps/desktop/src/renderer/state/cloud-workspace-wake.ts:74` polls at 1,000 ms | Configured polling interval; real desktop visibility not measured |
| Lifecycle handoff | `apps/control-plane/src/config.ts:447` defaults to 5,000 ms; `reconciler.ts:326` serially drains maintenance and lifecycle batches | An idle polling worker can add up to one interval, plus work already running. Historical `created_at → dispatched_at` measures first dispatch, including all queue delays |
| Paid authority / compute leases | `reconciler.ts:330` and `compute-leases.ts` run maintenance and fenced allocation | No separate persisted duration. Serial maintenance can delay the lifecycle batch; a notification-only pass avoids extra maintenance |
| Provider create/fork/resume/inspect | `boat-client.ts`, `boat-provider.ts`, `compute-leases.ts` | Isolated VM script records API round-trip aggregates. DB create-attempt `dispatched_at` is not an API completion timestamp |
| Provider restore / base readiness | `boat-setup-runner.ts` checks the v4 base before installing setup | VM script separately observes provider readiness and a valid root bootstrap status. These include polling and command overhead, not hypervisor boot time |
| Setup handoff | `config.ts:535` defaults to 1,000 ms; `setup-worker.ts` requires due work and a running binding | `setup.created_at → started_at` includes prerequisite waits and first claim. Not a pure worker timer measurement |
| Tree and containment verification | `scripts/cloud-workspace-validation/sandbox/attest-cloud-worker.mjs:970` performs `verify_tree`, `qualify_engine`, `run_setup`, `publish_proof` in order | Existing isolated probe reports each duration and failure code; production setup timings are not persisted per attester stage |
| Checkout / settings / start | `sandbox/setup-cloud-workspace.mjs:2685` redeems materials, verifies, prepares repository, verifies again, starts the engine | Isolated probe has later-stage timings, but uses diagnostic material and is not a production authorization or checkout benchmark |
| Node / SQLite / containment | `apps/desktop/src/engine/zeros-engine.ts` initializes engine services before readiness | No independent persisted timings. Do not subtract overlapping spans to invent these costs |
| Engine registration / heartbeat | `zeros-engine.ts:3099` awaits initial durable registration; `cloud-runtime-registration.ts` schedules subsequent heartbeats | Engine row creation to registration is available, but starts before process startup. `last_heartbeat_at` is not the first heartbeat |
| Engine readiness observation | `sandbox/setup-cloud-workspace.mjs:2605` sleeps 500 ms between probes | Up to one probe interval plus request overhead; the 90-second deadline is not a measured duration |
| Actor admission / bridge / handshake | `apps/desktop/src/renderer/platform/bridge/ws-client.ts` implements #330's CONNECTED-first probe | Real workspace script records admission HTTP, bridge upgrade and correlated probe separately; DB actor creation to consumption is also available |
| Renderer warmups / visible transcript | `renderer/state/cloud-workspace-latency.ts:18` records `intent_history_visible`, `click_transcript_paint`, `submit_first_text` | Chat/history spans end after two animation frames when visible/hydrated. They are not complete workspace create/wake spans; verify on the Mac |

Paths abbreviated after their first full prefix refer to the same subsystem.
Lifecycle dispatch-to-completion spans include retries, backoff and later
observations. Setup and registration intervals overlap: do not add these rows.
Historical queries return at most 32 records per table and never read credential
columns, command output, setup logs or repository contents.

### Baseline / after ledger

| Endpoint | Before | After notification change | Interpretation |
| --- | --- | --- | --- |
| Real create → CONNECTED probe | Not measured | Not measured | Target 3–4 s; includes operator ownership read, explicitly timed |
| Real wake → CONNECTED probe | Not measured | Not measured | Target 1–2 s; renderer paint still additional |
| Lifecycle queue → first dispatch | Stop example: 6.166 s; no-op wakes excluded | Not measured | Notification change addresses initial and committed prerequisite handoffs |
| Setup queue → first claim | 0.372–1.202 s | Not measured | Orchestrator-supplied historical Alpha timeline |
| Setup execution | Completed: 116.422–133.063 s, median 130.325 s (n=5); cancelled: 112.935 s | Not measured | Dominant observed cost; not a complete wake endpoint |
| Engine row creation → registration | Approximately 17–23 s | Not measured | Includes prelaunch/startup; not pure registration HTTP time |
| Actor creation → consumption | 2.718–3.447 s, median 2.999 s (five examples) | Not measured | Includes client scheduling/bridge; not complete CONNECTED probe or paint |
| Boat fork / resume → observed base ready | Not measured | Not measured | Separate isolated VM experiment, not a real workspace endpoint |
| Attester / containment / checkout / engine sub-stages | Not measured | Not measured | Successful production stage spans are not persisted; failure observations are available |
| Polling scheduler regression | Next periodic tick | Immediate scheduled pass | Deterministic fake-clock regression, **not live latency** |

Record run IDs, resource IDs, exact runtime/base/template build, control-plane
commit, client version and region, elapsed totals, failures and cleanup status
with each result. Compare matched configurations. Start with one before/after
run; repeated samples require a deliberate resource budget. Never report a p95
from a single run or quietly discard a failure/timeout.

The orchestrator's isolated VM run using this workspace and `bx_dxzfh3p6`
(current organization template, build prefix `d60cde4b`) failed before allocation:
`verification_failed`, `childId: null`, `cleanup: not_created`. A stopped source
workspace is permitted. The source reader requires the generation's pinned
template, qualified source row, matching image reference and protected digest;
the organization's current template alone is insufficient. A pin/source mismatch
is a hypothesis until the runbook's new read-only `--inspect-source` reports its
closed checks. No new VM was created by that failed run.

The [resume proposal](resume-performance-design.md) prioritizes preparation reuse,
fresh launch authority, integrity-bound qualification reuse, engine startup,
registration/attachment measurement, and closed persisted stage spans for RU/HU
coordination. It does not remove any verification in the current implementation.

## Boat capabilities relevant to the budget

The public [snapshot documentation](https://docs.boat.dev/snapshots) describes
filesystem snapshots, not process or memory capture. Resume reconstructs the
same sandbox on fresh hardware; fork creates an independent sandbox. The
provider describes restoration in a few seconds, not a 1–2-second guarantee.
Enabled services restart, but restore is not a fresh kernel boot; the v4 base
must respect the overlay/start ordering already established by the Alpha audit.

Files hydrate on demand while background downloads continue. Boat's documented
startup playbook (`.ascii/playbook.json`) prioritizes previously opened paths,
up to 5,000. Training requires startup immediately after restoring a snapshot,
then saving after hydration completes. This suggests a controlled experiment
using the actual bootstrap/attester/engine read order, preserving all checks.
See [warming instructions](https://docs.boat.dev/snapshots#warming-for-faster-first-boots).

The [platform guide](https://docs.boat.dev/platform-guide) recommends prepared
template forks and a restarted service/daemon. Zeros already forks Cloud
Computer templates. No public memory-suspend or managed warm-pool API was
identified in the reviewed snapshot, lifecycle and platform guides; that is a
research limitation, not proof that Boat cannot offer one privately. Ask Boat
for measured p50/p95 fork/resume and placement guarantees before budgeting them.

The [FAQ](https://docs.boat.dev/faq) places compute in Germany, Finland and France
and estimates US round trips at 100–200 ms. Those are vendor estimates, not
Alpha measurements. No placement selector was identified in the reviewed
lifecycle docs. Serial control-plane/provider/VM requests may consume much of
the wake budget; measure where Alpha actually runs before changing placement.

[Webhooks](https://docs.boat.dev/webhooks) include ready, archived, error and
hydrated events. Hydrated can arrive substantially later than ready. Delivery
can be repeated or reordered; authentication and current binding checks are
required before treating an event as an observation hint. Provider inspection
and existing state fences remain authoritative. This could remove future
provider polling delay but is a separate integration, with no webhook created
by PERF.

The [API guide](https://docs.boat.dev/api-v1) documents 24-hour, account-scoped
idempotency for create/fork. This matters for both measurement cleanup and any
future pool allocator: a lost response must not allocate a second VM. The
[long-running task guide](https://docs.boat.dev/long-running-tasks) provides
`ttlSeconds` at fork/resume. The isolated probe uses 30 minutes and one child.
Deletion can release compute before storage uploads finish; retain the receipt
and report the distinction rather than retrying fresh allocations.

## Safe implementation sequence

1. **Committed-work notifications (PR #356).** Payload-free PostgreSQL triggers
   wake lifecycle/setup workers through one dedicated session per replica.
   Hints coalesce and survive an active tick; due-date polling stays enabled.
   Existing claims, locks, lease fences, authorization and operation decisions
   decide what runs. Notification passes do not repeat periodic maintenance.
   Security cost: unchanged. Operational cost: one connection per replica and
   small transaction notification overhead. This removes avoidable handoff
   waiting, not provider/verification time. Migration 0134 is assigned by the
   orchestrator; reserved predecessors must land before the sequence check is
   green.
2. **Prioritize the resume proposal using the live baseline.** Full setup takes
   about two minutes on every observed wake. Preserve existing checkout and
   preparation on eligible same-generation resumes, with fresh authority and
   integrity checks; coordinate the hook with RU/HU. Persist closed stage spans
   to identify the expensive substeps before changing their guarantees. A
   future `next_attempt_at` becoming due
   emits no PostgreSQL notification: provider observations and error backoff
   can still wait for polling. A bounded due-time scheduler or verified Boat
   webhook hint is a next scheduling candidate; preserve retry deadlines and
   RU/HU's decision semantics.
3. **Train template hydration on a disposable copy.** If verification reads
   dominate, train the supported startup playbook with real startup, wait for
   full hydration, then compare new forks. Do not mutate the owner's template
   or skip hash reads. Shipping a different base/template remains a separate
   orchestrator-controlled change.
4. **Consider a bounded pool only if measured provider restore dominates.**
   Proposed Alpha-only default is disabled, at most one unassigned VM per
   approved template and a global hard cap. A design must pin runtime, base,
   template and organization, atomically claim once, admit no user secrets
   before assignment, obtain fresh workspace/engine proofs after assignment,
   count idle compute against an explicit shared staff budget, expire and
   delete unused VMs, and drain on template/runtime change. Warm cost is
   `pool size × live hourly rate × hours`, even with zero workspace demand.
   No pool/migration/provider allocation is added by this change. A pool cannot
   reuse a stopped user's mutable filesystem as a generic fork.
5. **Optimize verified startup only with the responsible owners.** Immutable
   image identity may support reusing measured artifact information in a
   root-controlled cache; a matching digest string alone is insufficient.
   v4 proofs bind current boot, supervisor session, tree, mount/containment and
   launch identity. Fresh runtime checks and proof consumption remain required
   across restore. User-writable cache state, old launch proofs, or old actor
   tokens must never replace them. Parallelize only independent preparation,
   then keep a verification barrier before material release and engine start.
   HU owns in-place update and RU owns runtime selection on wake.
6. **Client intent work belongs with IW2.** Early account/device and status
   preparation may overlap wake. Actor admission still needs the exact current
   generation and ready engine; passive hover/read must not become an implicit
   compute authorization. Retain #330's CONNECTED-first replay order and exact
   owner/workspace/generation keys.

Neither target is established by the current evidence. The before baseline
establishes a dominant setup cost; after measurements remain necessary. True stopped-to-usable
in 1–2 seconds may require a different provider capability or a deliberate
keep-running policy; keeping a VM warm has a cost and does not count as a
measured stopped-VM wake. Escalate that tradeoff with numbers, not an altered
definition of “ready.”

## Local workspace impact

Personal Local and organization-owned local workspaces do not use these
cloud workers or Alpha measurement scripts. No local engine, permissions,
filesystem, owner selection or renderer behavior changes.

## Cloud workspace impact

Notifications carry no workspace identity or authority. Cloud execution keeps
organization/workspace/generation claim fences and all attestation/admission
checks. Measurement mutations use a designated staff test principal and a
new `zeros-v2-test-perf-*` workspace/VM only. Historical reads may inspect an
explicitly selected Alpha workspace; they never mutate it. Owner switching,
concurrent clients and agent continuity still need the Mac verification in
the runbook.
