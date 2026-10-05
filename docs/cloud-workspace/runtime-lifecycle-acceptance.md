# V4 runtime lifecycle acceptance on Alpha

This runbook is for a credentialed orchestrator workspace. B8 implements and
tests the lifecycle locally; it does not run this procedure or claim live Alpha
acceptance. The runner uses ordinary authenticated control-plane workspace APIs,
creates only its own `zeros-v2-test-*` workspace, and requests deletion in `finally`.
It never publishes, qualifies, revokes, deploys, changes switches, or calls a
provider API directly.

## Prerequisites

The Alpha control plane must have this endpoint and the v4 base/installer,
runtime delivery, qualification, attester and persistence-layout changes deployed
and qualified. New v4 creation must already be enabled for engineering staff.
Use a staff account with organization admin and workspace management rights,
available compute, and access to a disposable repository and its GitHub installation. Keep the repo
and inherited settings free of real data or unattended agent work.

In the gitignored repository-root `.env.agent`, privately set the names below.
The access token is the account's ordinary Alpha bearer token, not a WorkOS,
Boat or other provider administration key. Never send its value through chat,
command arguments, reports or logs. This runner does not read process environment
fallbacks and ignores unrelated provider credentials in that file.

| Variable | Meaning |
| --- | --- |
| `ZEROS_B8_ALPHA_ORIGIN` | HTTPS control-plane origin, with no credentials, path, query or fragment. |
| `ZEROS_B8_ALPHA_ACCESS_TOKEN` | Fresh engineering staff account access token, valid through cleanup. |
| `ZEROS_B8_ALPHA_ORGANIZATION_ID` | Disposable-workspace organization UUID. |
| `ZEROS_B8_ALPHA_TEAM_ID` | Optional team UUID; omitted uses normal create defaults. |
| `ZEROS_B8_ALPHA_REPOSITORY_OWNER` | Disposable repository owner. |
| `ZEROS_B8_ALPHA_REPOSITORY_NAME` | Disposable repository name. |
| `ZEROS_B8_ALPHA_REPOSITORY_REVISION` | Ref/commit to create, default `main`. |
| `ZEROS_B8_ALPHA_GITHUB_INSTALLATION_ID` | Control-plane GitHub installation UUID for that repository. |
| `ZEROS_B8_ALPHA_NEXT_RUNTIME_ID` | A known later runtime B, not yet eligible when workspace A is created. |
| `ZEROS_B8_ALPHA_QUALIFICATION_MODE` | Match the deployed mode: `full` (default) or `smoke`. |
| `ZEROS_B8_ALPHA_TIMEOUT_SECONDS` | Bound per polling phase, default 1,200, maximum 3,600. |

Arrange B's publication/qualification separately under the orchestrator's
explicit Alpha authorization. The runner waits for B's confirmed release and
enabled qualifications on A's base. Keep other head changes out of this test
window; the upgrade must select the specified B for this exercise to pass.

## Run and retain evidence

From the checkout root:

```sh
node scripts/cloud-workspace-validation/runtime-bundle/lifecycle.mjs
```

The runner checks `/v1/release-identity` for healthy Alpha with v4 creation,
then checks the engineering-only runtime status endpoint and access to the
organization's pending-deletion inventory before any mutation.
It creates A, waits for ready, stops A, then waits for B. Once
`.context/b8-runtime-lifecycle.json` includes `source_stopped`, the orchestrator
can complete the separately authorized publication/qualification of B.

The runner wakes A and compares every saved runtime field and generation number.
It explicitly upgrades to B, waits for the replacement generation to be ready,
checks the same base image and compatibility IDs, replays the operation, and
checks stale-generation refusal with a new operation ID. Network retries reuse
the original idempotency keys. A lost create response is replayed to recover the
workspace ID for cleanup.

The private report is written at each resource boundary and on completion. It
contains only workspace/operation/transition UUIDs, generation numbers and fixed
check results; it excludes raw pins, responses, errors, URLs and credentials.
Stdout contains one `zeros.diagnostic/v1` record with fixed checks. Exit 0 requires
every check and confirmed provider cleanup. Mocked runner tests cover non-Alpha
refusal, changed wake pins, failed upgrade, lost create replies, pending cleanup
and exclusion of secret response text.

Cleanup uses ordinary DELETE with `discardUncheckpointed:true` only on the
runner-created synthetic workspace. It waits for workspace status `deleted` and
an untruncated organization pending-deletion inventory with no remaining entry
for that workspace. This confirms provider cleanup, not physical erasure of
retained durable objects; normal storage reclamation remains asynchronous.
Do not terminate the runner before cleanup. If the process is killed, auth
expires or `cleanup_unconfirmed` is reported, use the saved workspace and delete
operation IDs to replay normal deletion and independently verify pending
generations. If only the create operation ID was saved, replay that exact create
request/key to recover its workspace ID. Report unresolved cleanup as a failure.

## Additional Alpha acceptance

The API runner does not start agents or inject provider faults. Complete these
on separately authorized disposable resources, record resource IDs and cleanup,
and retain only closed diagnostics or nonsecret observations:

- Create uncommitted files, Git state and native provider history. Check them
  after stop/resume, setup retry and A-to-B checkpoint restoration. Resume is
  not a reboot: verify restored mounts and fresh setup/engine admission without
  assuming a new kernel boot ID. Never test persistence by publishing with a
  pre-existing directory rename outside `/home/user`.
- Run an agent and require upgrade to return 409 `cloud_workspace_busy`; stop
  it, then upgrade with a fresh operation. Exercise a source recovery incident
  and confirm exact pin copying, including when new v4 creation is disabled.
- Revoke only an isolated disposable runtime with separately approved ownership
  and no shared Alpha consumers. Require wake/recovery/setup retry to return or
  persist `cloud_runtime_revoked`; explicitly upgrade to an eligible later runtime
  on the same base. Never revoke the shared head for this test.
- Inspect provider-operation evidence for the source and candidate: the saved
  base image/build must be identical and the upgrade must not build/capture an
  image. Exercise candidate failure and verify preservation of the source and
  its pin; a revoked source must remain closed during rollback.
- Run the required macOS engine smoke in a Mac checkout. Cloud Linux test
  results do not cover that platform gate or real native-provider turns.

Cloud Computer template-source pin copying is C5's extension of the shared
`copyGenerationPins` transaction. Public API/UI, base migration, billing changes,
and broad revocation/GC drills are outside this runbook.
