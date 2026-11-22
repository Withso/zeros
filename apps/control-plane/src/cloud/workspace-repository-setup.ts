// A repository after the first of a workspace of several reports its own
// setup status (workspace-repositories-v1). The first repository's stays the
// workspace's own `setup_status`, reported through POST setup as before.
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { HttpError } from "../authz.js";
import { RUNTIME_HANDOFF_SESSION } from "./runtime-handoff-store.js";
import type { CloudV2SetupStatus } from "./setup-status-contract.js";
import { hashCloudV2Token } from "./tokens.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";

export type RepositorySetupReport = (token: string, bootId: string, repository: string, value: CloudV2SetupStatus,
  proof: { accessEpoch: string; handoff?: string }) => Promise<void>;

/** Under the same authority as the workspace's own report (token, boot or handoff,
 * access epoch, live access), and only for one of this workspace's repositories
 * after the first. An older report never replaces a newer one. */
export function repositorySetupReports(pool: pg.Pool): RepositorySetupReport {
  return (token, bootId, repository, value, proof) => withSystemTx(pool, async tx => {
    const hash = hashCloudV2Token(token);
    await tx.query("SELECT id FROM cloud_v2_workspaces WHERE worker_token_hash=$1 FOR UPDATE", [hash]);
    const workspace = (await tx.query<{ id: string }>(
      `SELECT id FROM cloud_v2_workspaces w WHERE worker_token_hash=$1
        AND (CASE WHEN $3::uuid IS NULL THEN worker_boot_id=$2 ELSE ${RUNTIME_HANDOFF_SESSION} END)
        AND access_epoch=$5::bigint AND state IN ('creating','starting','running','stopping') AND ${CLOUD_V2_LIVE_ACCESS}`,
      [hash, bootId, proof.handoff ?? null, null, proof.accessEpoch])).rows[0];
    if (!workspace) throw new HttpError(401, "worker_boot_changed", "Worker authorization changed");
    const row = (await tx.query<{ position: number; setup_status: CloudV2SetupStatus | null }>(
      `SELECT position, setup_status FROM cloud_v2_workspace_repositories
        WHERE workspace_id=$1 AND position > 0 AND lower(repository)=lower($2) FOR UPDATE`, [workspace.id, repository])).rows[0];
    if (!row) throw new HttpError(404, "not_found", "This repository is not part of this workspace.");
    const previous = row.setup_status;
    if (previous && (value.startedAt < previous.startedAt || (value.startedAt === previous.startedAt && previous.state !== "running"))) return;
    // Reports are not activity: the workspace row is left as it is.
    await tx.query(`UPDATE cloud_v2_workspace_repositories SET setup_status=$3
      WHERE workspace_id=$1 AND position=$2 AND setup_status IS DISTINCT FROM $3::jsonb`, [workspace.id, row.position, JSON.stringify(value)]);
  });
}
