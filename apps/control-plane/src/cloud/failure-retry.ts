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
  state: string; error_code: string | null; active_at: Date | null; boat_sandbox_id: string | null;
  checkpoint_object?: string | null; machine_gone_at?: Date | null; machine_data_expired_at?: Date | null;
};

/** Failed for a recoverable reason after it had run (a create that never reached running may lack its checkout and
 * setup), with its machine or a backup to restore left. Pure: callers decide on a row they hold locked. */
export function cloudV2RecoverableFailure(row: FailureRow): boolean {
  if (row.state !== "failed" || !row.error_code || !CLOUD_V2_RECOVERABLE_FAILURES.has(row.error_code) || !row.active_at) return false;
  const backup = !!row.checkpoint_object;
  if (row.error_code === "checkpoint_restore_failed") return backup;
  return (!!row.boat_sandbox_id && !row.machine_gone_at && !row.machine_data_expired_at) || backup;
}
