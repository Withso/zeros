import { createHash } from "node:crypto";
import type pg from "pg";

import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { authorizeCloudWorkspaceCleanup } from "./actors.js";
import { CloudWorkspaceDeletionRetirementSchema, type CloudWorkspaceDeletionRetirement } from "./deletion-retirement-contract.js";
import { CloudProviderError, type CloudProviderDeletionRetirement } from "./provider.js";
import type { CloudWorkspaceProviderResolver } from "./provider-resolver.js";

type Scope = { organizationId: string; workspaceId: string; actorUserId: string; generation: number; deleteIdempotencyKey: string };
type Workspace = {
  owner_user_id: string; created_by: string; repository_id: string; display_name: string;
  current_generation: number; version: string; authority_epoch: string; desired_state: string; status: string;
  created_at: string; deleted_at: string | null; data_deleted_at: string | null;
  intent_id: string | null; intent_generation: number | null; intent_state: string | null;
  requested_by: string | null; requested_at: string | null; affects_workspace: boolean | null;
  job_id: string | null; job_state: string | null; job_key: string | null; job_error: string | null;
  compute_settled: boolean; access_retired: boolean; generations_fenced: boolean; journal_complete: boolean;
};
type Generation = {
  generation: number; provider: string; sandbox_class: string | null; storage_mib: number;
  provider_connection_id: string; provider_connection_version: string; credential_source: string;
  observed_state: string | null; provider_resource_id: string | null; deletion_verified_at: string | null;
  account_scope: string | null; operation_generation: number | null; resource_id: string | null;
  create_key: string | null; request_sha256: string | null; create_attempts_tracked: boolean | null;
  create_closed_at: string | null; create_uncertain: boolean; lost_at: string | null;
  deletion_operation_id: string | null; deletion_requested_at: string | null; deleted_at: string | null;
  original_generation: number | null;
};

const unconfirmed = () => new HttpError(409, "cloud_workspace_retirement_unconfirmed", "Cloud workspace retirement is not confirmed");
const iso = (value: string) => new Date(value).toISOString();
const reserved = (storageMiB: number) => ({ cpuMillicores: 0 as const, memoryMiB: 0 as const, storageMiB });

/** No writes or retained capability: the harness authenticates this observation
 * with its own signed run, then reads it again before allocating. Provider I/O
 * owns no database client; the second locked snapshot must still match. */
export class DatabaseCloudWorkspaceDeletionRetirement {
  constructor(private readonly pool: pg.Pool, private readonly providers: CloudWorkspaceProviderResolver | null) {}

  private async snapshot(input: Scope) {
    return withSystemTx(this.pool, async tx => {
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [input.organizationId]);
      const workspace = (await tx.query<Workspace>(`SELECT
        w.owner_user_id,w.created_by,w.repository_id,w.display_name,w.current_generation,w.version::text,w.authority_epoch::text,
        w.desired_state,w.status,w.created_at::text,w.deleted_at::text,w.data_deleted_at::text,
        intent.id AS intent_id,intent.generation AS intent_generation,intent.state AS intent_state,
        intent.requested_by,intent.created_at::text AS requested_at,intent.affects_workspace,
        job.id AS job_id,job.state AS job_state,job.idempotency_key AS job_key,job.error_code AS job_error,
        NOT EXISTS(SELECT 1 FROM managed_compute_allocation_leases l WHERE l.workspace_id=w.id AND l.org_id=w.org_id AND l.state<>'settled')
          AND NOT EXISTS(SELECT 1 FROM managed_compute_credit_reservations r WHERE r.workspace_id=w.id AND r.org_id=w.org_id AND r.state='open') AS compute_settled,
        NOT EXISTS(SELECT 1 FROM cloud_workspace_engine_instances e WHERE e.workspace_id=w.id AND e.org_id=w.org_id AND e.revoked_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_endpoint_grants g WHERE g.workspace_id=w.id AND g.org_id=w.org_id AND g.revoked_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_runtime_service_grants g WHERE g.workspace_id=w.id AND g.org_id=w.org_id AND g.revoked_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_client_access_grants g WHERE g.workspace_id=w.id AND g.org_id=w.org_id AND g.state<>'revoked') AS access_retired,
        NOT EXISTS(SELECT 1 FROM cloud_workspace_setup_runs r WHERE r.workspace_id=w.id AND r.org_id=w.org_id AND r.state IN ('queued','running'))
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents i WHERE i.workspace_id=w.id AND i.org_id=w.org_id
            AND i.operation<>'delete' AND i.state IN ('queued','dispatching','observing'))
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_generation_transitions t WHERE t.workspace_id=w.id AND t.org_id=w.org_id AND t.state NOT IN ('succeeded','rolled_back','cancelled'))
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_runtime_transitions t WHERE t.workspace_id=w.id AND t.org_id=w.org_id AND t.phase NOT IN ('healthy','rolled_back','cancelled')) AS generations_fenced,
        NOT EXISTS(SELECT 1 FROM cloud_workspace_provider_operations o WHERE o.workspace_id=w.id AND o.org_id=w.org_id
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_generations g WHERE g.workspace_id=o.workspace_id AND g.org_id=o.org_id AND g.generation=o.generation)) AS journal_complete
        FROM cloud_workspaces w
        LEFT JOIN cloud_workspace_lifecycle_intents intent ON intent.workspace_id=w.id AND intent.org_id=w.org_id
          AND intent.operation='delete' AND intent.idempotency_key=$3
        LEFT JOIN workspace_deletion_jobs job ON job.workspace_id=w.id AND job.org_id=w.org_id
        WHERE w.id=$1 AND w.org_id=$2 FOR SHARE OF w`,
      [input.workspaceId, input.organizationId, input.deleteIdempotencyKey])).rows[0];
      if (!workspace) throw new HttpError(404, "not_found", "Cloud workspace not found");
      await authorizeCloudWorkspaceCleanup(tx, input);
      // The job binds the selected accepted delete. Its failure still refuses;
      // an immutable earlier failure cannot veto fresh proof for every generation.
      if (workspace.current_generation !== input.generation || workspace.intent_generation !== input.generation ||
          workspace.desired_state !== "deleted" || !["deleting", "deleted"].includes(workspace.status) ||
          !workspace.intent_id || !workspace.requested_at || workspace.requested_by !== input.actorUserId || !workspace.affects_workspace ||
          !["queued", "dispatching", "observing", "succeeded"].includes(workspace.intent_state ?? "") ||
          !workspace.job_id || workspace.job_key !== `lifecycle.${workspace.intent_id}` || workspace.job_error !== null ||
          !["waiting_for_provider", "detaching_objects", "deleting_objects", "deleting_records", "succeeded"].includes(workspace.job_state ?? "") ||
          !workspace.compute_settled || !workspace.access_retired || !workspace.generations_fenced || !workspace.journal_complete) throw unconfirmed();
      const generations = (await tx.query<Generation>(`SELECT
        g.generation,g.provider,g.sandbox_class,g.storage_mib,g.provider_connection_id,g.provider_connection_version::text,
        version.credential_source,b.observed_state,b.provider_resource_id,b.deletion_verified_at::text,
        o.account_scope,o.generation AS operation_generation,o.resource_id,o.idempotency_key AS create_key,o.request_sha256,
        o.create_attempts_tracked,o.create_closed_at::text,o.lost_at::text,o.deletion_operation_id,o.deletion_requested_at::text,o.deleted_at::text,
        owner.original_generation,
        EXISTS(SELECT 1 FROM cloud_workspace_provider_create_attempts a WHERE a.provider=o.provider AND a.account_scope=o.account_scope
          AND a.workspace_id=o.workspace_id AND a.generation=o.generation AND a.rejected_at IS NULL) AS create_uncertain
        FROM cloud_workspace_generations g
        LEFT JOIN cloud_workspace_provider_bindings b ON b.workspace_id=g.workspace_id AND b.org_id=g.org_id AND b.generation=g.generation AND b.provider=g.provider
        LEFT JOIN cloud_workspace_allocation_owners owner ON owner.workspace_id=g.workspace_id AND owner.org_id=g.org_id AND owner.provider_resource_id=b.provider_resource_id
        LEFT JOIN cloud_workspace_provider_operations o ON o.workspace_id=g.workspace_id AND o.org_id=g.org_id AND o.provider=g.provider
          AND o.generation=coalesce(owner.original_generation,g.generation)
        LEFT JOIN provider_connection_versions version ON version.connection_id=g.provider_connection_id AND version.org_id=g.org_id AND version.version=g.provider_connection_version
        WHERE g.workspace_id=$1 AND g.org_id=$2 ORDER BY g.generation LIMIT 65`, [input.workspaceId, input.organizationId])).rows;
      if (!generations.length || generations.length > 64 || !generations.some(g => g.generation === input.generation)) throw unconfirmed();
      for (const g of generations) {
        if (g.provider !== "boat" || g.sandbox_class !== null || g.credential_source !== "hosted" ||
            !g.account_scope || !g.create_key || !g.request_sha256 || g.lost_at !== null ||
            g.operation_generation !== (g.original_generation ?? g.generation) ||
            !["stopped", "archived", "deleting", "deleted"].includes(g.observed_state ?? "")) throw unconfirmed();
        if (g.provider_resource_id === null) {
          if (g.resource_id !== null || !g.deletion_verified_at || !g.create_closed_at || !g.create_attempts_tracked || g.create_uncertain) throw unconfirmed();
        } else if (g.resource_id !== g.provider_resource_id || !g.deletion_operation_id || !g.deletion_requested_at ||
            (g.deletion_verified_at !== null && g.deleted_at === null) || (g.deletion_verified_at === null && g.deleted_at !== null)) throw unconfirmed();
      }
      const observedAt = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
      return { workspace, generations, observedAt };
    });
  }

  async read(input: Scope & { signal?: AbortSignal }): Promise<CloudWorkspaceDeletionRetirement> {
    const deadline = AbortSignal.timeout(10_000);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const before = await this.snapshot(input);
    const pending = new Map<number, CloudProviderDeletionRetirement>();
    try {
      for (const generation of before.generations) {
        signal.throwIfAborted();
        if (generation.deletion_verified_at !== null) continue;
        if (!this.providers || !generation.provider_resource_id) throw unconfirmed();
        const resolved = await this.providers.resolve({ workspaceId: input.workspaceId, organizationId: input.organizationId,
          generation: generation.generation, purpose: "cleanup" });
        if (resolved.credentialSource !== "hosted" || resolved.provider.name !== generation.provider ||
            resolved.connectionId !== generation.provider_connection_id || String(resolved.connectionVersion) !== generation.provider_connection_version ||
            !resolved.provider.observeDeletionRetirement) throw unconfirmed();
        const proof = await resolved.provider.observeDeletionRetirement(generation.provider_resource_id, { signal });
        if (proof.workspaceId !== input.workspaceId || proof.generation !== generation.operation_generation ||
            proof.resourceId !== generation.provider_resource_id || proof.deletionOperationId !== generation.deletion_operation_id ||
            !Number.isFinite(Date.parse(proof.observedAt)) || Date.parse(proof.observedAt) < Date.parse(before.observedAt) - 5_000 ||
            Date.parse(proof.observedAt) > Date.now() + 5_000) throw unconfirmed();
        pending.set(generation.generation, proof);
      }
    } catch (error) {
      if (error instanceof CloudProviderError || signal.aborted) throw unconfirmed();
      throw error;
    }
    const after = await this.snapshot(input);
    if (signal.aborted || JSON.stringify([before.workspace, before.generations]) !== JSON.stringify([after.workspace, after.generations])) throw unconfirmed();
    const physical = pending.size === 0;
    const w = after.workspace;
    if (physical && (w.status !== "deleted" || w.deleted_at === null || w.data_deleted_at === null || w.job_state !== "succeeded" || w.intent_state !== "succeeded")) throw unconfirmed();
    const generations = after.generations.map(g => {
      const proof = pending.get(g.generation);
      const requestedAt = iso(g.deletion_requested_at ?? w.requested_at!);
      return { generation: g.generation,
        status: proof ? "compute_retired_storage_pending" as const : "physically_deleted" as const,
        receiptSha256: createHash("sha256").update(JSON.stringify([input.organizationId, input.workspaceId, g.generation, g.provider,
          g.account_scope, g.operation_generation, g.resource_id, g.create_key, g.request_sha256, g.deletion_operation_id,
          g.deletion_requested_at, g.create_closed_at])).digest("hex"),
        requestedAt, storageStage: proof?.stage ?? "completed" as const, expectedBy: proof?.expectedBy ?? null,
        reserved: reserved(proof ? g.storage_mib : 0) };
    });
    const result = CloudWorkspaceDeletionRetirementSchema.safeParse({
      version: 1, organizationId: input.organizationId, workspaceId: input.workspaceId,
      ownerUserId: w.owner_user_id, createdBy: w.created_by, createdAt: iso(w.created_at), repositoryId: w.repository_id,
      name: w.display_name, currentGeneration: w.current_generation, deleteIntentId: w.intent_id,
      deleteIdempotencyKey: input.deleteIdempotencyKey, requestedAt: iso(w.requested_at!), observedAt: after.observedAt,
      status: physical ? "physically_deleted" : "compute_retired_storage_pending", deletionConfirmed: physical,
      admissionFenced: true, computeSettled: true, accessRetired: true, generations,
      reserved: reserved(generations.reduce((total, row) => total + row.reserved.storageMiB, 0)),
    });
    if (!result.success) throw unconfirmed();
    return result.data;
  }
}
