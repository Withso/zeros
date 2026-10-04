import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { CloudProviderError } from "./provider.js";
import type { CloudProviderCreateRejectionCode } from "./provider-operation-store.js";
import type { BuilderVm, BuilderVmSource } from "./cloud-builder-vm.js";

export type BuilderVmIntent = {
  purpose: BuilderVm["purpose"];
  source: BuilderVmSource;
  name: string;
  operationKey: string;
  ttlSeconds: number;
};
export type BuilderProviderRequest = { path: string; body: {
  from?: string; name: string; type: "default"; ttlSeconds: number;
  noEnv: true; env: Record<string, never>; snapshots: boolean;
} };
export type BuilderVmOperation = {
  operation_key: string;
  purpose: BuilderVm["purpose"];
  request_sha256: string;
  intent: BuilderVmIntent;
  provider_request: BuilderProviderRequest;
  state: "creating" | "ready" | "stopping" | "archived" | "deleting" | "deleted";
  sandbox_id: string | null;
  deletion_operation_id: string | null;
  created_at: Date;
  create_dispatched_at: Date | null;
  create_attempts_tracked: boolean;
  create_closed_at: Date | null;
};

export interface BuilderVmOperationStore {
  find(operationKey: string, tx?: Tx): Promise<BuilderVmOperation | null>;
  prepare(intent: BuilderVmIntent, sha256: string, request: BuilderProviderRequest, tx?: Tx): Promise<BuilderVmOperation>;
  beginCreateAttempt(operationKey: string, attemptId: string): Promise<BuilderVmOperation>;
  recordCreateRejection(operationKey: string, attemptId: string, code: CloudProviderCreateRejectionCode): Promise<void>;
  closeUnallocatedCreate(operationKey: string): Promise<boolean>;
  bind(operationKey: string, sandboxId: string): Promise<void>;
  state(operationKey: string, state: BuilderVmOperation["state"]): Promise<void>;
  deletion(operationKey: string, operationId: string): Promise<void>;
}

export function builderOperationConflict(): never {
  throw new CloudProviderError("provider_operation_conflict", "Builder provider operation conflicts with its journal", false);
}

/** Infrastructure sibling of DatabaseCloudProviderOperationStore. These rows
 * have no invented workspace/org owner and are visible only in system context. */
export class DatabaseBuilderVmOperationStore implements BuilderVmOperationStore {
  constructor(private readonly pool: pg.Pool, private readonly accountScope: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(accountScope)) builderOperationConflict();
  }
  async find(operationKey: string, tx?: Tx) {
    const read = async (tx: Tx) => (await tx.query<BuilderVmOperation>(
      `SELECT * FROM cloud_builder_vm_operations WHERE account_scope=$1 AND operation_key=$2`,
      [this.accountScope, operationKey])).rows[0] ?? null;
    return tx ? read(tx) : withSystemTx(this.pool, read);
  }
  async prepare(intent: BuilderVmIntent, sha256: string, request: BuilderProviderRequest, tx?: Tx) {
    const prepare = async (tx: Tx) => {
      await tx.query(`INSERT INTO cloud_builder_vm_operations
        (account_scope, operation_key, purpose, request_sha256, intent, provider_request, create_attempts_tracked)
        VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT DO NOTHING`,
      [this.accountScope, intent.operationKey, intent.purpose, sha256, JSON.stringify(intent), JSON.stringify(request)]);
      const row = (await tx.query<BuilderVmOperation>(`SELECT * FROM cloud_builder_vm_operations
        WHERE account_scope=$1 AND operation_key=$2`, [this.accountScope, intent.operationKey])).rows[0];
      if (!row || row.request_sha256 !== sha256) builderOperationConflict();
      return row;
    };
    return tx ? prepare(tx) : withSystemTx(this.pool, prepare);
  }
  async beginCreateAttempt(operationKey: string, attemptId: string) {
    return withSystemTx(this.pool, async tx => {
      const current = (await tx.query<BuilderVmOperation>(`SELECT * FROM cloud_builder_vm_operations
        WHERE account_scope=$1 AND operation_key=$2 FOR UPDATE`, [this.accountScope, operationKey])).rows[0];
      if (!current || current.create_closed_at || !["creating", "ready"].includes(current.state)) builderOperationConflict();
      if (current.sandbox_id) return current;
      const inserted = await tx.query(`INSERT INTO cloud_builder_vm_create_attempts (account_scope,operation_key,attempt_id)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [this.accountScope, operationKey, attemptId]);
      if (inserted.rowCount !== 1) builderOperationConflict();
      const row = (await tx.query<BuilderVmOperation>(`UPDATE cloud_builder_vm_operations
        SET create_dispatched_at=COALESCE(create_dispatched_at,clock_timestamp())
        WHERE account_scope=$1 AND operation_key=$2 RETURNING *`,
      [this.accountScope, operationKey])).rows[0];
      if (!row) builderOperationConflict();
      return row;
    });
  }
  async recordCreateRejection(operationKey: string, attemptId: string, code: CloudProviderCreateRejectionCode) {
    await withSystemTx(this.pool, async tx => {
      await tx.query(`SELECT 1 FROM cloud_builder_vm_operations WHERE account_scope=$1 AND operation_key=$2 FOR UPDATE`,
        [this.accountScope, operationKey]);
      const saved = await tx.query(`UPDATE cloud_builder_vm_create_attempts
        SET rejection_code=$4,rejected_at=COALESCE(rejected_at,clock_timestamp())
        WHERE account_scope=$1 AND operation_key=$2 AND attempt_id=$3 AND (rejection_code IS NULL OR rejection_code=$4)`,
      [this.accountScope, operationKey, attemptId, code]);
      if (saved.rowCount !== 1) builderOperationConflict();
    });
  }
  async closeUnallocatedCreate(operationKey: string) {
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<BuilderVmOperation>(`SELECT * FROM cloud_builder_vm_operations
        WHERE account_scope=$1 AND operation_key=$2 FOR UPDATE`, [this.accountScope, operationKey])).rows[0];
      if (!row || row.sandbox_id) return false;
      if (row.create_closed_at) return true;
      const closed = await tx.query(`UPDATE cloud_builder_vm_operations SET create_closed_at=clock_timestamp()
        WHERE account_scope=$1 AND operation_key=$2 AND create_attempts_tracked AND sandbox_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM cloud_builder_vm_create_attempts
            WHERE account_scope=$1 AND operation_key=$2 AND rejected_at IS NULL)`, [this.accountScope, operationKey]);
      return closed.rowCount === 1;
    });
  }
  async bind(operationKey: string, sandboxId: string) {
    await this.update(`sandbox_id=$3`, `AND create_closed_at IS NULL AND (sandbox_id IS NULL OR sandbox_id=$3)`, operationKey, sandboxId);
  }
  async state(operationKey: string, state: BuilderVmOperation["state"]) {
    await this.update(`state=$3,
      deletion_requested_at=CASE WHEN $3 IN ('deleting','deleted') THEN COALESCE(deletion_requested_at,clock_timestamp()) ELSE deletion_requested_at END,
      deleted_at=CASE WHEN $3='deleted' THEN COALESCE(deleted_at,clock_timestamp()) ELSE deleted_at END`,
    "", operationKey, state);
  }
  async deletion(operationKey: string, operationId: string) {
    await this.update(`deletion_operation_id=$3`, `AND state='deleting' AND (deletion_operation_id IS NULL OR deletion_operation_id=$3)`, operationKey, operationId);
  }
  private async update(set: string, where: string, key: string, value: string) {
    await withSystemTx(this.pool, async tx => {
      const result = await tx.query(`UPDATE cloud_builder_vm_operations SET ${set}
        WHERE account_scope=$1 AND operation_key=$2 ${where}`, [this.accountScope, key, value]);
      if (result.rowCount !== 1) builderOperationConflict();
    });
  }
}
