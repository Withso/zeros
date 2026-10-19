import type { Tx } from "../db.js";
import { CLOUD_COORDINATOR_READINESS_MS, CloudCoordinatorStatusSchema, type CloudCoordinatorStatus } from "./coordinator-contract.js";

type Scope = { workspaceId: string; organizationId: string; generation: number; engineInstanceId: string };

/** Additional final interactive fence, never an execution-authority proof.
 * The caller retains its existing authority checks and lock discipline. */
export async function cloudEngineInteractive(tx: Tx, scope: Scope): Promise<boolean> {
  return !!(await tx.query(`SELECT 1 FROM cloud_workspace_engine_instances engine
    WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4
      AND cloud_workspace_engine_interactive_live(engine)`,
    [scope.engineInstanceId, scope.workspaceId, scope.organizationId, scope.generation])).rowCount;
}

/** Both authenticated transports use the same ordered, exact-owner report.
 * receivedAtMs is captured before any pool/lock wait. Delivery or retries must
 * never mint fresh time for an old frontend observation. Locks: workspace,
 * engine, then catalog version (already locked); never uplink -> workspace. */
export async function recordCloudCoordinatorReadiness(tx: Tx, scope: Scope, report: CloudCoordinatorStatus,
  receivedAtMs: number): Promise<boolean> {
  if (!CloudCoordinatorStatusSchema.safeParse(report).success || !Number.isSafeInteger(receivedAtMs)) return false;
  const workspace = await tx.query(`SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2
    AND current_generation=$3 AND desired_state='running' AND deleted_at IS NULL FOR UPDATE`,
  [scope.workspaceId, scope.organizationId, scope.generation]);
  if (!workspace.rowCount) return false;
  const current = (await tx.query<{ frontend: string | null; deadline: Date | null; live: boolean }>(
    `SELECT interactive_frontend_id AS frontend,interactive_ready_until AS deadline,
       cloud_workspace_engine_interactive_live(engine) AS live
     FROM cloud_workspace_engine_instances engine
     WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND runtime_boot_id=$5 AND coordinator_version=1
       AND state='ready' AND revoked_at IS NULL AND lease_expires_at>clock_timestamp() AND interactive_revision<$6
     FOR UPDATE`, [scope.engineInstanceId, scope.workspaceId, scope.organizationId, scope.generation, report.bootId, report.revision])).rows[0];
  if (!current) return false;
  const deadline = report.ready ? Math.min(report.expiresAtMs, receivedAtMs + CLOUD_COORDINATOR_READINESS_MS) : 0;
  const updated = (await tx.query<{ live: boolean; deadline: Date | null }>(
    `UPDATE cloud_workspace_engine_instances engine SET interactive_revision=$2,interactive_frontend_id=$3,
       interactive_ready_until=CASE WHEN to_timestamp($4::double precision/1000)>clock_timestamp()
         THEN to_timestamp($4::double precision/1000) END
     WHERE id=$1 RETURNING cloud_workspace_engine_interactive_live(engine) AS live,interactive_ready_until AS deadline`,
    [scope.engineInstanceId, report.revision, report.frontendId, deadline])).rows[0]!;
  if (current.live !== updated.live || current.frontend !== report.frontendId ||
      current.deadline !== null && updated.deadline === null) {
    await tx.query("UPDATE cloud_workspaces SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND org_id=$2",
      [scope.workspaceId, scope.organizationId]);
  }
  return true;
}

/** A missed notification expires only the interactive projection. It cannot
 * stop accepted work, shorten the owner lease or admit a lifecycle intent. */
export async function expireCloudCoordinatorReadiness(tx: Tx, workspaceId: string): Promise<boolean> {
  const workspace = (await tx.query<{ org_id: string; current_generation: number }>(
    "SELECT org_id,current_generation FROM cloud_workspaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE SKIP LOCKED", [workspaceId])).rows[0];
  if (!workspace) return false;
  const expired = await tx.query(`UPDATE cloud_workspace_engine_instances SET interactive_ready_until=NULL
    WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND coordinator_version=1
      AND interactive_ready_until<=clock_timestamp()`, [workspaceId, workspace.org_id, workspace.current_generation]);
  if (expired.rowCount) await tx.query("UPDATE cloud_workspaces SET version=version+1,updated_at=clock_timestamp() WHERE id=$1", [workspaceId]);
  return !!expired.rowCount;
}
