# Resume without repeating full setup (Alpha proposal)

Status: first same-generation preparation reuse implementation, disabled by
default. PERF's scheduler and measurement changes do not alter resume authority. Live evidence supplied by
the orchestrator on 2026-10-06 makes this the highest-priority next work.
This proposal follows HU's merged [in-place update design](runtime-hot-update.md):
RU remains the single transition owner, and changing the runtime requires a
new immutable generation even when HU retains the allocation.

## Observed bottleneck

Read-only timeline of workspace `c5f68576-41cb-4d1a-af6f-60b07f42e5fe`:

| Observation | Value | What it establishes |
| --- | --- | --- |
| Five completed setup executions | 116.422 / 128.850 / 133.063 / 130.325 / 130.399 s | Median 130.325 s; setup repeats on stopped-workspace wakes |
| One cancelled setup | 112.935 s | Incomplete sample; exclude from successful-latency statistics |
| Setup queue to first claim | 0.372–1.202 s | Queueing is a small fraction of the dominant setup execution |
| Engine row creation to registration | Approximately 17–23 s | Includes prelaunch work and process startup; **not** registration HTTP latency |
| Actor row creation to consumption, five examples | 3.447 / 2.966 / 2.718 / 3.230 / 2.999 s | Median 2.999 s; includes client dispatch and bridge/engine work, not renderer paint |
| Stop queue / dispatch-to-completion example | 6.166 s / approximately 8.6 s | Polling is visible, but cannot explain two-minute setup |
| No-op wakes | Several have zero attempts and complete at creation | Exclude already-running requests from stopped-wake measurements |

The user-visible 2–2.5 minute wake is the orchestrator's interpretation of the
timeline; no complete click-to-paint trace has been collected. Boat API, restore,
hydration, attester substage, Node/SQLite and first-heartbeat timings remain
unmeasured. Scheduler notifications alone cannot meet the target.

Code explains the repetition: a running provider result enters `setting_up`
(`reconciler.ts:176`); the setup worker claims a new fenced attempt. The v4
helper invokes full attestation both before repository preparation and again
before launch (`scripts/cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs:2726`
and `:2738`). Each attestation runs tree verification, containment qualification,
setup-process qualification and proof publication (`attest-cloud-worker.mjs:970`).
This is evidence of repeated work, not evidence of which substage costs most.

## Proposed ownership and decision boundary

RU retains the decision about **which generation/runtime a wake starts**.
After that decision, a narrowly typed launch plan chooses one of:

- `resume_existing`: same workspace, generation, provider resource and runtime;
  a previous successful setup exists and all resume eligibility checks pass.
- `prepare_generation`: new workspace, recovery, changed setup
  contract, missing proof, or a migration that requires preparation.
- `update_then_resume`: HU's authorized in-place update completes and provides
  a new immutable candidate generation and verified runtime identity, then
  applies the same fresh-launch checks and HU's atomic authority transfer.

These are proposed internal plan names, not new API states or enum migrations.
Keep released workspace statuses, setup-run identities and actor protocol
compatible. A new fenced execution record can still use the existing setup-run
ledger while recording `resume` rather than running the full preparation path.
The existing success/readiness publication must remain authoritative.
For HU, use its transition-scoped enrollment and attestation rather than inventing
an ordinary setup run. Reuse preparation across its new generation only through
RU's validated provenance copy and the exact HU allocation-transfer fence. A new
generation with no such authorized provenance takes normal preparation/recovery.

The orchestrator assigned PERF the timing transport/persistence and same-generation
resume path on 2026-10-06. RU owns runtime selection; its wake implementation
must land before the resume change ships. HU owns runtime transitions and the
shared proof-cache invalidation interface. The implementation uses HU's `readCloudRuntimeResumeProofEpoch` under the workspace
lifecycle lock before enrolling the fresh engine. The completed engine UUID
invalidates preparation evidence after any new or uncertain enrollment.
Fresh launch proofs and full restored-tree integrity checks remain mandatory.

## Resume eligibility and fresh authority

Eligibility must be checked after the current wake/runtime selection and again
under the existing execution fence before publishing ready. Pin this tuple:
organization, workspace, generation, provider resource/allocation, runtime ID,
manifest digest, base compatibility, setup-contract version, Cloud Computer
template/config/build, settings version/digest, and previous successful setup
attestation. The provider binding and current spending/owner/organization
authority remain required; a previous setup record is not current permission.

Preserve the user's existing checkout, working tree, uncommitted changes, Design
files, engine SQLite and durable conversation records. Do not clone, reset,
rerun user setup hooks or restore an older checkpoint on a normal resume.
If the prepared-state contract changed, select the explicit preparation/update
path; do not silently claim an old preparation still matches new configuration.

Every launch still needs a **fresh** boot/host-session, namespace/cgroup,
engine-instance identity, short-lived registration capability, and consumed
single-use launch proof. Revoke/retire old actor and engine capabilities through
the existing stop/wake lifecycle. The proof must bind the current generation,
execution fence, selected runtime, installer receipt, host session, mount and
containment identity. No actor grant, registration token, heartbeat authority or
namespace-bound launch proof is reusable across resume.

Boat restores files and starts enabled services after the overlay; it does not
restore process memory. Do not wait for an early-boot service that already ran,
or treat its old success as proof that the new host session is ready. The root
bootstrap's fresh descriptor and active supervisor are required.

## Integrity-bound reuse

Separate three facts currently established together by full attestation:

| Fact | Candidate reuse | Required fresh evidence |
| --- | --- | --- |
| Immutable runtime bytes match a qualified artifact | Qualification of the exact artifact/base/profile can be retained in root-controlled or signed evidence | Verify the restored runtime's identity/integrity and read-only protection before using that evidence |
| Preparation completed for this workspace contract | Durable successful setup attestation and a protected completion record for the exact tuple | Current settings/config/runtime compatibility; expected data mounts and workspace identity; no rollback to stale content |
| This launch is confined and authorized | Never reuse an old launch proof | Fresh host session, mount namespace, cgroup resources, UID/GID maps, seccomp/no-new-privileges/capability policy, registration and proof consumption |

A digest string, unchanged file metadata, root-owned cache filename, or the
fact that the provider resource ID stayed the same does **not** prove restored
bytes unchanged. If the current platform cannot authenticate immutable runtime
content across filesystem restore, retain the required tree verification on
the resume path. A future verified immutable filesystem can move content checks
to demand reads, but requires its own qualified contract. No public Boat memory
snapshot or authenticated snapshot-content guarantee was established by PERF's
research.

Move exhaustive functional qualification to trusted runtime/base qualification
only if RU/HU and security review establish equivalent enforcement at launch.
The launcher must validate and enforce every current isolation property. A
cached “qualified” boolean must never replace actual namespace/containment
checks. Within one verified host session, remove duplicate identical expensive
qualification only behind an integrity-bound cache whose key includes all
inputs and whose invalidation is tested. Reusing repository preparation is a
separate optimization from reusing containment proof.

## Engine, registration and client work

Instrument before changing engine initialization. `zeros-engine.ts:3099`
awaits `cloudRuntimeRegistration.start()` after engine services start.
`cloud-runtime-registration.ts:449` posts registration immediately, then awaits
initial durable-record synchronization before declaring the connection ready.
There is no intentional first-heartbeat interval before that registration.

Target engine startup ≤1 s and registration ≤0.5 s separately, measuring process
spawn → entry, SQLite open/schema readiness, essential workspace initialization,
registration request → response, and initial durable synchronization. Defer
nonessential discovery/warmups only after establishing their effects are not
part of the authority/readiness contract. Do not publish `ready` before the
durable record and request handlers can serve the authenticated client.

For admission+connect ≤0.5 s, measure admission HTTP, client scheduling, bridge
upgrade, engine admission consumption and the correlated CONNECTED-first probe.
The supplied 2.7–3.4 s interval does not isolate any one of those. IW2 may prepare
device/account and route state during an authorized wake, but must wait for the
selected ready engine before minting an actor token. #330's handshake/replay
order stays intact. A provider restore taking several seconds can still exceed
the total wake budget even after these subtargets are achieved; report that
constraint rather than measuring an already-running VM as a stopped wake.

## Closed persisted timing proposal

Current setup rows store only claim/completion times. Diagnostic incidents
retain failure observations, an optional `elapsedMs`, and a terminal installer
stage; they do not preserve successful stage spans. The helper's
`last-diagnostic.json` is overwritten per stage, so it cannot reconstruct them.

Proposed additive storage: a bounded nullable JSON timing document on each setup
execution (orchestrator-assigned migration **0136**, expand phase). No raw
stdout, paths, provider messages, repository names or credential fields.

- Version 1; maximum 32 entries / 8 KiB. A closed source enum identifies
  control plane, trusted bootstrap/helper or engine; a closed phase enum covers
  bootstrap, tree verification, containment/setup qualification, proof mint,
  checkout/preparation, engine spawn/start, registration and durable sync.
- Each entry has integer start/end offsets from one monotonic clock and bounded
  duration (0–3,600,000 ms), plus a closed outcome. One UTC anchor and a generated
  clock/session ID locate it; never subtract clocks across machines. Record
  repetitions so preflight and launch attestation remain distinguishable.
- Bind publication to organization/workspace/generation/setup-run and current
  execution fence; engine entries additionally bind the registered instance.
  Retired/stale executions cannot overwrite a new attempt's data.
- Negotiate optional timing support in setup material/protocol before adding
  fields to strict envelopes. Old workers/helpers remain valid and emit no
  timings; deploy the reader before a new pinned runtime emits them.
- Batch closed samples with existing authenticated result/progress transport;
  do not add one network round trip per timing stage. Missing/invalid timing
  data cannot make failed verification pass, hold a safety stop, or falsely
  mark a run ready. Partial failed/cancelled spans remain identifiable.

PERF has scoped ownership of helper/runner/result-schema/persistence hooks and
assigned migration 0136 for this storage. The read-only timeline
can then project successful spans alongside the existing failure observations.

## Required regression and rollout checks

Before enabling a resume path, prove: same-generation wake preserves dirty
files, Design and conversation state; setup hooks do not run again; artifact,
base, template, settings, mount, owner/entitlement or execution-fence changes
reject reuse; old boot/session proofs and actor/engine tokens fail; concurrent
wakes start one engine; failed/cancelled resume cannot publish ready; RU upgrade
and HU update keep their selected runtime and rollback rules; missing/corrupt
cache falls back safely without deleting user data. Verify Local, organization
local, cloud, owner switching, a second authorized device and denied roles.

Roll out disabled by default on Alpha staff test resources, preserving the
current full-setup fallback. Record separate normal resume, upgrade/update and
fallback samples, including failures. Obtain a real stopped-workspace before/
after trace and owner-verified paint/agent continuity before claiming either
target. No keep-running pool is enabled by this proposal.

## First implementation: preparation reuse only

Set `CLOUD_WORKSPACE_RESUME_EXISTING_ENABLED=true` only on the Alpha control
plane after its reader is deployed and a new qualified runtime contains the
helper. Code defaults to false and rejects enabling the flag on other channels.
The server additionally requires engineering staff, Boat, and a v4 runtime.
New helpers negotiate `X-Zeros-Resume-Existing: 1`; old helpers get unchanged
materials. New helpers talking to an older control plane take full setup.

Under the existing live workspace/setup-run locks, before inserting a new engine,
`setup-resume.ts` reads HU's completed enrollment epoch. The preparation key
hashes the exact organization/workspace/generation, account, provider/resource,
runtime/manifest/base/profile/protocol, image/resources, settings/spec/repository,
and Cloud Computer source/config/build/environment tuple. It excludes ephemeral
launch witnesses and changing compute-lease IDs: stop/resume replaces those.
The key and staff gate are checked again after external credential minting.
No previous capability, admission, registration or containment proof is reused.

After full launch/readiness the root helper writes a bounded mode-0600 completion
record keyed by that tuple and the freshly enrolled engine. A later resume
requires HU to report that engine's successful setup/attestation, plus the exact
protected completion record, completed repository journal, unchanged managed
settings bytes and the existing physical checkout identity. Owner-created commits,
dirty files, Design source and SQLite remain in place. Cache loss, corruption,
key changes or incomplete setup select the existing preparation path; no cache
fallback deletes data or resets history. Untrusted filesystem aliases are not
accepted as a prepared checkout.

Every execution still prepares a fresh supervisor session and workspace admission,
verifies the Cloud Computer template, projects current credentials, runs the
**full final attestation** (including restored-tree integrity and functional
qualification), consumes a fresh launch proof, and waits for fresh registration
and engine readiness. The existing worker checks authority, allocation, runtime,
lease, run and execution fence before publishing ready. A cache hit skips only
repository preparation and the duplicate preflight attestation. This first slice
does not cache functional qualification or claim the 1–2-second target.

### Regression and rollout evidence

- Material integration tests cover negotiation/default-off, completed epochs,
  changed allocations (including during credential mint), concurrent redemption,
  new engine/registration/bridge credentials, revoked membership/entitlement,
  obsolete fences and stop cancellation. HU's epoch suite covers new/failed
  enrollment, exact pins, generation/tenant isolation and RU/HU transitions.
- Persistence tests preserve edited files, Design and conversation bytes and
  owner-created commits across cache hits and full-setup fallback. They reject
  failed journals, changed managed settings, unsafe checkout aliases, a different
  preparation key, a different epoch, a missing/corrupt cache and legacy profiles.
- Launch tests require full final attestation and fresh launch/readiness on a
  cache hit, do not rerun repository/hooks, and do not save completion after a
  failed attestation, launch or readiness. Existing attester/launch-proof suites
  retain changed-tree/base/mount, stale boot/session and one-use proof rejection.
- Local-owner and organization-local workspaces use no modified path. Existing
  legacy cloud request/launch coverage stays intact; runtime selection, upgrades,
  transitions, rollback, actor admission and client transport are unchanged.

The orchestrator enables the flag after merge and observes a full preparation to
seed the new helper's record, then a real stop/wake using the same exact runtime.
Use the passive timeline for elapsed/setup-stage data. The owner verifies dirty
files, Design and conversation continuity, a real agent turn, a second authorized
device, denied roles, Local/org-local workspaces and switching between owners and
placements on the Mac. Revoke the flag to return to full preparation. No live
wake, client paint, second-device or macOS claim is made from Linux test fixtures.
