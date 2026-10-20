import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { assertCloudEngineAuthorityDeadline, assertCloudEngineIdentityForIdempotentReplay, CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";
import { cloudRuntimePin, loadPinnedCloudRuntime, type CloudRuntimePinRow } from "./runtime-selection.js";
import { cloudRuntimeQualificationMode } from "./runtime-config.js";
import { canonicalFinalSaveJson, canonicalFinalSaveSource, CloudFinalSaveDirectiveSchema,
  CloudFinalSaveRequestSchema, CloudFinalSaveSourceSchema, type CloudFinalSaveDirective,
  type CloudFinalSaveRequest, type CloudFinalSaveResponse } from "./final-save-contract.js";
import { ensureFinalSaveRecovery, finalSaveProven, scheduleFinalSaveRecovery } from "./final-save-recovery.js";
import { resolveHistoricalFinalSaveForErasure } from "./final-save-erasure.js";
import { CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, checkpointHintKey } from "./engine-checkpoint-hints.js";

type Recovery = {
  lifecycle_intent_id: string; workspace_id: string; org_id: string; generation: number; operation: "stop" | "archive" | "delete";
  original_request_id: string | null; current_request_id: string | null; attempt_ordinal: number;
  engine_instance_id: string | null; registered_at: Date | null; registration_token_sha256: Buffer | null;
  runtime_id: string | null; boot_id: string | null; writer_epoch: string | null; funding_owner_user_id: string | null;
  funding_owner_epoch: string | null; authority_epoch: string; allocation_lease_id: string | null; provider_resource_id: string | null;
  custody_id: string | null; state: string; next_attempt_at: Date;
};
type Attempt = {
  id: string; state: string; reason: "before_stop" | "before_archive" | "before_delete" | "before_rebuild";
  deadline_at: Date; final_save_attempt_ordinal: number; final_save_retirement_id: string | null;
  final_save_capture_report: CloudFinalSaveRequest | null; final_save_commit_report: CloudFinalSaveRequest | null;
  final_save_reconcile_report: CloudFinalSaveRequest | null; checkpoint_id: string | null; live: boolean;
};
export class CloudFinalSaveRejected extends Error {
  constructor() { super("final_save_rejected"); this.name = "CloudFinalSaveRejected"; }
}
const sameHash = (a: Buffer | null | undefined, b: Buffer) => !!a && a.length === b.length && timingSafeEqual(a, b);
function sourceOf(row: Recovery) {
  const parsed = CloudFinalSaveSourceSchema.safeParse({ organizationId: row.org_id, workspaceId: row.workspace_id,
    generation: row.generation, engineInstanceId: row.engine_instance_id, runtimeId: row.runtime_id, bootId: row.boot_id,
    writerEpoch: row.writer_epoch, fundingOwnerUserId: row.funding_owner_user_id, fundingOwnerEpoch: Number(row.funding_owner_epoch),
    authorityEpoch: Number(row.authority_epoch), registeredAtMs: row.registered_at?.getTime(),
    allocationLeaseId: row.allocation_lease_id, providerResourceId: row.provider_resource_id });
  return parsed.success ? parsed.data : null;
}
const sourceHash = (row: Recovery) => {
  const source = sourceOf(row);
  return source ? createHash("sha256").update(canonicalFinalSaveSource(source)).digest("hex") : null;
};
async function recoveryRow(tx: Tx, id: string): Promise<Recovery | undefined> {
  return (await tx.query<Recovery>("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1 FOR UPDATE", [id])).rows[0];
}
async function attemptRow(tx: Tx, row: Recovery, id: string): Promise<Attempt | undefined> {
  return (await tx.query<Attempt>(`SELECT *,deadline_at>clock_timestamp() AS live FROM workspace_checkpoint_requests
    WHERE id=$1 AND final_save_recovery_id=$2 AND workspace_id=$3 AND org_id=$4 AND generation=$5 FOR UPDATE`,
  [id, row.lifecycle_intent_id, row.workspace_id, row.org_id, row.generation])).rows[0];
}

/** Mutation admission, not historical authentication. No token, lease, funding
 * or native ticket is renewed by this check or by successor creation. */
async function liveSource(tx: Tx, row: Recovery, workosEnabled: boolean, successor = false): Promise<boolean> {
  const source = sourceOf(row);
  if (!source || (successor && !source.allocationLeaseId)) return false;
  const live = (await tx.query<{ live: boolean; fenced: boolean; authority_epoch: string; heartbeat_token_hash: Buffer }>(
    "SELECT * FROM cloud_workspace_engine_authority_current($1,$2,$3,$4,$5,true)",
    [row.workspace_id, row.org_id, row.generation, row.engine_instance_id, workosEnabled])).rows[0];
  if (!live?.live || live.fenced || String(live.authority_epoch) !== String(row.authority_epoch) ||
    !sameHash(live.heartbeat_token_hash, row.registration_token_sha256!)) return false;
  const engine = (await tx.query<CloudRuntimePinRow>(`SELECT engine.runtime_id,engine.runtime_manifest_sha256,engine.runtime_base_image_id,
      engine.runtime_base_compatibility_id,engine.runtime_profile,engine.runtime_engine_protocol_version
    FROM cloud_workspace_engine_instances engine
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.engine_instance_id=engine.id
    JOIN cloud_workspaces workspace ON workspace.id=recovery.workspace_id AND workspace.org_id=recovery.org_id
    JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=recovery.workspace_id
      AND binding.org_id=recovery.org_id AND binding.generation=recovery.generation
    JOIN cloud_agent_boot_bindings boot ON boot.engine_instance_id=engine.id AND boot.workspace_id=engine.workspace_id
      AND boot.org_id=engine.org_id AND boot.generation=engine.generation
    JOIN cloud_workspace_local_command_writers writer ON writer.workspace_id=engine.workspace_id AND writer.writer_epoch=boot.writer_epoch
    WHERE recovery.lifecycle_intent_id=$1 AND engine.final_save_version=1 AND engine.revoked_at IS NULL
      AND engine.registered_at=recovery.registered_at AND engine.heartbeat_token_hash=recovery.registration_token_sha256
      AND engine.runtime_id=recovery.runtime_id AND engine.runtime_boot_id=recovery.boot_id
      AND boot.boot_id=recovery.boot_id AND boot.writer_epoch=recovery.writer_epoch AND boot.retired_at IS NULL
      AND boot.funding_owner_user_id=recovery.funding_owner_user_id AND boot.funding_owner_epoch=recovery.funding_owner_epoch
      AND workspace.current_generation=recovery.generation AND workspace.agent_boot_id=boot.id
      AND workspace.owner_user_id=recovery.funding_owner_user_id AND workspace.agent_funding_owner_epoch=recovery.funding_owner_epoch
      AND writer.org_id=recovery.org_id AND writer.generation=recovery.generation AND writer.engine_instance_id=engine.id
      AND writer.boot_id=recovery.boot_id AND writer.funding_owner_user_id=recovery.funding_owner_user_id
      AND writer.funding_owner_epoch=recovery.funding_owner_epoch AND writer.activated_at IS NOT NULL
      AND writer.state='active' AND (NOT $2 OR (writer.sealed_sequence IS NOT NULL AND writer.seal_ack IS NOT NULL))
      AND binding.provider_resource_id=recovery.provider_resource_id
      AND (recovery.allocation_lease_id IS NULL OR EXISTS (SELECT 1 FROM managed_compute_allocation_leases lease WHERE lease.id=recovery.allocation_lease_id
        AND lease.workspace_id=recovery.workspace_id AND lease.org_id=recovery.org_id
        AND lease.provider_resource_id=recovery.provider_resource_id AND lease.state IN ('active','draining')))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_allocation_owners owner WHERE owner.workspace_id=recovery.workspace_id
        AND owner.provider_resource_id=recovery.provider_resource_id AND
          (owner.current_generation<>recovery.generation OR owner.allocation_lease_id IS DISTINCT FROM recovery.allocation_lease_id))
      AND recovery.allocation_lease_id IS NOT DISTINCT FROM (SELECT latest.id FROM managed_compute_allocation_leases latest
        WHERE latest.workspace_id=recovery.workspace_id AND latest.org_id=recovery.org_id
          AND latest.provider_resource_id=recovery.provider_resource_id ORDER BY latest.created_at DESC,latest.id LIMIT 1)`, [row.lifecycle_intent_id, successor])).rows[0];
  const pin = engine ? cloudRuntimePin(engine) : null;
  if (!pin || !await loadPinnedCloudRuntime(tx, pin, cloudRuntimeQualificationMode())) return false;
  // Qualification reads can wait on revocation locks. The original engine
  // and workspace locks retain identity, but wall-clock authority can expire.
  try { await assertCloudEngineAuthorityDeadline(tx, source.engineInstanceId, workosEnabled); }
  catch (error) { if (error instanceof CloudWorkspaceEngineAuthorityError) return false; throw error; }
  return true;
}

/** Companion only for the exact negotiated engine. N-1 heartbeat bodies and
 * original request states remain byte-compatible when the header is absent. */
export async function readFinalSaveDirective(tx: Tx, input: {
  requestId: string; engineInstanceId?: string; finalSaveVersion?: 1;
}): Promise<CloudFinalSaveDirective | undefined> {
  if (input.finalSaveVersion !== 1 || !input.engineInstanceId) return;
  const row = (await tx.query<Recovery>(`SELECT recovery.* FROM workspace_checkpoint_requests request
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=request.final_save_recovery_id
    JOIN cloud_workspace_engine_instances engine ON engine.id=recovery.engine_instance_id
    WHERE request.id=$1 AND recovery.current_request_id=request.id AND engine.id=$2 AND engine.final_save_version=1
      AND engine.registered_at=recovery.registered_at AND engine.heartbeat_token_hash=recovery.registration_token_sha256
      AND engine.revoked_at IS NULL`, [input.requestId, input.engineInstanceId])).rows[0];
  if (!row) return;
  const source = sourceOf(row), sourceSha256 = sourceHash(row);
  if (!source || !sourceSha256) return;
  const predecessor = row.attempt_ordinal > 0 ? (await tx.query<{ id: string; final_save_retirement_id: string | null }>(
    `SELECT id,final_save_retirement_id FROM workspace_checkpoint_requests WHERE final_save_recovery_id=$1
      AND final_save_attempt_ordinal=$2 AND state IN ('cancelled','expired','failed')`, [row.lifecycle_intent_id, row.attempt_ordinal - 1])).rows[0] : null;
  const parsed = CloudFinalSaveDirectiveSchema.safeParse({ version: 1, recoveryId: row.lifecycle_intent_id,
    attemptOrdinal: row.attempt_ordinal, predecessorRequestId: predecessor?.id ?? null, source, sourceSha256,
    custodyId: row.attempt_ordinal > 0 ? row.custody_id : null, retirementId: predecessor?.final_save_retirement_id ?? null });
  return parsed.success ? parsed.data : undefined;
}

export class DatabaseCloudFinalSaveService {
  constructor(private readonly pool: pg.Pool, private readonly workosEnabled: boolean) {}

  async report(raw: CloudFinalSaveRequest & { token: string }): Promise<CloudFinalSaveResponse> {
    const { token, ...data } = raw;
    const parsed = CloudFinalSaveRequestSchema.safeParse(data);
    if (!parsed.success) throw new CloudFinalSaveRejected();
    const input = parsed.data; // Detached closed copy before the first await.
    return withSystemTx(this.pool, async tx => {
      await assertCloudEngineIdentityForIdempotentReplay(tx, { ...input, heartbeatToken: token });
      const row = await recoveryRow(tx, input.recoveryId);
      const hash = createHash("sha256").update(token).digest();
      if (!row || row.workspace_id !== input.workspaceId || row.org_id !== input.organizationId || row.generation !== input.generation ||
        row.engine_instance_id !== input.engineInstanceId || !sameHash(row.registration_token_sha256, hash) || sourceHash(row) !== input.sourceSha256)
        throw new CloudFinalSaveRejected();
      // Historical reads bypass only mutation/lease freshness. The original
      // registration and both token hashes must still match; revoked/replaced
      // credentials cannot read another incarnation's receipt or tombstone.
      if (!(await tx.query(`SELECT 1 FROM cloud_workspace_engine_instances engine
        JOIN cloud_workspace_final_save_recoveries recovery ON recovery.engine_instance_id=engine.id
        WHERE recovery.lifecycle_intent_id=$1 AND engine.registered_at=recovery.registered_at
          AND engine.heartbeat_token_hash=recovery.registration_token_sha256 AND engine.revoked_at IS NULL
          AND engine.final_save_version=1`, [row.lifecycle_intent_id])).rowCount) throw new CloudFinalSaveRejected();
      const request = await attemptRow(tx, row, input.requestId);
      if (!request || request.final_save_attempt_ordinal !== input.attemptOrdinal ||
        (row.custody_id !== null && row.custody_id !== input.custodyId)) throw new CloudFinalSaveRejected();
      if (row.custody_id === null) {
        if (input.attemptOrdinal !== 0 || row.original_request_id !== input.requestId) throw new CloudFinalSaveRejected();
        await tx.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=$1", [input.recoveryId, input.custodyId]);
        row.custody_id = input.custodyId;
      }
      const echo = { version: 1 as const, recoveryId: input.recoveryId, requestId: input.requestId,
        attemptOrdinal: input.attemptOrdinal, sourceSha256: input.sourceSha256, custodyId: input.custodyId };
      const previousCommit = request.final_save_commit_report?.commit ?? request.final_save_reconcile_report?.commit;
      if (previousCommit && canonicalFinalSaveJson(previousCommit) !== canonicalFinalSaveJson(input.commit)) throw new CloudFinalSaveRejected();

      if (request.state === "succeeded") {
        const checkpoint = (await tx.query<{ id: string; content_revision: string; integrity_sha256: Buffer; request_sha256: Buffer; final_save_body_sha256: Buffer | null }>(
          `SELECT id,content_revision,integrity_sha256,request_sha256,final_save_body_sha256 FROM workspace_checkpoints
           WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND idempotency_key=$5
             AND state='durable' AND invalidated_at IS NULL`,
          [request.checkpoint_id, row.workspace_id, row.org_id, row.generation, input.commit?.idempotencyKey ?? null])).rows[0];
        if (!input.commit || !checkpoint || checkpoint.request_sha256.toString("hex") !== input.commit.requestSha256 ||
          checkpoint.final_save_body_sha256?.toString("hex") !== input.commit.bodySha256) throw new CloudFinalSaveRejected();
        await markProven(tx, row);
        return { ...echo, state: "committed", checkpoint: { checkpointId: checkpoint.id,
          contentRevision: Number(checkpoint.content_revision), manifestSha256: checkpoint.integrity_sha256.toString("hex"),
          reason: request.reason, requestSha256: checkpoint.request_sha256.toString("hex") } };
      }
      // A pre-deadline reconcile is not a post-join expiry witness. Only the
      // exact after-deadline report can admit a successor from frozen custody.
      if (input.kind === "reconcile" && request.live && ["queued", "delivered", "recovery_queued", "recovery_delivered"].includes(request.state))
        return { ...echo, state: "waiting", retryAtMs: request.deadline_at.getTime() };
      const column = input.kind === "reconcile" ? "final_save_reconcile_report" : input.failure === "commit_ambiguous" ? "final_save_commit_report" : "final_save_capture_report";
      const previous = request[column];
      if (previous && canonicalFinalSaveJson(previous) !== canonicalFinalSaveJson(input)) throw new CloudFinalSaveRejected();
      if (!previous) await tx.query(`UPDATE workspace_checkpoint_requests SET ${column}=$2::jsonb WHERE id=$1`, [input.requestId, JSON.stringify(input)]);

      if (!request.live || ["expired", "cancelled", "failed"].includes(request.state)) {
        // This workspace lock is the same serialization point as commit. A
        // prior committed row was handled above; a late new commit now loses.
        if (["queued", "delivered", "recovery_queued", "recovery_delivered"].includes(request.state))
          await tx.query(`UPDATE workspace_checkpoint_requests SET state='expired',completed_at=clock_timestamp(),
            error_code='checkpoint_deadline_exceeded' WHERE id=$1`, [input.requestId]);
        const retired = await attemptRow(tx, row, input.requestId);
        if (!retired?.final_save_retirement_id) throw new CloudFinalSaveRejected();
        if (!previous && row.current_request_id === input.requestId) await scheduleFinalSaveRecovery(tx, {
          intentId: row.lifecycle_intent_id, requestId: input.requestId, failure: "checkpoint_deadline_exceeded" });
        const next = await recoveryRow(tx, row.lifecycle_intent_id);
        return { ...echo, state: "retired", retirementId: retired.final_save_retirement_id, retryAtMs: next!.next_attempt_at.getTime() };
      }
      if (row.current_request_id !== input.requestId) throw new CloudFinalSaveRejected();
      const live = await liveSource(tx, row, this.workosEnabled);
      if (!previous || row.state === "capturing") await scheduleFinalSaveRecovery(tx, { intentId: row.lifecycle_intent_id, requestId: input.requestId,
        failure: live && input.kind === "retry" ? input.failure : "authority", blocked: !live });
      const next = await recoveryRow(tx, row.lifecycle_intent_id);
      return live ? { ...echo, state: "waiting", retryAtMs: next!.next_attempt_at.getTime() }
        : { ...echo, state: "blocked", reason: "authority", retryAtMs: next!.next_attempt_at.getTime() };
    });
  }
}

async function markProven(tx: Tx, row: Recovery): Promise<boolean> {
  if (!await finalSaveProven(tx, row.lifecycle_intent_id)) return false;
  await tx.query(`UPDATE cloud_workspace_final_save_recoveries recovery SET state='proven',
    proven_request_id=request.id,checkpoint_id=request.checkpoint_id,last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
    FROM workspace_checkpoint_requests request WHERE recovery.lifecycle_intent_id=$1 AND request.id=recovery.current_request_id
      AND recovery.state NOT IN ('proven','resolved')`, [row.lifecycle_intent_id]);
  return true;
}

/** Called by the checkpoint worker's durable job, one workspace at a time.
 * No network/provider calls and no execution authority renewal. */
export async function runFinalSaveRecovery(pool: pg.Pool, workspaceId: string | null, workosEnabled: boolean): Promise<number> {
  return withSystemTx(pool, async tx => {
    const candidate = (await tx.query<{ workspace_id: string; org_id: string }>(`SELECT recovery.workspace_id,recovery.org_id
      FROM cloud_workspace_final_save_recoveries recovery JOIN organizations organization ON organization.id=recovery.org_id
      WHERE recovery.state NOT IN ('proven','resolved') AND recovery.next_attempt_at<=clock_timestamp()
        AND ($1::uuid IS NULL OR recovery.workspace_id=$1) ORDER BY recovery.next_attempt_at,recovery.lifecycle_intent_id
      FOR UPDATE OF organization SKIP LOCKED LIMIT 1`, [workspaceId])).rows[0];
    if (!candidate) return 0;
    if (!(await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE SKIP LOCKED", [candidate.workspace_id, candidate.org_id])).rowCount) return 0;
    const rows = await tx.query<Recovery>(`SELECT * FROM cloud_workspace_final_save_recoveries
      WHERE workspace_id=$1 AND org_id=$2 AND state NOT IN ('proven','resolved') AND next_attempt_at<=clock_timestamp()
      ORDER BY next_attempt_at,lifecycle_intent_id LIMIT 8 FOR UPDATE`, [candidate.workspace_id, candidate.org_id]);
    for (const candidate of rows.rows) {
      await ensureFinalSaveRecovery(tx, candidate.lifecycle_intent_id);
      const row = (await recoveryRow(tx, candidate.lifecycle_intent_id))!;
      if (await resolveHistoricalFinalSaveForErasure(tx, row.lifecycle_intent_id)) continue;
      if (await markProven(tx, row)) continue;
      let request = row.current_request_id ? await attemptRow(tx, row, row.current_request_id) : undefined;
      if (!request) { await scheduleFinalSaveRecovery(tx, { intentId: row.lifecycle_intent_id, failure: "source_unavailable", blocked: true }); continue; }
      await tx.query("UPDATE cloud_workspace_final_save_recoveries SET last_checked_at=clock_timestamp() WHERE lifecycle_intent_id=$1", [row.lifecycle_intent_id]);
      if (request.live && ["queued", "delivered", "recovery_queued", "recovery_delivered"].includes(request.state)) {
        // The engine consumes the same request; the deadline never restarts.
        await tx.query(`UPDATE cloud_workspace_final_save_recoveries SET state=CASE WHEN state='reconciling' THEN state ELSE 'capturing' END,
          next_attempt_at=$2 WHERE lifecycle_intent_id=$1`, [row.lifecycle_intent_id, request.deadline_at]);
        await tx.query("SELECT pg_notify($1,$2)", [CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, checkpointHintKey(row.workspace_id, row.generation)]);
        continue;
      }
      if (["queued", "delivered", "recovery_queued", "recovery_delivered"].includes(request.state)) {
        await tx.query(`UPDATE workspace_checkpoint_requests SET state='expired',completed_at=clock_timestamp(),error_code='checkpoint_deadline_exceeded' WHERE id=$1`, [request.id]);
        request = (await attemptRow(tx, row, request.id))!;
      }
      if (!request.final_save_reconcile_report || !row.custody_id || !request.final_save_retirement_id) {
        await scheduleFinalSaveRecovery(tx, { intentId: row.lifecycle_intent_id, failure: "custody", blocked: true }); continue;
      }
      if (!await liveSource(tx, row, workosEnabled, true)) {
        await scheduleFinalSaveRecovery(tx, { intentId: row.lifecycle_intent_id, failure: "authority", blocked: true }); continue;
      }
      const nextId = randomUUID();
      await tx.query(`INSERT INTO workspace_checkpoint_requests(id,workspace_id,org_id,generation,reason,state,idempotency_key,
        final_save_recovery_id,final_save_attempt_ordinal,deadline_at)
        VALUES($1,$2,$3,$4,$5,'recovery_queued',$6,$7,$8,clock_timestamp()+interval '5 minutes')`,
      [nextId, row.workspace_id, row.org_id, row.generation, request.reason, `final-save.${row.lifecycle_intent_id}.${row.attempt_ordinal + 1}`,
        row.lifecycle_intent_id, row.attempt_ordinal + 1]);
      await tx.query(`UPDATE cloud_workspace_final_save_recoveries SET current_request_id=$2,attempt_ordinal=attempt_ordinal+1,
        state='capturing',next_attempt_at=(SELECT deadline_at FROM workspace_checkpoint_requests WHERE id=$2),updated_at=clock_timestamp()
        WHERE lifecycle_intent_id=$1 AND current_request_id=$3`, [row.lifecycle_intent_id, nextId, request.id]);
      await tx.query("SELECT pg_notify($1,$2)", [CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, checkpointHintKey(row.workspace_id, row.generation)]);
    }
    return rows.rowCount ?? 0;
  });
}
