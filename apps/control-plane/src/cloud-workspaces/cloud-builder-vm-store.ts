import type pg from "pg";
import { withSystemTx } from "../db.js";
import { CloudProviderError } from "./provider.js";
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
};

export interface BuilderVmOperationStore {
  find(operationKey: string): Promise<BuilderVmOperation | null>;
  prepare(intent: BuilderVmIntent, sha256: string, request: BuilderProviderRequest): Promise<BuilderVmOperation>;
  dispatch(operationKey: string): Promise<BuilderVmOperation>;
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
  async find(operationKey: string) {
    return withSystemTx(this.pool, async tx => (await tx.query<BuilderVmOperation>(
      `SELECT * FROM cloud_builder_vm_operations WHERE account_scope=$1 AND operation_key=$2`,
      [this.accountScope, operationKey])).rows[0] ?? null);
  }
  async prepare(intent: BuilderVmIntent, sha256: string, request: BuilderProviderRequest) {
    return withSystemTx(this.pool, async tx => {
      await tx.query(`INSERT INTO cloud_builder_vm_operations
        (account_scope, operation_key, purpose, request_sha256, intent, provider_request)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [this.accountScope, intent.operationKey, intent.purpose, sha256, JSON.stringify(intent), JSON.stringify(request)]);
      const row = (await tx.query<BuilderVmOperation>(`SELECT * FROM cloud_builder_vm_operations
        WHERE account_scope=$1 AND operation_key=$2`, [this.accountScope, intent.operationKey])).rows[0];
      if (!row || row.request_sha256 !== sha256) builderOperationConflict();
      return row;
    });
  }
  async dispatch(operationKey: string) {
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<BuilderVmOperation>(`UPDATE cloud_builder_vm_operations
        SET create_dispatched_at=COALESCE(create_dispatched_at,clock_timestamp())
        WHERE account_scope=$1 AND operation_key=$2 AND state IN ('creating','ready') RETURNING *`,
      [this.accountScope, operationKey])).rows[0];
      if (!row) builderOperationConflict();
      return row;
    });
  }
  async bind(operationKey: string, sandboxId: string) {
    await this.update(`sandbox_id=$3`, `AND (sandbox_id IS NULL OR sandbox_id=$3)`, operationKey, sandboxId);
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
