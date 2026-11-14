import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { WorkerRoute } from "./worker-connection.js";

/** A failure condition cannot outlive the boot and authority that observed it. */
const CURRENT = `id=$1 AND boat_sandbox_id=$2 AND worker_boot_id=$3::uuid
  AND access_epoch=$4::bigint AND worker_token_hash=decode($5,'hex')
  AND worker_route_url=$6 AND state='running' AND archived_at IS NULL
  AND worker_port_token IS NOT DISTINCT FROM $7::jsonb
  AND execution_transition_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM cloud_worker_runtime_handoffs h WHERE h.workspace_id=cloud_v2_workspaces.id
    AND h.state IN ('committed','activating','rolling_back'))`;
const binding = (route: WorkerRoute) => [route.workspace.id, route.workspace.boatSandboxId, route.bootId, route.accessEpoch, route.workerTokenHash, route.url,
  JSON.stringify(route.portToken ?? null)];

export class LiveRecoveryStore {
  constructor(private readonly pool: pg.Pool) {}
  async condition(route: WorkerRoute, unavailable: boolean): Promise<boolean> {
    const result = await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_workspaces
      SET error_code=CASE WHEN $8 THEN 'live_connection_unavailable' ELSE NULL END, updated_at=clock_timestamp()
      WHERE ${CURRENT} AND (error_code IS NULL OR error_code='live_connection_unavailable')
        AND error_code IS DISTINCT FROM CASE WHEN $8 THEN 'live_connection_unavailable' ELSE NULL END`,
    [...binding(route), unavailable]));
    return result.rowCount === 1;
  }
}
