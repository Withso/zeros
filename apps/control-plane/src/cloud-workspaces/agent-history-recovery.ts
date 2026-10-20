import type pg from "pg";
import { audit } from "../audit.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { CloudAgentHistoryRecoveryPreparedCustodySchema, CloudAgentHistoryRecoveryResponseSchema,
  type CloudAgentBootScope, type CloudAgentHistoryRecoveryRequest, type CloudAgentHistoryRecoveryResponse } from "./agent-boot-contract.js";
import { serializeCloudAgentCredentialSourceMutation } from "./agent-credential-mutations.js";
import { assertCloudEngineAuthorityDeadline, assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { retireCloudAgentBootSources } from "./agent-boot-credentials.js";
import { checkpointHistoryOwner, checkpointHistorySnapshot, checkCheckpointHistoryActivation } from "./checkpoint-history.js";

type Engine = { organizationId: string; workspaceId: string; generation: number; engineInstanceId: string; heartbeatToken: string };
type Target = { runtime_boot_id: string; owner_user_id: string; agent_funding_owner_epoch: string; cloud_local_commands_version: number | null };
function rejected(): never { throw new HttpError(403, "cloud_validation_access_denied", "cloud_validation_access_denied"); }
type PreparedCustody = NonNullable<CloudAgentHistoryRecoveryResponse["preparedCustody"]>;
type CustodyHint = NonNullable<CloudAgentHistoryRecoveryRequest["preparedCustody"]>;

/** A prepared binding may own disk namespaces without ever becoming the CP
 * source. Positive binding retirement and the original immutable recovery are
 * required; revoked/expired engines alone do not prove native process death. */
async function preparedCustody(tx: Tx, engine: Pick<Engine, "engineInstanceId" | "workspaceId" | "organizationId">,
  hints: CustodyHint, currentRecoveryId?: string): Promise<PreparedCustody> {
  const result: PreparedCustody = [];
  for (const hint of [...hints].sort((a, b) => a.writerEpoch.localeCompare(b.writerEpoch))) {
    const row = (await tx.query<{ scope: unknown; retired_at: string }>(`SELECT
        to_char(binding.retired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retired_at,
        jsonb_build_object('organizationId',writer.org_id,'workspaceId',writer.workspace_id,'generation',writer.generation,
          'engineInstanceId',writer.engine_instance_id,'bootId',writer.boot_id,'writerEpoch',writer.writer_epoch,
          'fundingOwnerUserId',writer.funding_owner_user_id,'fundingOwnerEpoch',writer.funding_owner_epoch) AS scope
      FROM cloud_agent_history_recoveries prepared
      JOIN cloud_workspaces workspace ON workspace.id=prepared.workspace_id AND workspace.org_id=prepared.org_id
      JOIN cloud_agent_boot_bindings binding ON binding.engine_instance_id=prepared.engine_instance_id
        AND binding.workspace_id=prepared.workspace_id AND binding.org_id=prepared.org_id
      JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=binding.workspace_id
        AND writer.org_id=binding.org_id AND writer.writer_epoch=binding.writer_epoch
      JOIN cloud_workspace_engine_instances previous ON previous.id=prepared.engine_instance_id
      JOIN cloud_workspace_engine_instances target ON target.id=$3 AND target.workspace_id=workspace.id AND target.org_id=workspace.org_id
      LEFT JOIN cloud_agent_history_recoveries current ON current.id=$6
      WHERE prepared.id=$4 AND prepared.workspace_id=$1 AND prepared.org_id=$2 AND binding.writer_epoch=$5
        AND prepared.activated_at IS NULL AND writer.state='reserved' AND writer.activated_at IS NULL AND writer.seal IS NULL
        AND binding.retired_at IS NOT NULL AND binding.credentials_initialized
        AND binding.boot_id=prepared.boot_id AND binding.generation=prepared.generation
        AND binding.funding_owner_user_id=prepared.funding_owner_user_id AND binding.funding_owner_epoch=prepared.funding_owner_epoch
        AND prepared.funding_owner_user_id=workspace.owner_user_id AND prepared.funding_owner_epoch=workspace.agent_funding_owner_epoch
        AND previous.enrollment_order<target.enrollment_order AND prepared.generation<=target.generation
        AND (($6::uuid IS NULL AND workspace.agent_boot_id=prepared.predecessor_binding_id)
          OR (current.engine_instance_id=target.id AND current.workspace_id=workspace.id AND current.org_id=workspace.org_id
            AND prepared.predecessor_binding_id=current.predecessor_binding_id
            AND prepared.predecessor_writer_epoch=current.predecessor_writer_epoch
            AND prepared.predecessor_retired_at=current.predecessor_retired_at
            AND prepared.ancestor_writer_epoch=current.ancestor_writer_epoch AND prepared.ancestor_seal_sha256=current.ancestor_seal_sha256
            AND prepared.mirrored_sequence=current.mirrored_sequence))`,
    [engine.workspaceId, engine.organizationId, engine.engineInstanceId, hint.recoveryId, hint.writerEpoch, currentRecoveryId ?? null])).rows[0];
    if (!row) rejected();
    result.push(CloudAgentHistoryRecoveryPreparedCustodySchema.parse({ scope: row.scope,
      recoveryId: hint.recoveryId, retiredAt: row.retired_at }));
  }
  return result;
}

async function revalidatePreparedCustody(tx: Tx, engine: Pick<Engine, "engineInstanceId" | "workspaceId" | "organizationId">,
  recoveryId: string, value: unknown, hints?: CustodyHint): Promise<PreparedCustody> {
  const parsed = CloudAgentHistoryRecoveryPreparedCustodySchema.array().max(2).safeParse(value);
  if (!parsed.success) rejected();
  const savedHints = parsed.data.map(item => ({ writerEpoch: item.scope.writerEpoch, recoveryId: item.recoveryId }));
  const normalized = (input: CustodyHint) => input.map(item => `${item.writerEpoch}:${item.recoveryId}`).sort().join(",");
  if (hints && normalized(hints) !== normalized(savedHints)) rejected();
  const observed = await preparedCustody(tx, engine, savedHints, recoveryId);
  if (JSON.stringify(observed) !== JSON.stringify(parsed.data)) rejected();
  return observed;
}

/** This is authority for one explicit history gap, not execution or a bearer.
 * No material is delivered and no writer is allocated. The exact source comes
 * from the persisted pointer, never a caller selector or latest-writer guess. */
export async function authorizeCloudAgentHistoryRecovery(pool: pg.Pool, engine: Engine, workosEnabled: boolean, hints: CustodyHint = [], checkpointOnly = false) {
  return withSystemTx(pool, async tx => {
    const candidate = (await tx.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL",
      [engine.workspaceId, engine.organizationId],
    )).rows[0];
    if (!candidate) rejected();
    // Match bootstrap's owner -> organization/workspace/engine lock order.
    await serializeCloudAgentCredentialSourceMutation(tx, candidate.owner_user_id);
    await assertCurrentCloudEngineAuthority(tx, { ...engine, workosEnabled });
    const target = (await tx.query<Target>(`SELECT engine.runtime_boot_id,engine.cloud_local_commands_version,
        workspace.owner_user_id,workspace.agent_funding_owner_epoch
      FROM cloud_workspace_engine_instances engine JOIN cloud_workspaces workspace ON workspace.id=engine.workspace_id
        AND workspace.org_id=engine.org_id
      WHERE engine.id=$1 AND workspace.id=$2 AND workspace.org_id=$3 AND engine.generation=$4`,
    [engine.engineInstanceId, engine.workspaceId, engine.organizationId, engine.generation])).rows[0];
    if (!target || target.owner_user_id !== candidate.owner_user_id) rejected();
    if (target.cloud_local_commands_version !== 1)
      throw new HttpError(409, "cloud_runtime_upgrade_required", "cloud_runtime_upgrade_required");
    if (checkpointOnly && hints.length) rejected();
    const owner = checkpointOnly ? await checkpointHistoryOwner(tx, engine.engineInstanceId) : null;
    if (owner) await retireCloudAgentBootSources(tx, { ...engine, generation: owner.source_generation },
      { kind: "owner-discard", receiptId: owner.id, engineInstanceId: owner.engine_instance_id });
    const existing = (await tx.query<{ id: string }>("SELECT id FROM cloud_agent_history_recoveries WHERE engine_instance_id=$1", [engine.engineInstanceId])).rows[0];
    if (existing && checkpointOnly !== !!(await tx.query("SELECT 1 FROM cloud_agent_checkpoint_history_snapshots WHERE recovery_id=$1", [existing.id])).rowCount)
      rejected();
    if (!existing) {
      const prepared = await preparedCustody(tx, engine, hints);
      const inserted = await tx.query(`INSERT INTO cloud_agent_history_recoveries
        (workspace_id,org_id,generation,engine_instance_id,boot_id,funding_owner_user_id,funding_owner_epoch,
         predecessor_binding_id,predecessor_writer_epoch,predecessor_retired_at,ancestor_writer_epoch,ancestor_seal_sha256,mirrored_sequence,prepared_custody)
        SELECT workspace.id,workspace.org_id,$4,target.id,target.runtime_boot_id,workspace.owner_user_id,workspace.agent_funding_owner_epoch,
          binding.id,source.writer_epoch,source.retired_at,ancestor.writer_epoch,ancestor.seal->>'sha256',source.mirrored_sequence,$5::jsonb
        FROM cloud_workspaces workspace
        JOIN cloud_workspace_engine_instances target ON target.id=$1 AND target.workspace_id=workspace.id AND target.org_id=workspace.org_id
        JOIN cloud_agent_boot_bindings binding ON binding.id=workspace.agent_boot_id AND binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
        JOIN cloud_workspace_local_command_writers source ON source.workspace_id=binding.workspace_id AND source.org_id=binding.org_id
          AND source.writer_epoch=binding.writer_epoch
        JOIN cloud_workspace_engine_instances source_engine ON source_engine.id=source.engine_instance_id
        JOIN LATERAL (
          SELECT writer.writer_epoch,writer.seal FROM cloud_workspace_local_command_writers writer
          JOIN cloud_workspace_engine_instances prior_engine ON prior_engine.id=writer.engine_instance_id
          WHERE writer.workspace_id=workspace.id AND writer.org_id=workspace.org_id AND writer.state='retired'
            AND writer.generation<=source.generation AND writer.retired_at<=source.activated_at
            AND writer.seal_ack IS NOT NULL AND prior_engine.enrollment_order<source_engine.enrollment_order
          ORDER BY prior_engine.enrollment_order DESC LIMIT 1
        ) ancestor ON true
        WHERE workspace.id=$2 AND workspace.org_id=$3 AND workspace.agent_command_mode='boot-owner-v1'
          AND binding.retired_at IS NOT NULL AND source.state='retired' AND source.seal IS NULL
          AND source.generation<=$4 AND target.enrollment_order>source_engine.enrollment_order
        ON CONFLICT(engine_instance_id) DO NOTHING RETURNING id`,
      [engine.engineInstanceId, engine.workspaceId, engine.organizationId, engine.generation, JSON.stringify(prepared)]);
      if (inserted.rowCount !== 1) rejected();
    }
    const row = (await tx.query<{
      id: string; predecessor_retired_at: Date; predecessor: unknown; ancestor_writer_epoch: string;
      ancestor_seal_sha256: string; mirrored_sequence: string; prepared_custody: unknown; predecessor_recovery: unknown | null;
    }>(`SELECT recovery.id,recovery.predecessor_retired_at,recovery.ancestor_writer_epoch,recovery.ancestor_seal_sha256,recovery.mirrored_sequence,recovery.prepared_custody,
        CASE WHEN prior.id IS NULL THEN NULL ELSE jsonb_build_object('recoveryId',prior.id,'custodySha256',prior.custody_sha256) END AS predecessor_recovery,
        jsonb_build_object('organizationId',source.org_id,'workspaceId',source.workspace_id,'generation',source.generation,
          'engineInstanceId',source.engine_instance_id,'bootId',source.boot_id,'writerEpoch',source.writer_epoch,
          'fundingOwnerUserId',source.funding_owner_user_id,'fundingOwnerEpoch',source.funding_owner_epoch) AS predecessor
      FROM cloud_agent_history_recoveries recovery
      JOIN cloud_workspaces workspace ON workspace.id=recovery.workspace_id AND workspace.org_id=recovery.org_id
      JOIN cloud_agent_boot_bindings current ON current.id=workspace.agent_boot_id
      JOIN cloud_agent_boot_bindings predecessor_binding ON predecessor_binding.id=recovery.predecessor_binding_id
      JOIN cloud_workspace_local_command_writers source ON source.workspace_id=recovery.workspace_id
        AND source.org_id=recovery.org_id AND source.writer_epoch=recovery.predecessor_writer_epoch
      LEFT JOIN cloud_agent_history_recoveries prior ON prior.workspace_id=source.workspace_id AND prior.org_id=source.org_id
        AND prior.successor_writer_epoch=source.writer_epoch AND prior.activated_at IS NOT NULL
      WHERE recovery.engine_instance_id=$1 AND recovery.workspace_id=$2 AND recovery.org_id=$3 AND recovery.generation=$4
        AND recovery.boot_id=$5 AND recovery.funding_owner_user_id=$6 AND recovery.funding_owner_epoch=$7
        AND source.state='retired' AND source.seal IS NULL AND source.retired_at=recovery.predecessor_retired_at
        AND source.mirrored_sequence=recovery.mirrored_sequence AND predecessor_binding.retired_at IS NOT NULL
        AND ((recovery.activated_at IS NULL AND current.id=recovery.predecessor_binding_id)
          OR (recovery.activated_at IS NOT NULL AND current.engine_instance_id=recovery.engine_instance_id
            AND current.writer_epoch=recovery.successor_writer_epoch AND current.retired_at IS NULL))`,
    [engine.engineInstanceId, engine.workspaceId, engine.organizationId, engine.generation,
      target.runtime_boot_id, target.owner_user_id, target.agent_funding_owner_epoch])).rows[0];
    if (!row) rejected();
    const prepared = await revalidatePreparedCustody(tx, engine, row.id, row.prepared_custody, hints);
    const snapshot = owner ? await checkpointHistorySnapshot(tx, row.id, row.predecessor as CloudAgentBootScope, owner) : undefined;
    await assertCloudEngineAuthorityDeadline(tx, engine.engineInstanceId, workosEnabled);
    return CloudAgentHistoryRecoveryResponseSchema.parse({ version: 1, mode: "boot-owner-v1",
      organizationId: engine.organizationId, workspaceId: engine.workspaceId, generation: engine.generation,
      engineInstanceId: engine.engineInstanceId, bootId: target.runtime_boot_id,
      fundingOwnerUserId: target.owner_user_id, fundingOwnerEpoch: Number(target.agent_funding_owner_epoch),
      recoveryId: row.id, code: "history_recovered_with_gap", coverage: "unknown", predecessor: row.predecessor,
      predecessorRetiredAt: row.predecessor_retired_at.toISOString(), mirroredSequence: Number(row.mirrored_sequence),
      checkpoint: { writerEpoch: row.ancestor_writer_epoch, sha256: row.ancestor_seal_sha256 }, preparedCustody: prepared,
      ...(snapshot ? { checkpointOnly: snapshot } : {}),
      ...(row.predecessor_recovery ? { predecessorRecovery: row.predecessor_recovery } : {}) });
  });
}

/** Called under bootstrap's parent locks, before changing the active pointer.
 * A pre-authorized gap cannot survive source replacement or A -> B -> A. */
export async function checkCloudAgentHistoryActivation(tx: Tx, scope: CloudAgentBootScope, recoveryId?: string,
  custodySha256?: string): Promise<string | null> {
  if ((recoveryId === undefined) !== (custodySha256 === undefined) || custodySha256 !== undefined && !/^[a-f0-9]{64}$/.test(custodySha256)) rejected();
  const source = (await tx.query<{ writer_epoch: string | null; state: string | null; seal: unknown }>(
    `SELECT writer.writer_epoch,writer.state,writer.seal FROM cloud_workspaces workspace
      LEFT JOIN cloud_agent_boot_bindings binding ON binding.id=workspace.agent_boot_id
      LEFT JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=binding.workspace_id
        AND writer.org_id=binding.org_id AND writer.writer_epoch=binding.writer_epoch
      WHERE workspace.id=$1 AND workspace.org_id=$2`, [scope.workspaceId, scope.organizationId],
  )).rows[0];
  if (!source) rejected();
  if (!recoveryId) {
    if (source.writer_epoch && source.writer_epoch !== scope.writerEpoch && source.seal === null)
      throw new HttpError(409, "cloud_history_recovery_required", "cloud_history_recovery_required");
    // An activation retry after a gap must still name the same receipt.
    if ((await tx.query("SELECT 1 FROM cloud_agent_history_recoveries WHERE engine_instance_id=$1 AND activated_at IS NOT NULL", [scope.engineInstanceId])).rowCount) rejected();
    return null;
  }
  const row = (await tx.query<{ activated_at: Date | null; prepared_custody: unknown; custody_sha256: string | null }>(`SELECT recovery.activated_at,recovery.prepared_custody,recovery.custody_sha256
    FROM cloud_agent_history_recoveries recovery
    JOIN cloud_workspaces workspace ON workspace.id=recovery.workspace_id AND workspace.org_id=recovery.org_id
    JOIN cloud_agent_boot_bindings current ON current.id=workspace.agent_boot_id
    JOIN cloud_agent_boot_bindings predecessor_binding ON predecessor_binding.id=recovery.predecessor_binding_id
    JOIN cloud_workspace_local_command_writers predecessor ON predecessor.workspace_id=recovery.workspace_id
      AND predecessor.org_id=recovery.org_id AND predecessor.writer_epoch=recovery.predecessor_writer_epoch
    JOIN cloud_workspace_local_command_writers ancestor ON ancestor.workspace_id=recovery.workspace_id
      AND ancestor.org_id=recovery.org_id AND ancestor.writer_epoch=recovery.ancestor_writer_epoch
    WHERE recovery.id=$1 AND recovery.workspace_id=$2 AND recovery.org_id=$3 AND recovery.generation=$4
      AND recovery.engine_instance_id=$5 AND recovery.boot_id=$6
      AND recovery.funding_owner_user_id=$7 AND recovery.funding_owner_epoch=$8
      AND workspace.owner_user_id=recovery.funding_owner_user_id AND workspace.agent_funding_owner_epoch=recovery.funding_owner_epoch
      AND predecessor.state='retired' AND predecessor.seal IS NULL AND predecessor.retired_at=recovery.predecessor_retired_at
      AND predecessor.mirrored_sequence=recovery.mirrored_sequence AND predecessor_binding.retired_at IS NOT NULL
      AND ancestor.state='retired' AND ancestor.seal_ack IS NOT NULL AND ancestor.seal->>'sha256'=recovery.ancestor_seal_sha256
      AND ((recovery.activated_at IS NULL AND current.id=recovery.predecessor_binding_id)
        OR (recovery.activated_at IS NOT NULL AND current.engine_instance_id=$5 AND current.writer_epoch=$9
          AND recovery.successor_writer_epoch=$9 AND current.retired_at IS NULL))`,
  [recoveryId, scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId, scope.bootId,
    scope.fundingOwnerUserId, scope.fundingOwnerEpoch, scope.writerEpoch])).rows[0];
  if (!row) rejected();
  await checkCheckpointHistoryActivation(tx, recoveryId, scope.engineInstanceId);
  if (row.activated_at && row.custody_sha256 !== custodySha256) rejected();
  await revalidatePreparedCustody(tx, scope, recoveryId, row.prepared_custody);
  return row.activated_at ? null : recoveryId;
}

/** Same transaction as native-writer activation and pointer publication. A
 * lost response can replay that activation, never mint another gap receipt. */
export async function completeCloudAgentHistoryActivation(tx: Tx, scope: CloudAgentBootScope, recoveryId: string, custodySha256: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(custodySha256)) rejected();
  const updated = await tx.query(`UPDATE cloud_agent_history_recoveries SET successor_writer_epoch=$2,activated_at=clock_timestamp(),custody_sha256=$6
    WHERE id=$1 AND engine_instance_id=$3 AND workspace_id=$4 AND org_id=$5 AND activated_at IS NULL`,
  [recoveryId, scope.writerEpoch, scope.engineInstanceId, scope.workspaceId, scope.organizationId, custodySha256]);
  if (updated.rowCount !== 1) rejected();
  await audit(tx, scope.organizationId, null, "cloud_workspace.history_recovered_with_gap", {
    recoveryId, workspaceId: scope.workspaceId, generation: scope.generation, writerEpoch: scope.writerEpoch, coverage: "unknown",
  });
}
