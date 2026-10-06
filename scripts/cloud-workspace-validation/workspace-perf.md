# Alpha workspace performance measurement

These scripts are an **orchestrator-run** measurement runbook. They do not
deploy a branch, dispatch a workflow, install dependencies in Alpha, change
templates, or run an agent provider turn. Never use the owner's account for
the disposable workspace cycle. Do not mutate the owner's workspace,
credentials or delegations. See the [performance report](../../docs/cloud-workspace/wake-performance.md)
for the baseline, stage breakdown and follow-up decisions.

## Preparation

Run from the credential-holding repository workspace. Read `.env.agent` locally
only; never paste its contents or supply secrets in command arguments. It must
be a private regular file (mode 0600, not a symlink). Run `pnpm agent:check`
first. The scripts emit only enumerated states, validated IDs, timestamps,
durations and failure codes. They do not emit provider response bodies,
database URLs, account bearers, actor grants, SSH keys or setup output.

The following are **variable names**, not values to print:

| Script | Names required in `.env.agent` |
| --- | --- |
| Historical timeline | `ZEROS_PERF_ALPHA_DATABASE_URL`, `ZEROS_PLANETSCALE_ALPHA_DATABASE` |
| Disposable real workspace | The above plus `ZEROS_PERF_ALPHA_ACCESS_TOKEN`, `ZEROS_PERF_ALPHA_TEST_USER_ID`, `ZEROS_PERF_ALPHA_ORGANIZATION_ID`, `ZEROS_PERF_ALPHA_INSTALLATION_ID`, `ZEROS_PERF_ALPHA_REPOSITORY_OWNER`, `ZEROS_PERF_ALPHA_REPOSITORY_NAME`, `ZEROS_PERF_ALPHA_REVISION`, `ZEROS_PERF_ALPHA_EXPECTED_SHA`, `BOAT_API_KEY`, `BOAT_BILLING_ORG` |
| Isolated VM stages | Historical names plus `BOAT_API_KEY`, `BOAT_BILLING_ORG` |

Database name must be `zeros-control-plane-alpha` and the connection must use
a PlanetScale host. Supply a short-lived role limited to SELECT on the needed
tables; all script transactions also explicitly use READ ONLY and ROLLBACK.
The access token must belong to the specified **staff test user**, with access
to the test organization, its active qualified Cloud Computer template, the
selected repository and sufficient test compute allowance. `EXPECTED_SHA`
must be the selected commit; it may be omitted only when `REVISION` itself is
the full commit SHA. Never mint new credentials through chat.

Choose one matched before/after pair initially: same organization, repository
revision, template/base/runtime, resource shape and operator location. Record
the Alpha control-plane deployment commit and desktop version separately.
The real-workspace script can fail closed if the active template changes
during create. Further samples consume provider compute; bound their number
and review cleanup after each run.

## Read-only historical baseline

Substitute an explicitly authorized Alpha workspace UUID:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/workspace-perf-timeline.mjs --inspect WORKSPACE_UUID
```

This creates no resources. It reads selected nonsecret columns from workspaces,
lifecycle intents, setup runs, engine instances, actor sessions and provider
create attempts. It returns at most 32 rows in each history. The intervals
overlap, describe first dispatch/claim through final completion, and cannot
establish Boat API, boot, first-heartbeat or renderer durations. Missing values
stay null. If more history is needed, add a separately reviewed bounded query;
do not dump raw tables or Railway logs. The designated read-only role also needs
SELECT on `cloud_workspace_diagnostic_incidents`: the timeline projects at most
128 closed setup failure observations (phase, installer stage, observation times
and optional reported elapsed time). These are not successful stage start/end
records. `setupStageTimings.availability: not_persisted` states that limitation;
the VM's latest-stage diagnostic file cannot reconstruct overwritten history.
`noOpWakeCandidate` marks succeeded wake intents with zero worker attempts;
exclude those already-running candidates from stopped-wake measurements.

Without a staff test access token, use this read-only command after the owner
creates/wakes normally. Record the owner's actual action time and selected
workspace/generation separately. Do not mint or borrow an owner token, and do
not substitute no-op wake intents for real stopped resumes.

## Real create and wake through the control plane

```sh
pnpm exec tsx scripts/cloud-workspace-validation/workspace-perf-live.mjs --run before
```

After the orchestrator has deployed the intended change to Alpha through the
normal reviewed process, repeat with `--run after`. Labels do not alter state
or select a deployment.

The script verifies `/v1/me` matches the designated test principal, registers
one temporary device with an in-memory private key, and creates one named
workspace using the normal API. It checks the durable create idempotency key,
organization, owner, repository revision and template build before proceeding.
It waits for ready, obtains a generation-bound v2 actor admission, connects to
the fixed Alpha bridge, sends CONNECTED first and requires a correlated
`WORKSPACE_RESPONSE`. It closes/revokes that actor, names only the recorded
provider child, then stops and wakes the same disposable workspace and repeats
admission/attachment. Provider renaming is after the timed create interval;
if that step fails, cleanup still targets the durable create receipt.

Output includes separate API, ready-observation, admission, bridge-upgrade and
CONNECTED-probe samples plus two totals. Create's total explicitly includes
the operator's ownership read. Polls are 250 ms and wait for at most ten
minutes; request durations and journal fsync overhead also affect the total.
These are synthetic client measurements from the operator's machine, not Mac
renderer timings. The script uses real production authorization and bridge
checks, but starts no paid agent turn.

Cleanup always runs. It deletes only the workspace recovered from this run's
idempotency key and exact owner/org/name, permits discarding that disposable
workspace's uncheckpointed changes, and revokes only the temporary device
recovered from its registration key. It requires the deletion job and each
recorded provider operation to be closed; absence after an ambiguous API
response is not treated as proof of cleanup. It never mutates database rows.

Journals are private files in `.context/zeros-v2-test-perf/RUN_UUID.json`,
written before dispatch. They contain no reusable credentials. Preserve the
journal if interrupted or cleanup is pending, and retry the **same** run:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/workspace-perf-live.mjs --cleanup RUN_UUID
```

Do not run another `--run` to retry cleanup. A retry does not allocate a new
workspace/device. Record every workspace/device/provider ID, success/failure,
and final cleanup result in the orchestrator report. `pending` requires
follow-up; never report it as cleaned up.

## Isolated Boat restore and attester stages

First inspect source preconditions without allocating anything. The template
must be pinned to the source workspace's current generation; the organization's
current template may be a different build. A stopped source workspace is allowed.
This exact read-only invocation diagnoses the orchestrator's failed sample:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/workspace-perf-vm.mjs --inspect-source --workspace c5f68576-41cb-4d1a-af6f-60b07f42e5fe --template bx_dxzfh3p6
```

It reports closed source/build/template/repository/base checks, the pinned
template ID, qualified material validation and provider snapshot/wallet checks.
It performs read-only SQL and a provider GET. If
`requestedTemplateMatchesPin` is false, repeat inspection with the reported
`pinnedTemplateId`. If `source_present` is false, this older workspace cannot
supply the qualified template-backed source required by this probe; use a
separately authorized matching workspace or continue passive timeline collection.
Do not relax the source/qualification checks or modify the owner's source.

Then use the verified source/template pair:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/workspace-perf-vm.mjs --run before --workspace WORKSPACE_UUID --template bx_TEMPLATE
```

This wraps the existing qualified `template-setup-repro.mjs` boundary. It reads
immutable runtime/image/template material, inspects the source without changing
it, and forks exactly one disposable `zeros-v2-test-perf-*` child with no
inherited environment and a 30-minute TTL. It observes provider and root
bootstrap readiness, runs the existing isolated attester/setup diagnostic,
stops **the child**, waits for a completed snapshot, resumes the child with
the same TTL, and repeats the diagnostic before cleanup.

API aggregates report operation counts, failed calls, total and maximum
round-trip duration, split by create/stop/wake and diagnostic phase. The
provider/base ready observations include source inspection/naming on create,
poll/command overhead and journal writes; they are upper bounds on those
observed milestones, not hypervisor boot measurements. Attester stages report
`verify_tree`, `qualify_engine`, `run_setup`, `publish_proof`, and later stages
when reached. A failure remains a failed sample, not a faster startup.

This is deliberately an isolated probe. It does not measure production setup
admission, repository authorization, Node/SQLite internals, real registration,
relay/bridge connectivity or renderer paint. Do not substitute its total for
the real-workspace endpoint or claim that its engine-shaped diagnostic
establishes an authenticated usable workspace.

Journals are `.context/zeros-v2-test-perf-vm/RUN_UUID.json`. Resume cleanup with:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/workspace-perf-vm.mjs --cleanup RUN_UUID
```

An ambiguous fork is recovered with the same account/key/body only within
the existing helper's 23-hour recovery bound, shorter than Boat's documented
24-hour retention. Never invent a fresh fork key during cleanup. The child
must differ from the source and belong to the configured billing organization.
The source cannot be stopped, resumed, renamed or deleted through this wrapper.
Cleanup has a bounded ten-minute retry window, plus request overhead. Boat may
return a storage-only blocked deletion (including `waiting_for_uploads`); the
helper then also requires child 404 to prove compute release. `storagePending`
is reported separately and does **not** mean all snapshot bytes were erased.
Keep the deletion receipt/journal until the orchestrator verifies storage
completion; do not create another sandbox as a cleanup workaround.

## Owner's Mac verification

The owner performs actual agent turns on their Mac; these scripts have no
agent-provider credentials. For a permitted test workspace:

1. Record click/create intent, ready status, successful bridge probe and first
   useful visible content. Inspect the exact workspace/generation's existing
   `click_transcript_paint` / `intent_history_visible` spans; they do not begin
   at workspace create. Record `submit_first_text` separately for an explicitly
   authorized agent turn.
2. Verify Files/Git load, the connected model menu populates, and a real turn
   streams. Close the Mac interface during the turn, reopen on another signed-in
   device, and verify the same cloud work continues without duplicate execution.
3. Switch Local → organization local → cloud → another cloud workspace and
   back. Confirm no previous owner's transcript, model state, loading span,
   files or subscription leaks. Switching or passive reads must not create a
   compute lease or wake an unauthorized workspace.
4. Check a second authorized actor and a role without wake permission. Ensure
   another actor disconnecting does not stop the engine; denied wake remains
   denied. Do not revoke or change the owner's credentials/delegations for this
   check.
5. Record failures, IDs and cleanup alongside durations. Report create/wake
   and visible paint independently, with sample count and p50/p95 only when the
   sample size supports them.

## Local workspace impact

The scripts never enumerate or modify Local workspace files, engines or
registrations. They have no renderer or owner-switching implementation change.

## Cloud workspace impact

All live writes are opt-in orchestrator commands, restricted to fixed Alpha
API routes and recorded test resources. Existing attestation, containment,
actor admission, protocol ordering and cleanup receipts remain required.
Read-only source inspection never becomes authority to mutate that source.
