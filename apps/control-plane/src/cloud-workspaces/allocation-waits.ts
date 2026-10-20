import type { Tx } from "../db.js";
import { CloudProviderError } from "./provider.js";

/** Private allocator evidence, not a provider response or a wire capability.
 * Mutable state (including settlement) is deliberately absent. */
export type ComputeAllocationBlocker = Readonly<{
  leaseId: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  lifecycleIntentId: string;
  userId: string;
  billingEpoch: string;
  provider: string;
  providerResourceId: string | null;
  ownerPresent: boolean;
  ownerRevision: string;
  ownerOriginalGeneration: number | null;
  ownerCurrentGeneration: number | null;
}>;

export class ComputeAllocationDependencyError extends CloudProviderError {
  readonly blocker: ComputeAllocationBlocker;
  constructor(blocker: ComputeAllocationBlocker) {
    super("compute_previous_lease_pending", "Managed compute awaits its exact previous allocation", true);
    this.blocker = Object.freeze({ ...blocker });
  }
}

/** A resolved edge remains bound through funding awaits. This is handled as
 * dependency reconciliation, never as a provider failure or a fresh scope. */
export class ComputeAllocationContinuationUnavailable extends CloudProviderError {
  constructor() { super("compute_dependency_pending", "Allocation continuation needs reconciliation", true); }
}

export type AllocationWaitScope = {
  id: string;
  workspaceId: string;
  orgId: string;
  generation: number;
  ownerUserId: string;
  billingEpoch: string;
  authorityEpoch: string;
  sourceBindingId: string | null;
  provider: string;
  providerConnectionId: string;
  providerConnectionVersion: string;
  providerResourceId: string | null;
  resumeAfterIntentId: string | null;
  attemptCount: number;
};

/** Embedded in existing intent reads after their parent lock. No edge means
 * the unchanged ordinary path; an edge stays frozen across every later await. */
export const allocationWaitContinuationLiveSql = `NOT EXISTS (
  SELECT 1 FROM cloud_workspace_lifecycle_allocation_waits wait
  WHERE wait.lifecycle_intent_id=cloud_workspace_lifecycle_intents.id
    AND (wait.state<>'resolved' OR cloud_lifecycle_allocation_wait_status(wait.lifecycle_intent_id) IS DISTINCT FROM 'ready'))`;

/** The caller chose the enabled writer after the real allocator refused.
 * Neither this transaction nor its FKs lock the monetary lease/owner. An
 * already-settled exact blocker is still published: the edge's own enqueue
 * closes settlement-before-edge, including a lost earlier notification. */
export async function parkCloudAllocationWait(
  tx: Tx, intent: AllocationWaitScope, workerId: string, blocker: ComputeAllocationBlocker,
): Promise<boolean> {
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [intent.orgId]);
  await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [intent.workspaceId, intent.orgId]);
  const row = (await tx.query<{ scope_live: boolean; has_wait: boolean }>(`SELECT
    ROW(workspace.current_generation,workspace.desired_state,workspace.deleted_at,workspace.owner_user_id,
      workspace.current_billing_epoch,workspace.authority_epoch,workspace.agent_boot_id,
      generation.provider,generation.provider_connection_id,generation.provider_connection_version,
      binding.provider,binding.provider_connection_id,binding.provider_connection_version,binding.provider_resource_id,
      intent.resume_after_intent_id)
    IS NOT DISTINCT FROM ROW($4::integer,'running'::cloud_workspace_desired_state,NULL::timestamptz,$7::uuid,
      $8::bigint,$9::bigint,$10::uuid,$11::text,$12::uuid,$13::bigint,$11::text,$12::uuid,$13::bigint,$14::text,$15::uuid) AS scope_live,
    EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_allocation_waits WHERE lifecycle_intent_id=intent.id) AS has_wait
    FROM cloud_workspace_lifecycle_intents intent
    JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id AND workspace.org_id=intent.org_id
    LEFT JOIN cloud_workspace_generations generation ON generation.workspace_id=intent.workspace_id
      AND generation.org_id=intent.org_id AND generation.generation=intent.generation
    LEFT JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=intent.workspace_id
      AND binding.org_id=intent.org_id AND binding.generation=intent.generation
    WHERE intent.id=$1 AND intent.workspace_id=$2 AND intent.org_id=$3 AND intent.generation=$4 AND intent.state='dispatching'
      AND intent.lease_owner=$5 AND intent.attempt_count=$6 AND intent.lease_expires_at>clock_timestamp() FOR UPDATE OF intent`,
  [intent.id, intent.workspaceId, intent.orgId, intent.generation, workerId, intent.attemptCount,
    intent.ownerUserId, intent.billingEpoch, intent.authorityEpoch, intent.sourceBindingId, intent.provider,
    intent.providerConnectionId, intent.providerConnectionVersion, intent.providerResourceId, intent.resumeAfterIntentId])).rows[0];
  if (!row) return true;
  if (!row.scope_live) {
    await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),
      lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1`, [intent.id]);
    return true;
  }
  if (row.has_wait) {
    await releaseCloudAllocationContinuation(tx, intent.id);
    return true;
  }
  if (blocker.workspaceId !== intent.workspaceId || blocker.organizationId !== intent.orgId || blocker.provider !== intent.provider) return false;
  const inserted = await tx.query(`INSERT INTO cloud_workspace_lifecycle_allocation_waits
      (lifecycle_intent_id,workspace_id,org_id,generation,operation,owner_user_id,billing_epoch,authority_epoch,
       source_binding_id,provider,provider_connection_id,provider_connection_version,provider_resource_id,resume_after_intent_id,
       prerequisite_operation,prerequisite_request_id,prerequisite_checkpoint_id,
       allocation_lease_id,allocation_generation,allocation_lifecycle_intent_id,allocation_user_id,allocation_billing_epoch,
       allocation_resource_id,allocation_owner_present,allocation_owner_revision,allocation_owner_original_generation,
       allocation_owner_current_generation)
    SELECT intent.id,workspace.id,workspace.org_id,intent.generation,intent.operation,workspace.owner_user_id,
      workspace.current_billing_epoch,workspace.authority_epoch,workspace.agent_boot_id,generation.provider,
      generation.provider_connection_id,generation.provider_connection_version,binding.provider_resource_id,intent.resume_after_intent_id,
      prerequisite.operation,saved.proven_request_id,saved.checkpoint_id,
      lease.id,lease.generation,lease.lifecycle_intent_id,lease.user_id,lease.billing_epoch,lease.provider_resource_id,
      owner.workspace_id IS NOT NULL,coalesce(owner.revision,0),owner.original_generation,owner.current_generation
    FROM cloud_workspace_lifecycle_intents intent
    JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id AND workspace.org_id=intent.org_id
    JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id
      AND generation.generation=intent.generation
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=generation.workspace_id
      AND binding.org_id=generation.org_id AND binding.generation=generation.generation
    JOIN managed_compute_allocation_leases lease ON lease.id=$16 AND lease.workspace_id=workspace.id AND lease.org_id=workspace.org_id
    JOIN cloud_workspace_generations original ON original.workspace_id=lease.workspace_id AND original.org_id=lease.org_id
      AND original.generation=lease.generation AND original.provider=lease.provider
      AND original.provider_connection_id=generation.provider_connection_id
      AND original.provider_connection_version=generation.provider_connection_version
    LEFT JOIN cloud_workspace_allocation_owners owner ON owner.workspace_id=lease.workspace_id AND owner.org_id=lease.org_id
      AND owner.provider_resource_id=lease.provider_resource_id
    LEFT JOIN cloud_workspace_lifecycle_intents prerequisite ON prerequisite.id=intent.resume_after_intent_id
      AND prerequisite.workspace_id=workspace.id AND prerequisite.org_id=workspace.org_id AND prerequisite.generation=intent.generation
    LEFT JOIN cloud_workspace_final_save_recoveries saved ON saved.lifecycle_intent_id=prerequisite.id
      AND saved.workspace_id=workspace.id AND saved.org_id=workspace.org_id AND saved.generation=intent.generation
      AND prerequisite.operation IN ('stop','archive','delete')
    WHERE intent.id=$1 AND intent.workspace_id=$2 AND intent.org_id=$3 AND intent.generation=$4
      AND intent.operation IN ('create','wake') AND intent.state='dispatching'
      AND intent.lease_owner=$5 AND intent.attempt_count=$6 AND intent.lease_expires_at>clock_timestamp()
      AND workspace.current_generation=$4 AND workspace.desired_state='running' AND workspace.deleted_at IS NULL
      AND workspace.owner_user_id=$7 AND workspace.current_billing_epoch=$8 AND workspace.authority_epoch=$9
      AND workspace.agent_boot_id IS NOT DISTINCT FROM $10::uuid
      AND generation.provider=$11 AND generation.provider_connection_id=$12 AND generation.provider_connection_version=$13
      AND binding.provider=generation.provider AND binding.provider_connection_id=generation.provider_connection_id
      AND binding.provider_connection_version=generation.provider_connection_version
      AND binding.provider_resource_id IS NOT DISTINCT FROM $14::text
      AND intent.resume_after_intent_id IS NOT DISTINCT FROM $15::uuid
      AND (intent.resume_after_intent_id IS NULL OR (prerequisite.state='succeeded'
        AND (prerequisite.operation NOT IN ('stop','archive','delete') OR (cloud_final_save_proven(prerequisite.id)
          AND saved.proven_request_id IS NOT NULL AND saved.checkpoint_id IS NOT NULL
          AND saved.allocation_lease_id=lease.id AND saved.provider_resource_id=binding.provider_resource_id))))
      AND lease.generation=$17 AND lease.lifecycle_intent_id=$18 AND lease.user_id=$19 AND lease.billing_epoch=$20
      AND lease.provider=$11 AND lease.provider_resource_id IS NOT DISTINCT FROM $21::text
      AND (owner.workspace_id IS NOT NULL)=$22 AND coalesce(owner.revision,0)=$23
      AND owner.original_generation IS NOT DISTINCT FROM $24::integer
      AND owner.current_generation IS NOT DISTINCT FROM $25::integer
      AND ((owner.workspace_id IS NULL AND lease.generation=$4)
        OR (owner.allocation_lease_id=lease.id AND owner.current_generation=$4))
    ON CONFLICT (lifecycle_intent_id) DO NOTHING RETURNING lifecycle_intent_id`,
  [intent.id, intent.workspaceId, intent.orgId, intent.generation, workerId, intent.attemptCount,
    intent.ownerUserId, intent.billingEpoch, intent.authorityEpoch, intent.sourceBindingId, intent.provider,
    intent.providerConnectionId, intent.providerConnectionVersion, intent.providerResourceId, intent.resumeAfterIntentId,
    blocker.leaseId, blocker.generation, blocker.lifecycleIntentId, blocker.userId, blocker.billingEpoch,
    blocker.providerResourceId, blocker.ownerPresent, blocker.ownerRevision, blocker.ownerOriginalGeneration, blocker.ownerCurrentGeneration]);
  // Missing positive blocker evidence preserves the ordinary allocator retry.
  // Scope changes were handled above, separately from an incomplete identity.
  if (!inserted.rowCount) return false;
  await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='observing',
    lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=now()
    WHERE id=$1 AND state='dispatching' AND lease_owner=$2 AND attempt_count=$3`,
  [intent.id, workerId, intent.attemptCount]);
  return true;
}

/** Caller holds the intent and its workspace. The claim SELECT discovers
 * eligible edges in its existing query; unchanged pending edges never enter
 * this method, hold a worker, or acquire a recurring due timer. */
export async function resolveCloudAllocationWait(tx: Tx, intentId: string): Promise<"ready" | "pending" | "retired"> {
  const row = (await tx.query<{ state: string; status: "ready" | "pending" | "invalid" }>(
    `SELECT state,cloud_lifecycle_allocation_wait_status(lifecycle_intent_id) AS status
     FROM cloud_workspace_lifecycle_allocation_waits WHERE lifecycle_intent_id=$1 FOR UPDATE`, [intentId])).rows[0];
  if (!row || row.status === "pending") return "pending";
  if (row.status === "ready") {
    if (row.state === "pending") await tx.query(`UPDATE cloud_workspace_lifecycle_allocation_waits
      SET state='resolved',resolved_at=clock_timestamp() WHERE lifecycle_intent_id=$1 AND state='pending'`, [intentId]);
    return "ready";
  }
  await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),
    lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,updated_at=now()
    WHERE id=$1 AND state IN ('queued','observing','dispatching')`, [intentId]);
  return "retired";
}

/** Caller holds the workspace and exact owned intent. An invalid or no-longer
 * ready result cannot publish provider metadata, setup or a workspace error. */
export async function releaseCloudAllocationContinuation(tx: Tx, intentId: string): Promise<void> {
  if (await resolveCloudAllocationWait(tx, intentId) === "retired") return;
  await tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='observing',lease_owner=NULL,lease_expires_at=NULL,
    error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1`, [intentId]);
}

export async function reconcileCloudAllocationContinuation(tx: Tx, intent: AllocationWaitScope, workerId: string): Promise<void> {
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [intent.orgId]);
  await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [intent.workspaceId, intent.orgId]);
  const owned = await tx.query(`SELECT id FROM cloud_workspace_lifecycle_intents WHERE id=$1
    AND workspace_id=$2 AND org_id=$3 AND state='dispatching' AND lease_owner=$4
    AND attempt_count=$5 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
  [intent.id, intent.workspaceId, intent.orgId, workerId, intent.attemptCount]);
  if (owned.rowCount) await releaseCloudAllocationContinuation(tx, intent.id);
}
