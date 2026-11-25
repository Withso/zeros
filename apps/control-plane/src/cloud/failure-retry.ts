/** Failures that recovery can get past: the boot deadline, the runtime download, Boat's transient replies and a live
 * connection that did not come back (lifecycle.ts, recovery). A failed restore counts only while its checkpoint
 * remains. Everything else needs a person or a new workspace: a lost machine with no backup (sandbox_missing), GitHub
 * or source access, billing, a damaged checkpoint, a first boot that was not clean. */
export const CLOUD_V2_RECOVERABLE_FAILURES: ReadonlySet<string> = new Set([
  "worker_boot_timeout", "worker_runtime_install_failed",
  "provider_request_failed", "provider_request_timeout", "provider_request_unavailable", "provider_rate_limited",
  "provider_response_invalid", "provider_route_invalid", "provider_loss_unconfirmed",
  "live_connection_unavailable", "checkpoint_restore_failed",
]);

type FailureRow = {
  state: string; error_code: string | null; running_at?: Date | null; boat_sandbox_id: string | null;
  checkpoint_object?: string | null;
};

/** Failed for a recoverable reason after it had run (a create that never reached running may lack its checkout and
 * setup), with its machine or a backup to restore left. Pure: callers decide on a row they hold locked. */
export function cloudV2RecoverableFailure(row: FailureRow): boolean {
  // running_at, not activity: queueing a create's first message sets active_at before any worker starts.
  if (row.state !== "failed" || !row.error_code || !CLOUD_V2_RECOVERABLE_FAILURES.has(row.error_code) || !row.running_at) return false;
  const backup = !!row.checkpoint_object;
  if (row.error_code === "checkpoint_restore_failed") return backup;
  // Loss evidence is not checked: it can describe a VM this workspace has since replaced, and the start itself rebuilds
  // a lost machine where it can or ends sandbox_missing, which is not recoverable.
  return !!row.boat_sandbox_id || backup;
}

const CODES = [...CLOUD_V2_RECOVERABLE_FAILURES].map(code => { if (!/^[a-z0-9_]+$/.test(code)) throw new Error("Invalid failure code"); return `'${code}'`; }).join(",");

/** cloudV2RecoverableFailure as an SQL condition on the cloud_v2_workspaces row `alias`, for scans that must apply it
 * before their LIMIT (failure-retry.integration.test.ts holds the two to the same answers). */
export function cloudV2RecoverableFailureSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("Invalid alias");
  const w = alias;
  return `coalesce(${w}.state='failed' AND ${w}.error_code IN (${CODES}) AND ${w}.running_at IS NOT NULL
    AND (${w}.checkpoint_object IS NOT NULL OR (${w}.error_code<>'checkpoint_restore_failed' AND ${w}.boat_sandbox_id IS NOT NULL)), false)`;
}
