import type { Tx } from "../db.js";
/** Organization cleanup inventory, independent of the workspace catalog. Disk
 * remains reserved until the exact binding has physical-deletion evidence. */
export async function readPendingDeletionCapacity(tx: Tx, organizationId: string) {
  const rows = (await tx.query<{ workspace_id:string; generation:number; stage:string; state:string; requested_at:Date; progress_at:Date;
    next_attempt_at:Date|null; age_seconds:number; stalled_seconds:number; cpu_millicores:number; memory_mib:number; storage_mib:number }>(`
    SELECT generation.workspace_id,generation.generation,
      coalesce(operation.deletion_stage,CASE WHEN operation.deletion_operation_id IS NOT NULL THEN 'receipt' WHEN operation.deletion_requested_at IS NOT NULL THEN 'requested' ELSE 'settling_compute' END) AS stage,
      coalesce(intent.state,'observing') AS state,
      least(intent.created_at,operation.deletion_requested_at) AS requested_at,
      coalesce(operation.deletion_progress_at,operation.deletion_requested_at,intent.created_at) AS progress_at,
      intent.next_attempt_at,
      greatest(0,extract(epoch FROM clock_timestamp()-least(intent.created_at,operation.deletion_requested_at)))::int AS age_seconds,
      greatest(0,extract(epoch FROM clock_timestamp()-coalesce(operation.deletion_progress_at,operation.deletion_requested_at,intent.created_at)))::int AS stalled_seconds,
      CASE WHEN binding.observed_state IN ('stopped','archived','deleted') THEN 0 ELSE generation.cpu_millicores END AS cpu_millicores,
      CASE WHEN binding.observed_state IN ('stopped','archived','deleted') THEN 0 ELSE generation.memory_mib END AS memory_mib,
      generation.storage_mib
    FROM cloud_workspace_generations generation
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=generation.workspace_id AND binding.org_id=generation.org_id AND binding.generation=generation.generation
    LEFT JOIN cloud_workspace_provider_operations operation ON operation.workspace_id=generation.workspace_id AND operation.generation=generation.generation AND operation.org_id=generation.org_id
    LEFT JOIN LATERAL (SELECT state,created_at,next_attempt_at FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=generation.workspace_id AND org_id=generation.org_id AND generation=generation.generation AND operation='delete'
        AND state IN ('queued','dispatching','observing','failed') ORDER BY created_at LIMIT 1) intent ON true
    WHERE generation.org_id=$1 AND binding.deletion_verified_at IS NULL AND binding.provider_resource_id IS NOT NULL
      AND (intent.created_at IS NOT NULL OR (operation.deletion_requested_at IS NOT NULL AND operation.deleted_at IS NULL))
    ORDER BY requested_at,generation.workspace_id,generation.generation LIMIT 501`, [organizationId])).rows;
  return { truncated: rows.length>500, pendingDeletion: rows.slice(0,500).map(row=>({ workspaceId:row.workspace_id,generation:row.generation,stage:row.stage,
    state:row.state,requestedAt:row.requested_at.toISOString(),lastProgressAt:row.progress_at.toISOString(),ageSeconds:row.age_seconds,
    stalledSeconds:row.stalled_seconds,nextRetryAt:row.next_attempt_at?.toISOString()??null,
    reserved:{cpuMillicores:row.cpu_millicores,memoryMiB:row.memory_mib,storageMiB:row.storage_mib} })) };
}
