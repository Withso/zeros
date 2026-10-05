# Cloud Computer template retention

The control plane retains each organization's active template, previous template,
the newest ten ready versions (ordered by build version), and every template
referenced by a workspace whose workspace/data deletion is not complete. Stopped
workspaces and retired generations still protect their sources for recovery.
These sets overlap; ten is not a cap on all retained templates.

Activation and successful automatic activation notify
`cloud_computer_template_retention` after their transaction commits. The worker
also sweeps every minute, including after a restart or a missed notification.
Each sweep scans candidates in build-version pages, so unresolved deletions do
not block later candidates. Subsequent sweeps retry unresolved journals.
It runs on Alpha with the existing `CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED`
switch and Boat account/wallet scope; no separate retention flag is introduced.
Notifications use a separate session connection when `DATABASE_LISTEN_URL` is
configured, matching the existing direct-connection requirement for LISTEN.

Retirement takes the existing Cloud Computer org lock, withdraws readiness by
changing `ready` to `retiring`, and advances the completed build's monotonic
worker fence. It rechecks the keep-set and exact account/resource journal before
dispatch and again before publishing `retired`. Activate requires `ready`, and
C5 must accept forks and write source/in-flight references in the same transaction
under the org advisory lock and `cloud_computer_v2_heads ... FOR UPDATE` row lock,
requiring template state `ready`. This admission is owned by C5; C6 introduces
no admission code or migration. Provider
requests run outside database transactions.

The worker reuses the builder operation key `computer-build:<buildId>`. It records
`deleting` before Boat DELETE, sends `X-Ascii-Confirm-Delete` with the exact
sandbox ID and the configured `x-boat-org` wallet, and persists the returned
deletion operation ID. A sandbox 404 means already gone. A still-visible sandbox,
lost reply, mismatched receipt or missing journal remains unresolved and is
retried. `retired` means logical sandbox deletion is confirmed; this worker does
not track physical byte erasure or poll deletion-operation progress. Historical
build/configuration/commit metadata remains available for Rebuild. Retiring and
retired history cannot Activate.

Organization final erasure checks B7's operation journals across provider accounts
before deleting template, build or mutation journals. A missing sandbox ID is
not cleanup evidence: an unallocated create must be positively closed, including
every recorded create attempt. Once the durable deletion request enters
irreversible purge, retention releases active/previous/newest holds, including
staff force-purge before the original grace deadline.
Workspace-source holds remain until workspace/data cleanup is complete. A
scheduled deletion still inside its recovery window does not release templates.

## Live Alpha runbook

No live verification is performed by the implementation workspace. The operator
runs the following from a credential-bearing workspace after C3 is available.
Use C3's real builder/qualification adapters against Alpha and a fresh
local database named `zeros_v2_test_<suffix>`. Never seed ready templates into a
deployed database or fabricate protected-file evidence.

1. Run `pnpm agent:check`. The script reads `.env.agent` itself; never pass values
   on the command line. It checks the Alpha database and R2 bucket names.
2. Implement the small `openComputerTemplateRetentionAlphaFixture` factory in a
   private `.context/c6-alpha-adapter.mts`, following the exported fixture type in
   `scripts/cloud-workspace-validation/computer-template-retention-live-check.mts`.
   Reuse C3's local fixture and real `buildNext` pipeline, B7's account-scoped
   operation store, and the wallet-bound Boat client. The source workspace is
   local metadata only; no workspace allocation or engine authority is needed.
   All builder names must start with the supplied `zeros-v2-test-c6-<run>-`
   prefix. `cleanupFailedBuilds` reconciles C3's failed/uncertain allocations.
   `close` must retain the local database if cleanup is unconfirmed.
3. Run `pnpm exec tsx scripts/cloud-workspace-validation/computer-template-retention-live-check.mts --adapter .context/c6-alpha-adapter.mts --report .context/c6-alpha-retention.json`.
   This builds fourteen sanitized, stopped templates, activates older versions
   1/2, pins version 3 in the local source sidecar, and verifies that only version
   4 retires while versions 5–14 remain ready. It checks an idempotent rerun.
4. Cleanup runs in `finally`: release local source/head holds, run retention on
   the disposable org, and reconcile failed builds. The JSON report records
   build IDs, sandbox IDs, deletion operation IDs and confirmed logical deletion.
   If cleanup fails, keep the local journal and rerun the same command with
   `--cleanup`. No bases, runtime artifacts, live orgs or deployed settings are
   modified. Record the report path and resource IDs in the review evidence.

The script emits only closed success/failure diagnostics. The local Postgres
race and uncertainty suites supply concurrency coverage; the runbook does not
claim provider byte erasure, wake/recovery qualification or launch hardening.
