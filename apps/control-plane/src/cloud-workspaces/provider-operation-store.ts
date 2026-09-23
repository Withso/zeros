import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
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
  createAttemptsTracked: boolean;
  createClosedAt: Date | null;
};

export type CloudProviderCreateRejectionCode =
  | "limit_reached" | "member_limit_reached" | "trial_compute_limit_reached";

/** Coordinator-only evidence. Persist BEFORE external side effects; a missing
 * provider resource is not evidence that an asynchronous deletion completed. */
export interface CloudProviderOperationStore {
  prepareCreate(
    input: CloudProviderIdentity & {
      idempotencyKey: string;
      requestSha256: string;
      /** An existing tracked row may retain this earlier request digest; the
       * returned record's requestSha256 identifies which request it holds. */
      compatibleRequestSha256?: string;
      /** Old/untracked rows retain their exact original digest and key. */
      legacyRequestSha256?: string;
    },
  ): Promise<CloudProviderOperationRecord>;
  beginCreateAttempt(identity: CloudProviderIdentity, attemptId: string): Promise<CloudProviderOperationRecord>;
  recordCreateRejection(identity: CloudProviderIdentity, attemptId: string, code: CloudProviderCreateRejectionCode): Promise<void>;
  /** Atomically seals an unallocated generation against future dispatch. */
  closeUnallocatedCreate(identity: CloudProviderIdentity): Promise<boolean>;
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
  create_attempts_tracked: boolean;
  create_closed_at: Date | null;
};
const COLUMNS = `workspace_id, generation, idempotency_key, request_sha256,
  created_at, resource_id, deletion_requested_at, deletion_operation_id, deleted_at,
  create_attempts_tracked, create_closed_at`;
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
    createAttemptsTracked: row.create_attempts_tracked,
    createClosedAt: row.create_closed_at,
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

  /** Same parent-before-journal order as workspace admission and erasure. */
  private async lockScope(tx: Tx, identity: CloudProviderIdentity): Promise<void> {
    const scope = await tx.query<{ org_id: string }>(
      "SELECT org_id FROM cloud_workspaces WHERE id=$1", [identity.workspaceId],
    );
    if (!scope.rows[0]) throw conflict();
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [scope.rows[0].org_id]);
    const workspace = await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR SHARE", [identity.workspaceId, scope.rows[0].org_id]);
    if (workspace.rowCount !== 1) throw conflict();
    await tx.query("SELECT workspace_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=$2 FOR SHARE", [identity.workspaceId, identity.generation]);
  }

  private async assertAdmitted(tx: Tx, identity: CloudProviderIdentity): Promise<void> {
    const admitted = await tx.query(
      `SELECT g.workspace_id FROM cloud_workspace_generations g
       JOIN cloud_workspaces cw ON cw.id=g.workspace_id AND cw.org_id=g.org_id
       WHERE g.workspace_id=$1 AND g.generation=$2 AND g.provider=$3
         AND g.retired_at IS NULL AND cw.desired_state='running' AND cw.deleted_at IS NULL
         AND (cw.current_generation=g.generation OR EXISTS (
           SELECT 1 FROM cloud_workspace_generation_transitions transition
           WHERE transition.workspace_id=g.workspace_id AND transition.org_id=g.org_id
             AND transition.candidate_generation=g.generation
             AND transition.state IN ('provisioning','setting_up')
         ))`, [identity.workspaceId, identity.generation, this.provider],
    );
    if (admitted.rowCount !== 1) throw conflict();
  }

  async prepareCreate(
    input: CloudProviderIdentity & {
      idempotencyKey: string;
      requestSha256: string;
      compatibleRequestSha256?: string;
      legacyRequestSha256?: string;
    },
  ): Promise<CloudProviderOperationRecord> {
    if (
      !/^[a-f0-9]{64}$/.test(input.requestSha256) ||
      (input.compatibleRequestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.compatibleRequestSha256)) ||
      (input.legacyRequestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.legacyRequestSha256)) ||
      !/^[a-zA-Z0-9._:-]{1,255}$/.test(input.idempotencyKey)
    )
      throw conflict();
    return withSystemTx(this.pool, async (tx) => {
      await this.lockScope(tx, input);
      await this.assertAdmitted(tx, input);
      await tx.query(
        `INSERT INTO cloud_workspace_provider_operations
           (provider, account_scope, workspace_id, generation, org_id, idempotency_key, request_sha256, create_attempts_tracked)
         SELECT $1, $2, workspace_id, generation, org_id, $5, $6, true
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
      const accepted = row?.create_attempts_tracked
        ? [input.requestSha256, input.compatibleRequestSha256]
        : [input.legacyRequestSha256 ?? input.requestSha256];
      if (!row || !accepted.includes(row.request_sha256)) throw conflict();
      // A new wake intent may retry the same allocation. Its key must never
      // replace the original provider key, even when the original reply was lost.
      return document(row);
    });
  }

  async beginCreateAttempt(identity: CloudProviderIdentity, attemptId: string): Promise<CloudProviderOperationRecord> {
    return withSystemTx(this.pool, async tx => {
      await this.lockScope(tx, identity);
      await this.assertAdmitted(tx, identity);
      const row = (await tx.query<RecordRow>(`SELECT ${COLUMNS} FROM cloud_workspace_provider_operations
        WHERE provider=$1 AND account_scope=$2 AND workspace_id=$3 AND generation=$4 FOR UPDATE`,
      [this.provider, this.accountScope, identity.workspaceId, identity.generation])).rows[0];
      if (!row) throw conflict();
      if (row.create_closed_at || row.deletion_requested_at || row.deleted_at)
        throw new CloudProviderError("provider_generation_retired", "Provider generation cannot allocate again", false);
      if (row.resource_id) return document(row);
      const inserted = await tx.query(`INSERT INTO cloud_workspace_provider_create_attempts
        (provider,account_scope,workspace_id,generation,attempt_id) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING`, [this.provider, this.accountScope, identity.workspaceId, identity.generation, attemptId]);
      if (inserted.rowCount !== 1) throw conflict();
      return document(row);
    });
  }

  async recordCreateRejection(identity: CloudProviderIdentity, attemptId: string, code: CloudProviderCreateRejectionCode): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await this.lockScope(tx, identity);
      await tx.query(`SELECT 1 FROM cloud_workspace_provider_operations
        WHERE provider=$1 AND account_scope=$2 AND workspace_id=$3 AND generation=$4 FOR UPDATE`,
      [this.provider, this.accountScope, identity.workspaceId, identity.generation]);
      const result = await tx.query(`UPDATE cloud_workspace_provider_create_attempts
        SET rejection_code=$6,rejected_at=coalesce(rejected_at,clock_timestamp())
        WHERE provider=$1 AND account_scope=$2 AND workspace_id=$3 AND generation=$4 AND attempt_id=$5
          AND (rejection_code IS NULL OR rejection_code=$6)`,
      [this.provider, this.accountScope, identity.workspaceId, identity.generation, attemptId, code]);
      if (result.rowCount !== 1) throw conflict();
    });
  }

  async closeUnallocatedCreate(identity: CloudProviderIdentity): Promise<boolean> {
    return withSystemTx(this.pool, async tx => {
      await this.lockScope(tx, identity);
      const row = (await tx.query<RecordRow>(`SELECT ${COLUMNS} FROM cloud_workspace_provider_operations
        WHERE provider=$1 AND account_scope=$2 AND workspace_id=$3 AND generation=$4 FOR UPDATE`,
      [this.provider, this.accountScope, identity.workspaceId, identity.generation])).rows[0];
      if (!row || !row.create_attempts_tracked || row.resource_id !== null) return false;
      if (row.create_closed_at) return true;
      const closed = await tx.query(`UPDATE cloud_workspace_provider_operations operation
        SET create_closed_at=clock_timestamp()
        WHERE provider=$1 AND account_scope=$2 AND workspace_id=$3 AND generation=$4
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_provider_create_attempts attempt
            WHERE attempt.provider=operation.provider AND attempt.account_scope=operation.account_scope
              AND attempt.workspace_id=operation.workspace_id AND attempt.generation=operation.generation
              AND attempt.rejected_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents intent
            WHERE intent.workspace_id=operation.workspace_id AND intent.generation=operation.generation
              AND intent.operation IN ('create','wake') AND intent.state IN ('queued','dispatching','observing'))`,
      [this.provider, this.accountScope, identity.workspaceId, identity.generation]);
      return closed.rowCount === 1;
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
           AND create_closed_at IS NULL
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
