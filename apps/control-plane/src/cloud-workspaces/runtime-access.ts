import type { Tx } from "../db.js";

export type CloudWorkspaceRuntimeRetirementReason =
  | "workspace_stop_requested"
  | "workspace_archive_requested"
  | "workspace_delete_requested"
  | "provider_not_running"
  | "lifecycle_superseded"
  | "generation_superseded"
  | "generation_replacement_requested"
  | "generation_candidate_rejected"
  | "generation_replaced"
  | "provider_operation_failed"
  | "setup_failed";

export type RetiredCloudWorkspaceRuntimeAccess = {
  revokedGrantCount: number;
  revocationPendingClientAccessCount: number;
  cancelledSetupRunCount: number;
  revokedEngineInstanceCount: number;
};

export async function retireCloudWorkspaceEngineInstances(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation?: number;
    exceptInstanceId?: string;
  },
): Promise<number> {
  const retired = await tx.query(
    `UPDATE cloud_workspace_engine_instances
     SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
         updated_at = now()
     WHERE workspace_id = $1 AND org_id = $2
       AND ($3::integer IS NULL OR generation = $3)
       AND ($4::uuid IS NULL OR id <> $4)
       AND state IN ('starting', 'ready')`,
    [
      input.workspaceId,
      input.organizationId,
      input.generation ?? null,
      input.exceptInstanceId ?? null,
    ],
  );
  return retired.rowCount ?? 0;
}

/**
 * Revoke execution capabilities before cancelling work that could still use
 * them. Callers must already hold the workspace row lock in a system
 * transaction so retirement is ordered with the lifecycle decision.
 */
export async function retireCloudWorkspaceRuntimeAccess(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation?: number;
    reason: CloudWorkspaceRuntimeRetirementReason;
  },
): Promise<RetiredCloudWorkspaceRuntimeAccess> {
  const generation = input.generation ?? null;
  // Membership and scope retirement use client access -> endpoint grant ->
  // engine order. Keep lifecycle retirement in the same order so a stop/delete
  // racing a membership loss cannot hold an endpoint row while waiting for the
  // membership transaction's client-access row.
  const pendingClientAccess = await tx.query(
    `UPDATE cloud_workspace_client_access_grants
     SET state = 'revocation_pending', revocation_reason = $4,
         next_revocation_at = now(), updated_at = now()
     WHERE workspace_id = $1 AND org_id = $2
       AND ($3::integer IS NULL OR generation = $3)
       AND state IN ('issuing', 'active')`,
    [input.workspaceId, input.organizationId, generation, input.reason],
  );
  const revoked = await tx.query(
    `UPDATE cloud_workspace_endpoint_grants
     SET revoked_at = now()
     WHERE workspace_id = $1 AND org_id = $2
       AND ($3::integer IS NULL OR generation = $3)
       AND revoked_at IS NULL`,
    [input.workspaceId, input.organizationId, generation],
  );
  const cancelled = await tx.query(
    `UPDATE cloud_workspace_setup_runs
     SET state = 'cancelled', completed_at = now(), updated_at = now(),
         error_code = coalesce(error_code, $4), lease_owner = NULL,
         lease_expires_at = NULL
     WHERE workspace_id = $1 AND org_id = $2
       AND ($3::integer IS NULL OR generation = $3)
       AND state IN ('queued', 'running')`,
    [input.workspaceId, input.organizationId, generation, input.reason],
  );
  const revokedEngineInstanceCount = await retireCloudWorkspaceEngineInstances(
    tx,
    input,
  );
  return {
    revokedGrantCount: revoked.rowCount ?? 0,
    revocationPendingClientAccessCount: pendingClientAccess.rowCount ?? 0,
    cancelledSetupRunCount: cancelled.rowCount ?? 0,
    revokedEngineInstanceCount,
  };
}

/** Publish proof that provider-side SSH access is gone. Preview grants need no
 * provider revocation because the Zeros proxy verifier is the only authority. */
export async function confirmCloudWorkspaceClientAccessRevoked(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
  },
): Promise<number> {
  const confirmed = await tx.query(
    `UPDATE cloud_workspace_client_access_grants
     SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
         revocation_lease_owner = NULL,
         revocation_lease_expires_at = NULL, updated_at = now()
     WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
       AND state = 'revocation_pending'`,
    [input.workspaceId, input.organizationId, input.generation],
  );
  return confirmed.rowCount ?? 0;
}

/**
 * Queue at most one active setup verification for a generation. Callers hold
 * the workspace row lock, which serializes attempt allocation across replicas.
 */
export async function queueCloudWorkspaceSetupVerification(
  tx: Tx,
  input: {
    workspaceId: string;
    generation: number;
    organizationId: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO cloud_workspace_setup_runs (
       workspace_id, generation, org_id, attempt
     )
     SELECT $1, $2, $3, coalesce(max(sr.attempt), 0) + 1
     FROM cloud_workspace_setup_runs sr
     WHERE sr.workspace_id = $1 AND sr.generation = $2 AND sr.org_id = $3
     HAVING count(*) FILTER (
       WHERE sr.state IN ('queued', 'running')
     ) = 0
     ON CONFLICT (workspace_id, generation, attempt) DO NOTHING`,
    [input.workspaceId, input.generation, input.organizationId],
  );
}
