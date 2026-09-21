import type pg from "pg";
import { withSystemTx } from "../db.js";
import {
  CloudProviderError,
  type CloudProviderIdentity,
  type CloudWorkspaceProviderName,
} from "./provider.js";

export type CloudProviderOperationRecord = CloudProviderIdentity & {
  idempotencyKey: string;
  requestSha256: string;
  createdAt: Date;
  resourceId: string | null;
  deletionRequestedAt: Date | null;
  deletionOperationId: string | null;
  deletedAt: Date | null;
};

/** Coordinator-only evidence. Persist BEFORE external side effects; a missing
 * provider resource is not evidence that an asynchronous deletion completed. */
export interface CloudProviderOperationStore {
  prepareCreate(
    input: CloudProviderIdentity & {
      idempotencyKey: string;
      requestSha256: string;
    },
  ): Promise<CloudProviderOperationRecord>;
  bindResource(
    identity: CloudProviderIdentity,
    resourceId: string,
  ): Promise<CloudProviderOperationRecord>;
  find(
    identity: CloudProviderIdentity,
  ): Promise<CloudProviderOperationRecord | null>;
  get(resourceId: string): Promise<CloudProviderOperationRecord | null>;
  beginDelete(resourceId: string): Promise<CloudProviderOperationRecord>;
  bindDeletion(resourceId: string, operationId: string): Promise<void>;
  completeDeletion(resourceId: string, operationId: string): Promise<void>;
  list(): AsyncIterable<CloudProviderOperationRecord>;
}

type RecordRow = {
  workspace_id: string;
  generation: number;
  idempotency_key: string;
  request_sha256: string;
  created_at: Date;
  resource_id: string | null;
  deletion_requested_at: Date | null;
  deletion_operation_id: string | null;
  deleted_at: Date | null;
};
const COLUMNS = `workspace_id, generation, idempotency_key, request_sha256,
  created_at, resource_id, deletion_requested_at, deletion_operation_id, deleted_at`;
function document(row: RecordRow): CloudProviderOperationRecord {
  return {
    workspaceId: row.workspace_id,
    generation: row.generation,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    createdAt: row.created_at,
    resourceId: row.resource_id,
    deletionRequestedAt: row.deletion_requested_at,
    deletionOperationId: row.deletion_operation_id,
    deletedAt: row.deleted_at,
  };
}
function conflict(): CloudProviderError {
  return new CloudProviderError(
    "provider_operation_conflict",
    "Provider operation evidence is missing or conflicts with its immutable identity",
    false,
  );
}

/** accountScope is a stable, qualified provider account identity, never an API
 * key or its version. Rotation within the same account retains this journal. */
export class DatabaseCloudProviderOperationStore implements CloudProviderOperationStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly provider: CloudWorkspaceProviderName,
    private readonly accountScope: string,
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(accountScope)) {
      throw new Error("Invalid provider operation account scope");
    }
  }

  async prepareCreate(
    input: CloudProviderIdentity & {
      idempotencyKey: string;
      requestSha256: string;
    },
  ): Promise<CloudProviderOperationRecord> {
    if (
      !/^[a-f0-9]{64}$/.test(input.requestSha256) ||
      !/^[a-zA-Z0-9._:-]{1,255}$/.test(input.idempotencyKey)
    )
      throw conflict();
    return withSystemTx(this.pool, async (tx) => {
      // The generation must have been admitted before any provider allocation.
      const admitted = await tx.query(
        `SELECT g.workspace_id FROM cloud_workspace_generations g
         JOIN cloud_workspaces cw ON cw.id = g.workspace_id AND cw.org_id = g.org_id
         WHERE g.workspace_id = $1 AND g.generation = $2 AND g.provider = $3
           AND g.retired_at IS NULL AND cw.desired_state = 'running' AND cw.deleted_at IS NULL
           AND (cw.current_generation = g.generation OR EXISTS (
             SELECT 1 FROM cloud_workspace_generation_transitions transition
             WHERE transition.workspace_id = g.workspace_id AND transition.org_id = g.org_id
               AND transition.candidate_generation = g.generation
               AND transition.state IN ('provisioning', 'setting_up')
           ))
         FOR SHARE OF cw, g`,
        [input.workspaceId, input.generation, this.provider],
      );
      if (admitted.rowCount !== 1) throw conflict();
      await tx.query(
        `INSERT INTO cloud_workspace_provider_operations
           (provider, account_scope, workspace_id, generation, org_id, idempotency_key, request_sha256)
         SELECT $1, $2, workspace_id, generation, org_id, $5, $6
         FROM cloud_workspace_generations
         WHERE workspace_id = $3 AND generation = $4 AND provider = $1
         ON CONFLICT DO NOTHING`,
        [
          this.provider,
          this.accountScope,
          input.workspaceId,
          input.generation,
          input.idempotencyKey,
          input.requestSha256,
        ],
      );
      const result = await tx.query<RecordRow>(
        `SELECT ${COLUMNS} FROM cloud_workspace_provider_operations
         WHERE provider = $1 AND account_scope = $2 AND workspace_id = $3 AND generation = $4`,
        [this.provider, this.accountScope, input.workspaceId, input.generation],
      );
      const row = result.rows[0];
      if (!row || row.request_sha256 !== input.requestSha256) throw conflict();
      // A new wake intent may retry the same allocation. Its key must never
      // replace the original provider key, even when the original reply was lost.
      return document(row);
    });
  }

  async bindResource(
    identity: CloudProviderIdentity,
    resourceId: string,
  ): Promise<CloudProviderOperationRecord> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<RecordRow>(
        `UPDATE cloud_workspace_provider_operations SET resource_id = $5
         WHERE provider = $1 AND account_scope = $2 AND workspace_id = $3 AND generation = $4
           AND (resource_id IS NULL OR resource_id = $5)
         RETURNING ${COLUMNS}`,
        [
          this.provider,
          this.accountScope,
          identity.workspaceId,
          identity.generation,
          resourceId,
        ],
      );
      if (!result.rows[0]) throw conflict();
      return document(result.rows[0]);
    });
  }

  async find(
    identity: CloudProviderIdentity,
  ): Promise<CloudProviderOperationRecord | null> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<RecordRow & { account_scope: string }>(
        `SELECT ${COLUMNS}, account_scope FROM cloud_workspace_provider_operations
         WHERE provider = $1 AND workspace_id = $2 AND generation = $3`,
        [this.provider, identity.workspaceId, identity.generation],
      );
      if (result.rows[0] && result.rows[0].account_scope !== this.accountScope)
        throw conflict();
      return result.rows[0] ? document(result.rows[0]) : null;
    });
  }

  async get(resourceId: string): Promise<CloudProviderOperationRecord | null> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<RecordRow>(
        `SELECT ${COLUMNS} FROM cloud_workspace_provider_operations
         WHERE provider = $1 AND account_scope = $2 AND resource_id = $3`,
        [this.provider, this.accountScope, resourceId],
      );
      return result.rows[0] ? document(result.rows[0]) : null;
    });
  }

  async beginDelete(resourceId: string): Promise<CloudProviderOperationRecord> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<RecordRow>(
        `UPDATE cloud_workspace_provider_operations
         SET deletion_requested_at = coalesce(deletion_requested_at, now())
         WHERE provider = $1 AND account_scope = $2 AND resource_id = $3
         RETURNING ${COLUMNS}`,
        [this.provider, this.accountScope, resourceId],
      );
      if (!result.rows[0]) throw conflict();
      return document(result.rows[0]);
    });
  }

  async bindDeletion(resourceId: string, operationId: string): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE cloud_workspace_provider_operations SET deletion_operation_id = $4
         WHERE provider = $1 AND account_scope = $2 AND resource_id = $3
           AND deletion_requested_at IS NOT NULL
           AND (deletion_operation_id IS NULL OR deletion_operation_id = $4)`,
        [this.provider, this.accountScope, resourceId, operationId],
      );
      if (result.rowCount !== 1) throw conflict();
    });
  }

  async completeDeletion(
    resourceId: string,
    operationId: string,
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE cloud_workspace_provider_operations SET deleted_at = coalesce(deleted_at, now())
         WHERE provider = $1 AND account_scope = $2 AND resource_id = $3
           AND deletion_requested_at IS NOT NULL AND deletion_operation_id = $4`,
        [this.provider, this.accountScope, resourceId, operationId],
      );
      if (result.rowCount !== 1) throw conflict();
    });
  }

  async *list(): AsyncIterable<CloudProviderOperationRecord> {
    let cursor: { workspaceId: string; generation: number } | null = null;
    for (;;) {
      const page: RecordRow[] = await withSystemTx(
        this.pool,
        async (tx) =>
          (
            await tx.query<RecordRow>(
              `SELECT ${COLUMNS} FROM cloud_workspace_provider_operations
           WHERE provider = $1 AND account_scope = $2 AND resource_id IS NOT NULL
             AND deleted_at IS NULL
             AND ($3::uuid IS NULL OR (workspace_id, generation) > ($3::uuid, $4::integer))
           ORDER BY workspace_id, generation LIMIT 200`,
              [
                this.provider,
                this.accountScope,
                cursor?.workspaceId ?? null,
                cursor?.generation ?? null,
              ],
            )
          ).rows,
      );
      for (const row of page) yield document(row);
      const last = page.at(-1);
      if (page.length < 200 || !last) return;
      cursor = { workspaceId: last.workspace_id, generation: last.generation };
    }
  }
}
