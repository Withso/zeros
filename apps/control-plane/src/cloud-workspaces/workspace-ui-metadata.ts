import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { authorizeCloudWorkspaceActor, type CloudWorkspaceActorScope } from "./actors.js";
import {
  CloudWorkspaceDetectedPortsSchema, cloudWorkspaceDisplayLabel,
  type CloudWorkspaceDetectedPorts, type CloudWorkspaceRenameInput,
} from "./workspace-ui-contracts.js";

function unavailable(): never {
  throw new HttpError(404, "cloud_workspace_not_found", "Cloud workspace access is unavailable");
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export async function readCloudWorkspaceDetectedPorts(
  tx: Tx, scope: CloudWorkspaceActorScope & { generation: number },
): Promise<CloudWorkspaceDetectedPorts> {
  // Heartbeats and replacement serialize on the same workspace row. Holding
  // it through projection keeps status, generation and observations coherent.
  const workspace = (await tx.query<{ current_generation: number; status: string }>(
    `SELECT current_generation,status FROM cloud_workspaces
     WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR SHARE`,
    [scope.workspaceId, scope.organizationId],
  )).rows[0];
  if (!workspace) unavailable();
  await authorizeCloudWorkspaceActor(tx, { ...scope, capability: "read", allowOwnerDataRecovery: true });
  if (workspace.current_generation !== scope.generation)
    throw new HttpError(409, "cloud_workspace_generation_changed", "The cloud workspace generation changed");
  const observation = (await tx.query<{ ports_observed_at: Date | string | null }>(
    `SELECT ports_observed_at FROM cloud_workspace_generations
     WHERE workspace_id=$1 AND generation=$2 AND org_id=$3`,
    [scope.workspaceId, scope.generation, scope.organizationId],
  )).rows[0];
  if (!observation) unavailable();
  const observedAt = observation.ports_observed_at === null ? null : iso(observation.ports_observed_at);
  const rows = observedAt === null ? [] : (await tx.query<{
    port: number; process_label: string | null; health: "observed" | "healthy" | "unhealthy";
    observed_at: Date | string;
  }>(
    `SELECT port,left(process_label,120) AS process_label,health,observed_at
     FROM workspace_ports WHERE workspace_id=$1 AND generation=$2 AND org_id=$3
       AND protocol='tcp' AND port BETWEEN 1024 AND 65535
       AND closed_at IS NULL AND health IN ('observed','healthy','unhealthy')
     ORDER BY port LIMIT 128`,
    [scope.workspaceId, scope.generation, scope.organizationId],
  )).rows;
  return CloudWorkspaceDetectedPortsSchema.parse({
    version: 1, organizationId: scope.organizationId, workspaceId: scope.workspaceId,
    generation: scope.generation, status: workspace.status, observedAt,
    ports: observedAt === null ? null : rows.map(row => ({
      port: row.port, protocol: "tcp", processLabel: cloudWorkspaceDisplayLabel(row.process_label),
      health: row.health, observedAt: iso(row.observed_at), closedAt: null,
    })),
  });
}

type RenameReceipt = { workspace_id: string; requested_by: string; request_sha256: Buffer };

export async function renameCloudWorkspaceMetadata(
  tx: Tx, scope: CloudWorkspaceActorScope,
  input: CloudWorkspaceRenameInput, idempotencyKey: string,
): Promise<void> {
  const workspace = (await tx.query<{ display_name: string; version: string | number }>(
    `SELECT display_name,version FROM cloud_workspaces
     WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL FOR UPDATE`,
    [scope.workspaceId, scope.organizationId],
  )).rows[0];
  if (!workspace) unavailable();
  // Replays require the caller's current manager authority too.
  await authorizeCloudWorkspaceActor(tx, { ...scope, capability: "manage" });
  const requestHash = createHash("sha256").update(JSON.stringify({
    organizationId: scope.organizationId, workspaceId: scope.workspaceId,
    actorUserId: scope.actorUserId, name: input.name, version: input.version,
  })).digest();
  const readReceipt = async () => (await tx.query<RenameReceipt>(
    `SELECT workspace_id,requested_by,request_sha256 FROM cloud_workspace_metadata_requests
     WHERE org_id=$1 AND idempotency_key=$2`, [scope.organizationId, idempotencyKey],
  )).rows[0];
  const validateReceipt = (receipt: RenameReceipt) => {
    if (receipt.workspace_id !== scope.workspaceId || receipt.requested_by !== scope.actorUserId ||
      receipt.request_sha256.length !== requestHash.length || !timingSafeEqual(receipt.request_sha256, requestHash))
      throw new HttpError(409, "idempotency_key_reused", "Idempotency-Key was already used for another metadata request");
  };
  const existing = await readReceipt();
  if (existing) { validateReceipt(existing); return; }
  const version = Number(workspace.version);
  if (!Number.isSafeInteger(version) || version < 0 || version !== input.version)
    throw new HttpError(409, "cloud_workspace_version_conflict", "The cloud workspace metadata changed");
  const resultVersion = version + (workspace.display_name === input.name ? 0 : 1);
  if (!Number.isSafeInteger(resultVersion))
    throw new HttpError(409, "cloud_workspace_version_conflict", "The cloud workspace metadata changed");
  // The tenant key is also unique across different workspaces. ON CONFLICT
  // waits for a racing receipt before any metadata write, then revalidates it.
  const recorded = await tx.query(
    `INSERT INTO cloud_workspace_metadata_requests
       (org_id,idempotency_key,workspace_id,requested_by,request_sha256,result_version)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,idempotency_key) DO NOTHING`,
    [scope.organizationId, idempotencyKey, scope.workspaceId, scope.actorUserId, requestHash, resultVersion],
  );
  await authorizeCloudWorkspaceActor(tx, { ...scope, capability: "manage" });
  if (recorded.rowCount !== 1) {
    const receipt = await readReceipt();
    if (!receipt) throw new Error("Cloud workspace metadata receipt is unavailable");
    validateReceipt(receipt);
    return;
  }
  if (resultVersion !== version) await tx.query(
    `UPDATE cloud_workspaces SET display_name=$3,version=version+1,updated_at=now()
     WHERE id=$1 AND org_id=$2`, [scope.workspaceId, scope.organizationId, input.name],
  );
}
