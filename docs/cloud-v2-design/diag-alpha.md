# X-A — Alpha cloud diagnosis and worker attestation

Date: 2026-10-04 UTC. Repository and Alpha API revision: `cec28a25cc1e`.
Investigation only; no application, workflow, provider configuration, or qualification changes.

## Executive summary

- Alpha's API is healthy and cloud-enabled, but still selects `zeros-qualification-aa11196c97a6`, sourced September 23, 113 commits behind Alpha.
- The Alpha database has **zero** `cloud_agent_runtime_qualifications` rows, across every image, profile, and credential kind.
- These zero counts are real application-scope reads: the reader had `pg_read_all_data`, read-only transactions, and the existing `app_is_system()` policy context; INSERT privilege and RLS bypass were false.
- Therefore Claude, Codex, and Cursor cannot obtain qualified workspace agent grants. This is the first **demonstrated mandatory blocker after successful startup**, not proof that a fresh staff workspace reaches readiness today.
- Base-image workspace creation does not require those approvals. Startup was not exercised; retained Alpha data contains one deleted workspace/generation and no setup or engine rows.
- Build computer, after its draft/authority prerequisites, deterministically rejects the missing base qualification with `409 cloud_computer_qualification_required`.
- The 21-day GitHub inventory covers 101 parent runs, including rerun attempts: 18 actual worker executions, 17 failures, one cancellation, zero successes; 40 other worker jobs were skipped.
- One execution exposes the specific image-attestation message. Ten expose only withheld private diagnostics; other failures concern canary admission or recovery. They must not all be labeled attestation failures.
- The specific message first became available in `29137fc94f6c`; earlier generic errors could conceal the same failure, but that is unproven.
- **The exact failing attestation predicate is not recoverable from the authorized public logs.** Its expected detailed evidence is in an encrypted R2 journal, outside this task's allowed live access.
- Boat reports three archived test/Dev sandboxes, zero active sandboxes, seven visible ready named snapshots, and ample available compute credit; a current “more than 100 snapshots” problem is not present.
- The minimum defensible repair starts by reading the retained private receipt or exposing a closed, value-free attestation summary, then fixing the demonstrated check and completing genuine Alpha native qualification.
- One temporary Alpha reader role was created and deleted; deletion returned 204 and its subsequent GET returned 404.

## Evidence scope and conventions

Source citations refer to `cec28a25cc1e` unless another revision is named.
Full public digests are shortened to 12-character prefixes in this report; these prefixes are not usable immutable image references.
Live SQL touched only `zeros-control-plane-alpha/main`; no Beta/Production database was accessed.
Boat calls were GET only. GitHub calls read workflows, runs, jobs, logs, and two small plan artifacts in memory.
No staff session, repository checkout inside a Boat VM, model turn, build, resume, snapshot save, deployment, or workflow dispatch was attempted.

Evidence anchors:

- **API:** public GETs to https://api-alpha.zeros.build/v1/release-identity and https://api-alpha.zeros.build/healthz; corresponding public endpoints on `api-beta.zeros.build` and `api.zeros.build`.
- **DB:** SELECT-only session observed at `2026-10-04T09:38:47.933Z`; queries and results in §2.
- **GH:** workflow-run interval `2026-09-13T09:35:37Z` through `2026-10-04T09:35:37Z`; all pages of run lists and jobs with `filter=all`, retaining each attempt.
- **Boat:** authenticated GET `/api/v1/sandboxes`, `/named-snapshots`, and `/limits`, with the Alpha/test billing org selected through the org query and `X-Boat-Org` header. Details in §4.

## 1. What happens for an Alpha staff user

### Gate order and what is actually established

| Stage | Current behavior and first possible failure | Evidence / live status |
| --- | --- | --- |
| Desktop capability and destination | Cloud-capable desktop, collaborative organization with Cloud access, project, GitHub remote/source, create options and installation are required. Staff status alone does not supply repository access. | `apps/desktop/src/engine/cloud-workspace-capability.ts:23–35`; `apps/desktop/src/renderer/shell/dispatcher/cloud-create.ts:143–161`. Alpha release [37189435299](https://github.com/Withso/zeros/actions/runs/37189435299) logs baked cloud capability true and `BUILD_CLOUD_ENABLED:true`; the user's installed Mac was not inspected. |
| Control-plane authorization | Validate account/organization/team membership, organization identity, individual Pro sponsor, GitHub installation/revision, and quota/funding admission. Personal workspaces are local only. | `apps/control-plane/src/cloud-workspaces/authorization.ts:308–350`; `routes.ts:1948–2001,2099–2108`. The individual staff account's complete eligibility was not read. |
| Select worker and accept create | No active Cloud Computer means return the configured shared base directly. Create records workspace, generation, settings and lifecycle intent asynchronously. | `computer-image.ts:212–246`; `routes.ts:1981,2103–2108,2133`. Live Alpha has zero computer/image rows, so missing qualification is not a universal base-create rejection. |
| Provision and setup | Reconciler provisions the saved generation; Boat setup validates ownership, probes/starts the root supervisor, then uses a restricted, host-key-bound channel for the fixed setup admission. The helper redeems setup material, attests, prepares repository/settings, reattests and starts the engine. | `boat-setup-runner.ts:419–466,531–539`; current helper `scripts/cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs:2479–2538`. The installed helper is from the selected old image; today's flow was not executed. |
| Engine ready | Registration validates exact protocol and v3 runtime metadata, then readiness publication requires the consumed registration grant, same setup fence/generation, a live ready engine, and current lifecycle authority. | `setup-materials.ts:1324–1338`; `setup-worker.ts:789–850`. Both `aa11196c97a6` and current `engine-protocol-version.ts:11` use protocol 20. Age alone does not prove rejection. |
| Claude / Codex / Cursor turn | A saved credential and delegation must match an enabled approval for the exact provider, image, engine runtime contract, profile and credential kind. Workspace grant metadata additionally requires v3 and MCP qualification. | `agent-credentials.ts:414–437`; `agent-executions.ts:97–120`. **Guaranteed missing approval on Alpha: the whole qualification table is empty.** |
| Build computer | Requires a configured image builder, manager authority/team, a saved current draft and no active build. Then it requires at least one enabled base-image approval before inserting a build/image. | `computer.ts:376–414`. **After these prerequisites:** `409 cloud_computer_qualification_required`, “Qualify the base image before building a Cloud Computer.” |
| Activate computer | Even a successfully attested child needs fresh exact-child-image qualification corresponding to the enabled base matrix. | `computer-image.ts:161–207`. Merely making a Boat snapshot does not make an active usable Cloud Computer. |

The relative control-plane paths in this table are under `apps/control-plane/src/cloud-workspaces/`.

With a valid credential delegation, the app can hide the unqualified agent or show:
“This workspace's agent runtime needs an update before this agent can run. Your account connection is saved.”
Without any matching delegation, its earlier message asks for cloud credential authorization.
The server's execution admission still rejects an attempted bypass with `403 cloud_agent_authority_rejected`.
Evidence: `apps/desktop/src/renderer/features/agent/workspace-agent-registry.ts:62–68`;
`apps/desktop/src/renderer/platform/cloud-workspaces.ts:164–175`;
`apps/control-plane/src/cloud-workspaces/agent-executions.ts:44,110–120`.

**Answer to “which gate fails first?”** The first blocker established by current live data is the qualification gate before a credentialed turn. A fresh authenticated staff create/setup could fail earlier for user-specific authority, GitHub, funding, or image/bootstrap reasons; this read-only investigation cannot establish otherwise. Build computer independently hits the same missing-base-approval problem after saving a valid draft.

Do not interpret the empty setup/engine tables as “setup has never worked.” The dated September 26 qualification document records create, ready, stop, wake and second ready, but no paid model turn. That is historical evidence, not a fresh replay, and later cleanup can remove retained runtime rows.
Evidence: `docs/cloud-workspace/qualification-status.md:70–86`.

## 2. Live Alpha database and configured worker

### Worker tuple and service state

| Public identity field | Alpha observation |
| --- | --- |
| API source | `cec28a25cc1e` |
| API ready / maintenance | `true / false` |
| Migrations | current; head and expected head both `0123_cloud_workspace_staff_compute_allowances.sql` |
| Cloud | enabled, ready, healthy |
| Worker provider | `boat` |
| Snapshot | `zeros-qualification-aa11196c97a6` |
| Image-build digest prefix | `8928cc4f737b` |
| Worker source | `aa11196c97a6`, committed `2026-09-23T05:18:06Z` |
| Architecture / measured storage | `linux/amd64` / `70225 MiB` |
| Complete required approval matrix | `workerQualified:false` |
| Worker promotion flag in latest release logs | disabled |

Beta and Production public identities select the same worker tuple; their API source is `1dc0d625c743`.
All three `/healthz` endpoints returned 200 with execution, background workers and durability enabled, operational state healthy, and no reported reasons.
The initial `/health` probe was 404; `/healthz` is the actual liveness route (`apps/control-plane/src/app.ts:235`).

The latest release logs explicitly record `ZEROS_WORKER_PROMOTION` disabled:
Alpha [37189435299](https://github.com/Withso/zeros/actions/runs/37189435299),
Beta [37139681211](https://github.com/Withso/zeros/actions/runs/37139681211),
Production [37142659660](https://github.com/Withso/zeros/actions/runs/37142659660).
Their worker jobs were skipped. These are logged release settings, not a direct read of current provider variables.

The public readiness result deliberately permits a healthy API while its worker matrix is false:
`apps/control-plane/src/release-identity.ts:71–109`.
The matrix needs enabled, MCP-qualified v3 rows for `claude-setup-token`, `codex-chatgpt`, and `cursor-api-key` sharing one valid runtime contract (`:22–30`).

### SELECT results

Window: the last 14 days at the DB read, approximately September 20 09:38 UTC through October 4 09:38 UTC.
Counts are retained rows, not an audit of all historical activity.

| Table / grouping | All retained rows | Rows created in last 14 days / retained outcome |
| --- | ---: | --- |
| `cloud_agent_runtime_qualifications` | 0 | No rows for any credential kind, image or profile |
| `cloud_computers` | 0 | No saved draft/active/previous selections |
| `cloud_computer_images` | 0 | No org image state or error rows |
| `cloud_computer_builds` | 0 | No build state, cleanup outcome or error rows |
| `cloud_workspaces` | 1 | 1 `deleted`; `last_error_code=NULL`; created September 26 08:44:43.579 UTC |
| `cloud_workspace_generations` | 1 | Generation 1, Boat, the configured old image/source, same creation time |
| `cloud_workspace_setup_runs` | 0 | No setup state/error-code groups |
| `cloud_workspace_engine_instances` | 0 | No ready, expired or revoked engine rows retained |
| `cloud_workspace_diagnostic_incidents` | 0 | No retained incident evidence |
| `cloud_workspace_lifecycle_intents` | 4 | 4 `succeeded`, `error_code=NULL`; September 26 08:44:43.579–08:52:36.253 UTC |

`cloud_workspace_generations` has no state column; the sole parent workspace is deleted.
No setup failure codes can honestly be supplied when the query returns no setup rows.
The computer schema and qualification schema were read through `information_schema.columns`, not assumed from old prose.

For the configured image and `zeros-cloud-worker-v3`:

| Credential kind | Rows | Enabled/MCP-qualified rows |
| --- | ---: | ---: |
| `claude-setup-token` | 0 | 0 |
| `codex-chatgpt` | 0 | 0 |
| `cursor-api-key` | 0 | 0 |
| Any other kind/profile/image | 0 | 0 |

Queries executed included the following SELECTs; state and error-code grouping was also run without the date predicate for all retained rows:

~~~sql
SELECT current_setting('transaction_read_only') AS transaction_read_only,
       app_is_system() AS application_system_context,
       pg_has_role(current_user,'pg_read_all_data','member') AS reader_member,
       has_table_privilege(current_user,'cloud_workspaces','INSERT') AS can_insert,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass_rls,
       now() AS observed_at;

SELECT provider,image_ref,runtime_contract_sha256,profile,credential_kind,
       enabled,mcp_qualified,native_capabilities,qualified_at
FROM cloud_agent_runtime_qualifications
ORDER BY provider,image_ref,profile,credential_kind LIMIT 250;

SELECT status,last_error_code,count(*)::int AS count,
       min(created_at) AS first_at,max(created_at) AS last_at
FROM cloud_workspaces WHERE created_at>=now()-interval '14 days'
GROUP BY status,last_error_code ORDER BY status,count DESC;

SELECT state,error_code,count(*)::int AS count,
       min(created_at) AS first_at,max(created_at) AS last_at
FROM cloud_workspace_setup_runs WHERE created_at>=now()-interval '14 days'
GROUP BY state,error_code ORDER BY state,count DESC;

SELECT generation,provider,image_ref,source_commit,created_at
FROM cloud_workspace_generations
WHERE created_at>=now()-interval '14 days'
ORDER BY created_at DESC LIMIT 100;
~~~

The first SELECT returned `read_only=on, application_system_context=true,
reader_member=true, can_insert=false, bypass_rls=false`.
The session used startup settings `default_transaction_read_only=on`,
`statement_timeout=25000`, and `app.system=on`; all SQL statements issued were SELECTs.
Live `pg_policies` confirmed system SELECT/ALL policies for every queried application table.
The existing system policy is `app_is_system()`, defined in `migrations/0002_rls.sql:23–25`;
qualification SELECT policy is in `migrations/0084_cloud_personal_agent_credentials.sql:110`.
Thus the zero counts are not the default reader-context/RLS ambiguity.

## 3. Every worker execution in the last 21 days

### Enumeration and completeness

Run-list reads used workflow IDs 321408598 (Alpha), 321408601 (Beta), 321408604 (Release),
and 370414554 (Cloud worker promotion), `per_page=100`, all pages, and the fixed GH interval above.
Every parent then used `GET /repos/Withso/zeros/actions/runs/{id}/jobs?filter=all&per_page=100`,
including all pages/attempts. No list hit a result cap.

| Workflow | Parent runs | Executed worker attempts | Skipped worker jobs | Parents with no worker job |
| --- | ---: | ---: | ---: | ---: |
| Release (alpha) | 85 | 15 | 27 | 48 |
| Release (beta) | 9 | 1 | 7 | 3 |
| Release | 6 | 1 | 6 | 2 |
| Cloud worker promotion | 1 | 1 | 0 | 0 |
| Total | 101 | 18 | 40 | 53 |

The standalone dispatch was Alpha, confirmed by its plan artifact 11268923685.
The reusable worker workflow was introduced by `99385dae` on September 29; it did not exist before this window.
Skipped approval-only jobs are not worker executions.
The 40 skipped worker jobs are listed below the executed attempts for auditability.

### Executed attempts

Every failing/cancelled step below is step 8 in its worker job. “Exit” is the Actions process exit,
**not** a measured native-attester or nested command exit.

| Run / attempt | Worker started UTC | Channel | Result | Failing step | Exit | Diagnostic |
| --- | --- | --- | --- | --- | --- | --- |
| [36935821422](https://github.com/Withso/zeros/actions/runs/36935821422/attempts/1) / 1 | 2026-10-01 22:52:59 | alpha | cancelled | Worker plan or guarded execution | — | Cancelled during worker execution; no inner exit code recorded |
| [36953557620](https://github.com/Withso/zeros/actions/runs/36953557620/attempts/1) / 1 | 2026-10-02 02:19:53 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [36962274440](https://github.com/Withso/zeros/actions/runs/36962274440/attempts/1) / 1 | 2026-10-02 04:02:00 | production | failure | Worker plan or guarded execution | 1 | Release canary historical ownership unconfirmed |
| [36965783452](https://github.com/Withso/zeros/actions/runs/36965783452/attempts/1) / 1 | 2026-10-02 05:17:00 | alpha | failure | Worker plan or guarded execution | 1 | Release canary admission unconfirmed |
| [36971245494](https://github.com/Withso/zeros/actions/runs/36971245494/attempts/1) / 1 | 2026-10-02 06:17:57 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37001197851](https://github.com/Withso/zeros/actions/runs/37001197851/attempts/1) / 1 | 2026-10-02 11:47:46 | beta | failure | Worker plan or guarded execution | 1 | Release canary admission unconfirmed |
| [37002706748](https://github.com/Withso/zeros/actions/runs/37002706748/attempts/1) / 1 | 2026-10-02 12:04:23 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37009238293](https://github.com/Withso/zeros/actions/runs/37009238293/attempts/1) / 1 | 2026-10-02 13:13:06 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37021473225](https://github.com/Withso/zeros/actions/runs/37021473225/attempts/1) / 1 | 2026-10-02 15:01:03 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37056284845](https://github.com/Withso/zeros/actions/runs/37056284845/attempts/1) / 1 | 2026-10-02 20:09:53 | alpha | failure | Worker plan or guarded execution | 1 | Release canary admission unconfirmed |
| [37056284845](https://github.com/Withso/zeros/actions/runs/37056284845/attempts/2) / 2 | 2026-10-02 20:18:17 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37094447283](https://github.com/Withso/zeros/actions/runs/37094447283/attempts/1) / 1 | 2026-10-03 04:12:29 | alpha | failure | Worker plan or guarded execution | 1 | Release canary admission unconfirmed |
| [37094447283](https://github.com/Withso/zeros/actions/runs/37094447283/attempts/2) / 2 | 2026-10-03 04:19:11 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37098210075](https://github.com/Withso/zeros/actions/runs/37098210075/attempts/1) / 1 | 2026-10-03 05:46:28 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37103244370](https://github.com/Withso/zeros/actions/runs/37103244370/attempts/1) / 1 | 2026-10-03 06:54:32 | alpha | failure | Worker plan or guarded execution | 1 | Historical recovery budget exhausted; holds retained |
| [37107329096](https://github.com/Withso/zeros/actions/runs/37107329096/attempts/1) / 1 | 2026-10-03 08:07:53 | alpha | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37109250825](https://github.com/Withso/zeros/actions/runs/37109250825/attempts/1) / 1 | 2026-10-03 08:18:28 | alpha (standalone) | failure | Worker plan or guarded execution | 1 | Private diagnostics withheld |
| [37111582597](https://github.com/Withso/zeros/actions/runs/37111582597/attempts/1) / 1 | 2026-10-03 09:24:16 | alpha | failure | Worker plan or guarded execution | 1 | Image attestation failed; private command receipt retained |

Failed logs were read using `gh run view <run> --attempt <attempt> --job <job> --log-failed`.
Complete job logs were then read to recover the line immediately preceding each outer exit and the cancellation message.
Output passed the prescribed WAF sed replacement and token/value redaction before inspection.

Distinct diagnostics: ten withheld-private failures; four canary-admission failures; one historical-ownership failure;
one historical-recovery-budget failure; one specific image-attestation failure; one cancellation.
No failed log exposed a native inventory digest mismatch, a `sourceIntegrity=false` result,
an inner attester exit code, a per-check boolean, or a hydration timeout.

The other explicit messages also have narrower, separate code boundaries:

- Canary admission unconfirmed is a broker request/parsing/error wrapper (`scripts/release/worker-broker.ts:27–45`) or native-start wrapper (`scripts/release/worker-canary.ts:77–84`); it does not reveal an HTTP status, credential kind, or attestation predicate.
- Historical ownership unconfirmed is the composite owner/array/history-bound check in `scripts/release/worker-run.ts:119–120` and `worker-canary-recovery.ts:72–73`; the message does not identify the failed conjunct.
- Historical recovery budget exhausted is the observation-count/deadline/abort guard in `scripts/release/worker-canary-recovery.ts:123`, with defaults of 16 records and 15 seconds (`:67`). It is not the attester's hydration budget. Alpha subsequently deferred historical recovery (`worker-run.ts:121–129`); remaining holds were not read here.

### What the specific attestation failure proves

The final attempt's worker command started at `2026-10-03T09:24:57Z`.
At `09:27:21.112Z`, run [37111582597](https://github.com/Withso/zeros/actions/runs/37111582597)
logged “Worker image attestation failed; private command receipt retained”; the Actions process exited 1.
Its source was `29137fc94f6c`.

The error path is:

1. `scripts/release/worker-adapters.ts:46–58` waits for a successful native build, then calls attestation start/status.
2. The adapter catches **any KitError from either attestation action** and replaces it with that fixed PromotionError (`:158–169`).
3. `scripts/cloud-workspace-validation/boat-image/boat-image.ts:281–296` can throw for command HTTP failure, nonzero exit, timeout, or truncated output.
4. The actual attestation wrapper first checks expected source and absent engine/setup cgroups, launches the attester, then records `code`, `retirement`, and `scopePresent`. These are separate possible failures (`apps/control-plane/src/cloud-workspaces/computer-image-scripts.ts:198–229`).
5. The kit rejects any nonzero attester/retirement code or remaining engine scope **before saving parsed native-attestation.json** (`boat-image.ts:404–412`).
6. Consequently, the outer exit 1 does not identify which of these checks failed.

`git diff 586711c81814 29137fc94f6c -- scripts/release/worker-adapters.ts`
shows this specific message and latest-status-receipt retention were added in the final run's source.
Earlier non-PromotionError failures were reduced to “Worker qualification stopped; private diagnostics withheld”
by `scripts/release/worker-cli.ts:94–96`.
That explains why the visible wording changes; it does not establish a common underlying cause.

The complete required private evidence is expected under the encrypted registry document
`release-workers/v1/alpha.json`, in `resources.images` for `releaseRunId=37111582597`,
particularly `kitFiles["commands/<timestamp>-attest-status.sh.json"]`.
Its nested `stdout` contains the wrapper exit/report/error.
Storage location: `scripts/release/worker-run.ts:64–71,149–156`;
bounded receipt persistence: `worker-adapters.ts:75–114`.
A start failure is an extra uncertainty: the retained command allowlist selects **status** receipts, not `attest.sh` start receipts.

That R2 document and its encryption authority were not read: R2 is outside this task's explicit live allowance.
The run has only a worker-plan artifact, a desktop build artifact, and a hosted-services artifact.
There is no downloadable attestation report or success receipt among those three artifacts.
Plan artifact 11271230441 confirms enabled=true and `inputsSha256` prefix `2a7d9949d6bf`,
but its planned stages and initial `qualificationProfile:smoke` are not execution outcomes.
The actual profile is recalculated against the selected worker later (`worker-cli.ts:48–51,81–84`).

### Native inventory drift versus hydration: what can and cannot be concluded

| Candidate failure class | Exact source check | Evidence assessment |
| --- | --- | --- |
| Native base inventory changed | `image-build-contract.mjs:71–99` hashes sorted dpkg package/version inventory, OS release and running Node; attester `:310–328` requires exact base-origin equality. | A real failure class, **not observed in this run**. Hash names are `packageInventorySha256`, `osReleaseSha256`, `nodeSha256`. |
| Source/artifact mismatch | `attest-cloud-worker.mjs:382–384` combines origin matching with `cloudImageBuildMatchesInstallation`; the latter checks clean source, source-contract digest and artifact hashes (`image-build-contract.mjs:109–127`). | Even a future `sourceIntegrity=false` read would need decomposition; it does not uniquely identify package drift. |
| Ownership/modes/symlink inventory | `attest-cloud-worker.mjs:63–126,336–421` validates root-controlled helpers and full engine/runtime trees, with a 500,000-entry guard. | Unobserved. |
| Isolation/resources/setup qualification | Attester `:446–513` runs live engine qualification, requires finite resources, secure process identity and separate secure setup qualification. | Unobserved; any can cause qualified=false. |
| Cold disk hydration / timeout | Inventory/source subprocesses have 30-second limits (`image-build-contract.mjs:21–35`); engine qualification 180 seconds; setup 30 seconds; lock owner 300 seconds; wrapper 310 seconds. | No timing/check receipt establishes this cause. The whole final worker command lasted about 144 seconds, so a fresh 300/310-second outer timeout is a poor fit; shorter subcommand failure remains possible. |
| Scope startup/retirement or provider command failure | Shared wrapper `computer-image-scripts.ts:202–214`; kit `boat-image.ts:292–295,408–409`. | Still possible and indistinguishable in the public message. |
| “Too many snapshots” | Current inventory is seven names; error was classified in attestation, after build admission. | Not supported as the current final-attempt cause. |

Paths for the two attester/contract files in that table are under
`scripts/cloud-workspace-validation/sandbox/`.

A simple “Boat tooling drift” narrative is especially premature: the builder records its native inventory
**after** installs and builds, using the same pinned Node path as the attester
(`boat-image/templates/build.sh:2,5–8,27–30`).
Changes inherited from an older base before this capture are included in the newly recorded inventory.
A mismatch needs a later change, differing execution inputs, or an inventory-read failure demonstrated by the receipt.

**Root-cause conclusion:** the exact live attestation check and underlying reason remain unverified.
What is established is a failure inside the kit's attestation boundary and a diagnostic design that hides its cause from authorized workflow-log readers.
A confident claim that package drift, native inventory, or lazy hydration caused this incident would exceed the evidence.

### Skipped worker jobs

Dates below are parent-run creation dates. Multiple attempts are shown in one row.
Every listed worker result is skipped, so there is no failing worker step; parent workflows may independently succeed or fail.

| Parent run | Created UTC | Channel | Skipped attempts |
| --- | --- | --- | --- |
| [36608615252](https://github.com/Withso/zeros/actions/runs/36608615252) | 2026-09-29 17:57:31 | alpha | 1, 2 |
| [36616549331](https://github.com/Withso/zeros/actions/runs/36616549331) | 2026-09-29 19:03:45 | alpha | 1 |
| [36651144245](https://github.com/Withso/zeros/actions/runs/36651144245) | 2026-09-30 00:36:22 | alpha | 1 |
| [36659976917](https://github.com/Withso/zeros/actions/runs/36659976917) | 2026-09-30 02:28:07 | alpha | 2 |
| [36699251374](https://github.com/Withso/zeros/actions/runs/36699251374) | 2026-09-30 09:55:59 | alpha | 1 |
| [36769484227](https://github.com/Withso/zeros/actions/runs/36769484227) | 2026-09-30 19:59:32 | alpha | 1 |
| [36771733059](https://github.com/Withso/zeros/actions/runs/36771733059) | 2026-09-30 20:18:50 | beta | 1 |
| [36812148352](https://github.com/Withso/zeros/actions/runs/36812148352) | 2026-10-01 03:47:45 | alpha | 1 |
| [36831367596](https://github.com/Withso/zeros/actions/runs/36831367596) | 2026-10-01 07:37:10 | alpha | 1, 2 |
| [36844089273](https://github.com/Withso/zeros/actions/runs/36844089273) | 2026-10-01 09:38:58 | alpha | 1 |
| [36844114568](https://github.com/Withso/zeros/actions/runs/36844114568) | 2026-10-01 09:39:13 | beta | 1, 2 |
| [36849902282](https://github.com/Withso/zeros/actions/runs/36849902282) | 2026-10-01 10:33:41 | production | 1, 2, 3, 4 |
| [36860634827](https://github.com/Withso/zeros/actions/runs/36860634827) | 2026-10-01 12:16:10 | alpha | 1 |
| [36863516211](https://github.com/Withso/zeros/actions/runs/36863516211) | 2026-10-01 12:42:03 | alpha | 1 |
| [36882109233](https://github.com/Withso/zeros/actions/runs/36882109233) | 2026-10-01 15:10:04 | alpha | 1 |
| [36886904939](https://github.com/Withso/zeros/actions/runs/36886904939) | 2026-10-01 15:46:39 | alpha | 1 |
| [36893759042](https://github.com/Withso/zeros/actions/runs/36893759042) | 2026-10-01 16:40:29 | alpha | 1 |
| [36898068303](https://github.com/Withso/zeros/actions/runs/36898068303) | 2026-10-01 17:15:42 | alpha | 1, 2 |
| [36922231426](https://github.com/Withso/zeros/actions/runs/36922231426) | 2026-10-01 20:31:43 | alpha | 1 |
| [36927449666](https://github.com/Withso/zeros/actions/runs/36927449666) | 2026-10-01 21:15:35 | alpha | 1 |
| [36953618191](https://github.com/Withso/zeros/actions/runs/36953618191) | 2026-10-02 02:00:42 | beta | 1, 2 |
| [36999591343](https://github.com/Withso/zeros/actions/runs/36999591343) | 2026-10-02 11:10:59 | alpha | 1 |
| [37121284774](https://github.com/Withso/zeros/actions/runs/37121284774) | 2026-10-03 11:57:10 | alpha | 1 |
| [37129299117](https://github.com/Withso/zeros/actions/runs/37129299117) | 2026-10-03 14:21:15 | alpha | 1 |
| [37131413705](https://github.com/Withso/zeros/actions/runs/37131413705) | 2026-10-03 14:56:05 | beta | 1 |
| [37133858447](https://github.com/Withso/zeros/actions/runs/37133858447) | 2026-10-03 15:36:48 | production | 1 |
| [37139662366](https://github.com/Withso/zeros/actions/runs/37139662366) | 2026-10-03 17:12:31 | alpha | 1 |
| [37139681211](https://github.com/Withso/zeros/actions/runs/37139681211) | 2026-10-03 17:12:51 | beta | 1 |
| [37142659660](https://github.com/Withso/zeros/actions/runs/37142659660) | 2026-10-03 18:01:25 | production | 1 |
| [37176890415](https://github.com/Withso/zeros/actions/runs/37176890415) | 2026-10-04 04:24:02 | alpha | 1 |
| [37185169154](https://github.com/Withso/zeros/actions/runs/37185169154) | 2026-10-04 07:14:18 | alpha | 1 |
| [37189435299](https://github.com/Withso/zeros/actions/runs/37189435299) | 2026-10-04 08:35:47 | alpha | 1 |

## 4. Boat Alpha/test inventory and allowance

### Sandboxes

The org-scoped sandbox list returned three records, all with billing team matching the selected org.
Its `pageInfo` was `{nextCursor:null,hasMore:false,limit:100}`.
The limits endpoint independently reported `activeSandboxes:0`.

| Sandbox ID | State | Created UTC | Last update UTC |
| --- | --- | --- | --- |
| `bx_fug2qc6a` | archived | September 29 04:53:54.480 | September 29 16:29:20.665 |
| `bx_5s4p3wt7` | archived | September 28 13:36:26.083 | September 28 16:09:44.866 |
| `bx_aaus6tu4` | archived | September 28 12:38:38.652 | September 28 13:30:58.196 |

All three have a `dev-7f1cc26625f19e646feb5e6d-b36ec9c3-` name prefix.
There are **no currently active builders or canaries** in this inventory.
The archived names look like prior Dev/test allocations; GET metadata alone does not prove their former role or whether retention is intentional.
They do not match the current Alpha release-worker owner prefix derived by `scripts/release/worker-owner.ts:5`.
No claim of physical deletion or cleared shared-admission holds follows from an archived state or a zero active count.

### Named snapshots

Seven caller-visible snapshots, all ready; the response supplied no continuation cursor or `hasMore`.
The names are:

| Name | Source sandbox | Saved UTC |
| --- | --- | --- |
| `zeros-qualification-aa11196c97a6` | `bx_fvffcx23` | September 23 05:25:56.017 |
| `dev-7f1cc26625f19e646feb5e6d-b36ec9c3-004bf212cec879a1` | `bx_twgk64vd` | September 30 00:06:40.443 |
| `dev-9a339b74cfe3241d714273c7-bcc6aabd-b137015b0efe3319` | `bx_ugf89632` | October 2 13:15:43.177 |
| `dev-9a339b74cfe3241d714273c7-bcc6aabd-4173ac3ddab79b51` | `bx_pwen9x3y` | October 2 15:04:16.804 |
| `dev-9a339b74cfe3241d714273c7-bcc6aabd-60075e34b645bf0e` | `bx_2cdhbj39` | October 2 20:21:14.060 |
| `dev-9a339b74cfe3241d714273c7-bcc6aabd-b67be2bfd46ddc86` | `bx_tj84xdjg` | October 3 04:21:40.164 |
| `dev-9a339b74cfe3241d714273c7-bcc6aabd-9dab28bd4da1f863` | `bx_y7kvhpy3` | October 3 05:49:01.926 |

The last five names match the Alpha release owner derivation. Their presence is not evidence of agent qualification or permission to publish them.
Snapshot rows do not identify billing org. The response's **selected-wallet allowance** reported:
`free=10, used=2, extra=0, extraMonthlyDollars=0, extraDailyDollars=0,
pricePerExtraMonthlyDollars=1.7`.
Do not conflate seven caller-visible names with two names counted against this wallet.

“More than 100” is not today's inventory problem.
There is also no current local total-snapshot cap in `protectedBoatSnapshotCapacity`
(`apps/control-plane/src/cloud-workspaces/boat-account-admission.ts:25–31`);
old `maxNamedSnapshots` settings are discarded (`scripts/dev-environment/hosted-admission.mjs:3–9`).
Some clients do bound a **response page** at 100 (`boat-image.ts:449–466`;
`computer-image-boat.ts:77–85`). A future provider response above that bound without pagination
could fail closed; that is a compatibility concern, not an observed incident.
The separate `releaseRuns.length<100` guard in `worker-run.ts:119,134` bounds journal history, not named snapshots.

### Readable usage

| Measure | Observed value |
| --- | --- |
| Billing/subscription state | active; canStart=true; no startBlockedReason |
| Active / maximum active sandboxes | 0 / 100 |
| Start allowance | 12/minute, 60/hour, 200/day; zero used in all three current windows |
| Subscription quota | 2,000,000 standard seconds |
| Remaining subscription/credit | 1,912,770 seconds; reported 531.33 hours |
| Used credit | 87,230 seconds |
| Current live / last-24-hour compute usage | 0 / 0 seconds |
| Paid snapshot extras | 0 in selected wallet |

These are October 4 observations, not measurements of credit or holds during earlier failed runs.
The encrypted shared-admission ledger was not read; provider headroom alone does not prove the local builder slot is available.

## 5. Smallest repair and implications for v4

### (a) A working qualified v3 Alpha worker

There is no evidence-backed flag-only fix. Enabling cloud or worker promotion does not manufacture the missing approval matrix.
The smallest concrete repair path is:

1. **Resolve the retained failure before another allocation.** An authorized operator reads the Alpha registry record described in §3 and extracts only attestation action, HTTP status, command timeout/exit, nested attester/retirement exits, failed fixed check names, and expected/observed digest-match booleans. If the failure was start and no status receipt exists, record that explicitly.
2. **Make that evidence available safely in the worker lane.** Add a bounded schema to the existing adapter/kit boundary: action/stage enum, integer exit codes, timedOut, retirement/scope booleans, and allowlisted failed checks. Preserve private raw receipts; publish neither arbitrary stderr nor complete provider responses. Retain a safe start-failure receipt as well as status. The existing value-free patterns in `scripts/cloud-workspace-validation/lib/native-qualification-diagnostics.ts:5–106` provide a starting convention.
3. **Fix the check the receipt demonstrates.** If inventory differs, identify the changed field and when it changed; pin/stabilize that input and recapture metadata after all intended installs. If a bounded read times out, measure that phase on a cold restore and adjust its verified execution budget. If a root/namespace/cgroup/security check fails, repair that invariant. Do not skip attestation, mark an image qualified by hand, or infer a repair from the generic message.
4. **Build one current-source v3 candidate from the existing protected base.** Keep the qualified Node 22 ABI, explicit source pin, credential-free builder, correct wallet, finite TTL, and normal cleanup/admission receipts. Qualify a fresh restore as well as the builder; runtime drift can emerge at restore.
5. **Complete native evidence and audited Alpha approval.** Use the designated Alpha `claude-setup-token`, `codex-chatgpt`, and `cursor-api-key` canaries for the actual required smoke/full profile, MCP, and advertised capabilities. Retire credential-bearing resources, execute the audited runtime-approval plan, delete the operator role, update the whole worker tuple and finish hosted deployment. The required order already exists in `scripts/release/worker.ts:68–131`; reuse it.
6. **Verify the user path and one computer.** Require `workerQualified:true` for the selected tuple, staff create → setup → engine ready, one real turn per required provider kind, and a saved Cloud Computer build plus exact-child qualification/activation. Qualifying the base alone does not satisfy the current child-image activation rule.

Estimates are conditional, not observed completion times: 15–60 minutes to inspect an accessible receipt;
roughly 0.5–1 engineer-day to add/verify closed diagnostics; another 0.5–2 days for a bounded attestation repair
and one qualification/deployment cycle if no separate canary or retirement failure remains.
Allow 4–10 days if the distinct historical-admission/native failures recur.
The workflow permits 330 minutes and full native canaries may run up to 2,400 seconds each
(`.github/workflows/cloud-worker-promotion.yml:93`; `scripts/release/worker-run.ts:165–166`).
The unresolved receipt prevents a defensible promise that Alpha can be made fully working today.
No operational step above was executed during this investigation.

### (b) What v4 must change

| Design requirement | Why this investigation supports it |
| --- | --- |
| Separate base compatibility, immutable runtime identity and org environment identity | Today's worker update requires a whole snapshot and qualification chain. Define base/bootstrap/isolation identity separately from signed runtime manifest/contract; qualify the exact runtime + base + credential kind/profile. |
| Verify the deployed runtime file closure, not an incidental full source checkout | Current source verification and ownership scans traverse source/dependency trees. Ship a minimal complete runtime; verify every executable/native/policy byte with a verifier rooted in the base before execution. Do not defer executable verification merely to avoid hydration cost. |
| Define which host bytes belong to the trusted base | The native origin currently hashes the entire package/version inventory. Pin security-critical tooling and the bootstrap/isolation policy; deliberately classify provider-managed/noncritical inventory. An unknown change to trusted bytes must fail with a named predicate, not be silently accepted. |
| Capture provenance only after intended base construction; test fresh restores | Current builder already captures after installs. A v4 design still needs independent checks across cold create, restore/resume and org-image derivation to expose subsequent provider drift. |
| Separate cold materialization cost from integrity failure | Measure bytes/files and phase elapsed times under Boat cold restore. Use bounded, evidence-based budgets for hashing, ownership, isolated-engine checks and setup; preserve an actionable timeout phase and inner exit. |
| Emit closed diagnostics for every failure boundary | Distinguish transport, start preconditions, metadata/origin, runtime hashes, ownership, resource limits, engine/setup isolation, outer timeout and retirement. Publish fixed names and booleans/codes; keep raw details private and retained before cleanup. |
| Make activation atomic and preserve rollback identity | Only publish the runtime selector after verified materialization and admission; readiness must confirm the pinned runtime. An unrelated healthy API release must not imply that a newly selected runtime is qualified. |
| Keep qualification distinct from health and native image attestation | Today's health is true with zero agent approvals. Surface an actionable qualified-worker status; retain credential/MCP evidence and exact binding. For v4 org-image reuse, require independent environment/TCB integrity proof and a new explicit contract; do not weaken v3's exact-child rule. |
| Keep versioned diagnostics and compatibility explicit | Existing v1–v3 workers, serialized IDs and generation pins must remain readable. Apply the new facade/bootstrap contract to v4 bases rather than silently changing paths or the meaning of old receipts. |

These are incident-driven constraints consistent with `.context/research/FINAL-02-zeros-cloud-v2-plan.md:86–175`.
They reduce the chance of the same opaque failure class; they cannot guarantee that provider drift or genuine integrity failures never occur.

## Verified facts

| Fact | Verification |
| --- | --- |
| Alpha cloud is enabled/healthy but its matrix is false | Public release identity and healthz GETs, October 4 |
| All channels select the old shared tuple | Public release identities; no non-Alpha DB reads |
| Alpha qualification table is empty | SELECT with confirmed reader privilege/system RLS context and read-only transaction setting |
| No Alpha computer/build/image rows exist | Independent counts and safe row queries |
| One deleted workspace/generation; zero retained setup/engine rows | Counts and last-14-day state/metadata queries |
| Latest releases log worker promotion disabled | Alpha 37189435299; Beta 37139681211; Production 37142659660 |
| 18 executed worker attempts, zero successes | Complete run/job enumeration, including rerun attempts |
| Latest precise failure is inside kit attestation | Run 37111582597 log and adapter error mapping |
| Public logs do not identify the inner failed check | Failed logs and expanded error context for every executed attempt |
| Snapshot inventory is seven, not over 100 | Complete named snapshot response; no continuation advertised |
| Boat has no active compute at observation | Both sandbox states and org-scoped limits |
| Five retained snapshot names belong to the Alpha release owner prefix | Name list and deterministic `zeros-release-worker:alpha` owner derivation |
| Reader credential was removed | DELETE 204 followed by GET 404 |

## Inferences / open questions

- **High confidence, conditional on successful startup and valid delegation:** all three required native provider kinds are blocked by missing Alpha approvals.
- **Unverified:** the exact first failing gate for the user's installed Alpha desktop, staff identity, organization, GitHub repository and current funding state; no authenticated creation was authorized here.
- **Unverified:** whether the final KitError came from attestation start, attester exit, retirement, command transport or output handling, and which native predicate failed.
- **Unverified:** repeated underlying attestation failures in older generic-error runs. The specificity of the latest message is a code change, not new proof about older runs.
- **Unverified:** package/tooling drift or cold hydration as the incident cause. Neither actual mismatch fields nor nested exits/timings were exposed.
- **Unverified:** whether the encrypted journal's latest status receipt is complete and readable; it was outside the live allowance.
- **Unverified:** availability of the shared builder slot despite zero active VMs; retained ledger holds can differ from provider compute state.
- **Unverified:** exact credential admission/cleanup causes for the ten generic failures and four canary-admission failures.
- **Not established:** which archived Dev/test sandboxes are former builders versus canaries, or whether their retention is intentional.
- **Scope difference:** caller-visible snapshot count and wallet allowance differ; individual snapshot rows do not expose wallet attribution.

## Verification, follow-ups and cleanup

- Read `AGENTS.md`, `RULES.md`, the complete X-A prompt and implementation rules, then traced current source and dated research.
- `pnpm check:secrets` passed: 5,572 tracked files scanned, no secrets found.
- Report validation checked all required sections, the 20-line executive-summary and 600-line report bounds, all 18 execution rows, cited full-path existence, and absence of credential values/token shapes. The tracked checkout remained clean on the original `main` branch.
- Scoped `pnpm agent:check --file /dev/null --json` ran with only `BOAT_API_KEY` supplied in memory: Boat passed, other providers skipped, exit 0. Its file-mode warning concerns the empty device file. The original dotenv parsed without malformed/duplicate entries; its separate file check reported mode 0644, left unchanged under read-only scope.
- The initial scoped `--file /dev/stdin` attempt failed locally with ENXIO before provider checks; the device-file invocation replaced it. Default full `agent:check` was intentionally not run because it would probe unallowed providers and sibling databases.
- Typecheck, lint, UI checks, Git suites, control-plane tests and platform smokes were not run: this task changes only this ignored research report and prohibits code/runtime changes. No test or macOS execution is claimed.
- Follow-up for the orchestrator: obtain the safe summary from the retained Alpha R2 receipt through an explicitly authorized operator, implement the small diagnostic boundary, then scope the demonstrated repair and native qualification. Archived resources and pending holds need owner-proven reconciliation, not speculative deletion.
- **Credential created:** PlanetScale Alpha/main reader role `zeros-v2-test-diag-alpha-20261004-xa`, ID `nhlmoiavvpr8`, inherited role `pg_read_all_data`, requested TTL 3,600 seconds. Its password stayed in process memory and was never printed or written to this report.
- **Credential cleanup confirmed:** connection closed; DELETE returned **204**; subsequent GET for that exact role returned **404**.
- No Boat resources, snapshots, database application rows, Git branches, commits, PRs or deployments were created or changed. Only this report was authored.
