import type { Tx } from "../db.js";

/** Additional server-side evidence, under the workspace lock. Engine-local
 * process and interaction checks are necessary too; a quiet database alone
 * says nothing about a detached shell or native provider process. */
export async function cloudWorkspaceHasActiveWork(tx: Tx, scope: { workspaceId: string; organizationId: string; generation: number; allowQueuedForStoppedWake?: boolean }): Promise<boolean> {
  const result = await tx.query<{ busy: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM cloud_workspace_commands command
      LEFT JOIN cloud_workspace_conversation_controls control ON control.workspace_id=command.workspace_id
        AND control.org_id=command.org_id AND control.conversation_id=command.conversation_id
      WHERE command.workspace_id=$1 AND command.org_id=$2
        AND (command.state='dispatching' OR (NOT $4::boolean AND command.state='queued' AND NOT coalesce(control.paused,false))))
    OR EXISTS(SELECT 1 FROM cloud_agent_execution_leases WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND released_at IS NULL AND expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM cloud_workspace_runtime_service_grants WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()
      AND NOT (kind='tunnel' AND idempotency_key ~ '^desktop:auto-tunnel:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))
    OR EXISTS(SELECT 1 FROM cloud_github_write_grants WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND lease_expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM cloud_computer_builds WHERE workspace_id=$1 AND org_id=$2 AND state='building') AS busy`,
  [scope.workspaceId, scope.organizationId, scope.generation, scope.allowQueuedForStoppedWake === true]);
  return result.rows[0]?.busy !== false;
}
