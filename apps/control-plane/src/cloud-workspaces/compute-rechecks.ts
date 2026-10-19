import type { Tx } from "../db.js";
import type { CloudProviderResource } from "./provider.js";

type ObservationScope = {
  workspaceId: string;
  organizationId: string;
  generation: number;
  provider: string;
  providerConnectionId: string;
  providerConnectionVersion: string;
  providerResourceId: string | null;
  allocationLeaseId: string | null;
};

/** Captured in the existing claim SELECT (binding alias pb), before provider
 * I/O. Resource and generation alone can be reused by a later allocation. */
export const computeObservationAllocationIdSql = `(SELECT lease.id
  FROM managed_compute_allocation_leases lease
  JOIN cloud_workspace_generations original ON original.workspace_id=lease.workspace_id AND original.org_id=lease.org_id
    AND original.generation=lease.generation AND original.provider=lease.provider
    AND original.provider_connection_id=pb.provider_connection_id
    AND original.provider_connection_version=pb.provider_connection_version
  LEFT JOIN cloud_workspace_allocation_owners owner ON owner.workspace_id=lease.workspace_id AND owner.org_id=lease.org_id
    AND owner.provider_resource_id=lease.provider_resource_id
  WHERE lease.workspace_id=pb.workspace_id AND lease.org_id=pb.org_id AND lease.provider=pb.provider
    AND lease.provider_resource_id=pb.provider_resource_id AND lease.state<>'settled'
    AND ((owner.workspace_id IS NULL AND lease.generation=pb.generation)
      OR (owner.allocation_lease_id=lease.id AND owner.current_generation=pb.generation)))`;

/** Caller already accepted the observation under its workspace/binding and
 * claim fences. Call before replacing the binding so a late result cannot
 * signal a replacement resource. Never lock the lease from this transaction.
 * The provider adapter has mapped original labels through allocation owners;
 * the monetary lease and its original generation remain unchanged. */
export async function requestComputeObservationRecheck(
  tx: Tx, scope: ObservationScope, resource: CloudProviderResource | null,
): Promise<void> {
  if (!scope.allocationLeaseId || !resource || resource.workspaceId !== scope.workspaceId || resource.generation !== scope.generation ||
      (scope.providerResourceId !== null && resource.resourceId !== scope.providerResourceId)) return;
  const stopped = resource.state === "stopped" || resource.state === "archived" || resource.computeStopped === true;
  await tx.query(`INSERT INTO cloud_workspace_compute_rechecks AS request
      (allocation_lease_id,workspace_id,org_id,generation,owner_revision,observed_stopped,requested_sequence)
    SELECT lease.id,lease.workspace_id,lease.org_id,binding.generation,coalesce(owner.revision,0),$8::boolean,CASE WHEN $8 THEN 1 ELSE 0 END
    FROM cloud_workspace_provider_bindings binding
    JOIN cloud_workspace_generations current ON current.workspace_id=binding.workspace_id AND current.org_id=binding.org_id
      AND current.generation=binding.generation AND current.provider=binding.provider
      AND current.provider_connection_id=binding.provider_connection_id
      AND current.provider_connection_version=binding.provider_connection_version
    JOIN managed_compute_allocation_leases lease ON lease.workspace_id=binding.workspace_id AND lease.org_id=binding.org_id
      AND lease.id=$10 AND lease.provider=binding.provider AND lease.provider_resource_id=$7 AND lease.state<>'settled'
    JOIN cloud_workspace_generations original ON original.workspace_id=lease.workspace_id AND original.org_id=lease.org_id
      AND original.generation=lease.generation AND original.provider=lease.provider
      AND original.provider_connection_id=current.provider_connection_id
      AND original.provider_connection_version=current.provider_connection_version
    LEFT JOIN cloud_workspace_allocation_owners owner ON owner.workspace_id=lease.workspace_id AND owner.org_id=lease.org_id
      AND owner.provider_resource_id=lease.provider_resource_id
    WHERE binding.workspace_id=$1 AND binding.org_id=$2 AND binding.generation=$3 AND binding.provider=$4
      AND binding.provider_connection_id=$5 AND binding.provider_connection_version=$6
      AND binding.provider_resource_id IS NOT DISTINCT FROM $9::text
      AND ((owner.workspace_id IS NULL AND lease.generation=binding.generation)
        OR (owner.allocation_lease_id=lease.id AND owner.current_generation=binding.generation))
      AND ($8 OR EXISTS (SELECT 1 FROM cloud_workspace_compute_rechecks WHERE allocation_lease_id=lease.id))
    ON CONFLICT (allocation_lease_id) DO UPDATE SET
      generation=EXCLUDED.generation,owner_revision=EXCLUDED.owner_revision,observed_stopped=EXCLUDED.observed_stopped,
      requested_sequence=request.requested_sequence+CASE WHEN EXCLUDED.observed_stopped THEN 1 ELSE 0 END,
      requested_at=CASE WHEN EXCLUDED.observed_stopped THEN clock_timestamp() ELSE request.requested_at END
    WHERE request.workspace_id=EXCLUDED.workspace_id AND request.org_id=EXCLUDED.org_id
      AND (request.observed_stopped IS DISTINCT FROM EXCLUDED.observed_stopped
        OR request.generation<>EXCLUDED.generation OR request.owner_revision<>EXCLUDED.owner_revision)`,
  [scope.workspaceId, scope.organizationId, scope.generation, scope.provider, scope.providerConnectionId,
    scope.providerConnectionVersion, resource.resourceId, stopped, scope.providerResourceId, scope.allocationLeaseId]);
}

/** Use the identical eligibility in the claim and durable-job recovery paths.
 * Existing error retries and independent stopped-meter checks remain floors,
 * including schedules written by an old worker. A pending hint survives them.
 * The caller separately fences active worker leases and runtime transitions. */
export const computeLeaseDueAtSql = `CASE
  WHEN lease.first_error_at IS NOT NULL THEN lease.next_check_at
  ELSE least(lease.next_check_at,(SELECT greatest(request.requested_at,lease.stopped_observed_at+interval '6 seconds')
    FROM cloud_workspace_compute_rechecks request
    WHERE request.allocation_lease_id=lease.id AND request.workspace_id=lease.workspace_id AND request.org_id=lease.org_id
      AND request.generation=coalesce((SELECT current_generation FROM cloud_workspace_allocation_owners
        WHERE allocation_lease_id=lease.id),lease.generation)
      AND request.owner_revision=coalesce((SELECT revision FROM cloud_workspace_allocation_owners
        WHERE allocation_lease_id=lease.id),0)
      AND request.requested_sequence>request.handled_sequence)) END`;
