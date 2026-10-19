import { CloudWorkerScheduler } from "./worker-scheduler.js";
import { readCloudWorkerNextDelay } from "./worker-deadlines.js";
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { withSystemTx, type Tx } from "../db.js";
import { cloudWorkspaceHasActiveWork } from "./idle-workloads.js";
import { CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, checkpointHintKey } from "./engine-checkpoint-hints.js";
import { CloudFinalSaveRejected, readFinalSaveDirective, runFinalSaveRecovery } from "./final-save-service.js";
import type { CloudFinalSaveDirective } from "./final-save-contract.js";
import { ensureFinalSaveRecovery, finalSaveProven } from "./final-save-recovery.js";

export type WorkspaceCheckpointRequestReason =
  | "before_stop"
  | "before_archive"
  | "before_delete"
  | "before_fork"
  | "before_rebuild"
  | "manual";

export type WorkspaceCheckpointDirective = {
  id: string;
  reason: WorkspaceCheckpointRequestReason;
  deadlineAtMs: number;
  idleStop?: true;
  finalSave?: CloudFinalSaveDirective;
};

const SAFE_IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,128}$/;

/** Caller owns the workspace lock. A fresh engine invalidates reuse of an old
 * final proof; the old engine's own fence remains permanent. */
export async function loadCommittedFinalCheckpoint(tx: Tx, workspaceId: string, generation: number) {
  const proof = (await tx.query<{ checkpoint_id: string; lifecycle_intent_id: string; intent_state: string }>(
    `SELECT request.checkpoint_id, intent.id AS lifecycle_intent_id, intent.state AS intent_state
     FROM workspace_checkpoint_requests request
     JOIN cloud_workspace_lifecycle_intents intent ON intent.id=coalesce(request.final_save_recovery_id,request.lifecycle_intent_id)
     WHERE request.workspace_id=$1 AND request.generation=$2 AND request.state='succeeded'
       AND request.reason IN ('before_stop','before_archive','before_delete')
       AND NOT EXISTS (SELECT 1 FROM cloud_workspace_engine_instances instance
         WHERE instance.workspace_id=request.workspace_id AND instance.generation=request.generation
           AND instance.created_at>request.completed_at)
     ORDER BY request.completed_at DESC, request.id LIMIT 1`, [workspaceId, generation])).rows[0] ?? null;
  if (!proof) return null;
  await ensureFinalSaveRecovery(tx, proof.lifecycle_intent_id);
  return await finalSaveProven(tx, proof.lifecycle_intent_id) ? proof : null;
}

export async function enqueueWorkspaceCheckpointRequest(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    requestedBy: string | null;
    lifecycleIntentId?: string;
    reason: WorkspaceCheckpointRequestReason;
    idempotencyKey: string;
    deadlineMs?: number;
  },
): Promise<{ id: string; deadlineAt: Date }> {
  const deadlineMs = input.deadlineMs ?? 5 * 60_000;
  if (
    !SAFE_IDEMPOTENCY.test(input.idempotencyKey) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 30_000 ||
    deadlineMs > 30 * 60_000
  ) {
    throw new Error("workspace checkpoint request input is invalid");
  }
  const id = randomUUID();
  const row = (
    await tx.query<{
      id: string;
      deadline_at: Date;
      generation: number;
      lifecycle_intent_id: string | null;
      reason: WorkspaceCheckpointRequestReason;
      requested_by:string|null;
    }>(
      `INSERT INTO workspace_checkpoint_requests (
         id, workspace_id, generation, org_id, requested_by,
         lifecycle_intent_id, reason, idempotency_key, deadline_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         now() + ($9::bigint * interval '1 millisecond')
       )
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id, deadline_at, generation, lifecycle_intent_id, reason, requested_by`,
      [
        id,
        input.workspaceId,
        input.generation,
        input.organizationId,
        input.requestedBy,
        input.lifecycleIntentId ?? null,
        input.reason,
        input.idempotencyKey,
        deadlineMs,
      ],
    )
  ).rows[0] ??
    (
      await tx.query<{
        id: string;
        deadline_at: Date;
        generation: number;
        lifecycle_intent_id: string | null;
        reason: WorkspaceCheckpointRequestReason;
        requested_by:string|null;
      }>(
        `SELECT id, deadline_at, generation, lifecycle_intent_id, reason, requested_by
         FROM workspace_checkpoint_requests
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey],
      )
    ).rows[0];
  if (
    !row ||
    row.generation !== input.generation ||
    row.lifecycle_intent_id !== (input.lifecycleIntentId ?? null) ||
    row.requested_by!==input.requestedBy ||
    row.reason !== input.reason
  ) {
    throw new Error("workspace checkpoint request idempotency conflict");
  }
  // Wakes an engine waiting for a checkpoint hint once this commits. The
  // payload is a lookup key, not authority; delivery stays on the heartbeat.
  await tx.query("SELECT pg_notify($1,$2)", [CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL,
    checkpointHintKey(input.workspaceId, input.generation)]);
  return { id: row.id, deadlineAt: row.deadline_at };
}

/** Called only after the heartbeat transaction has proved exact live engine
 * authority. Re-delivery is intentional: the engine deduplicates by request id
 * and the checkpoint commit is itself idempotent. */
export async function deliverWorkspaceCheckpointRequest(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId?: string;
    finalSaveVersion?: 1;
  },
): Promise<WorkspaceCheckpointDirective | null> {
  const row = (
    await tx.query<{
      id: string;
      reason: WorkspaceCheckpointRequestReason;
      deadline_at: Date;
      idle_engine_instance_id: string | null;
      final_save_attempt_ordinal: number | null;
    }>(
      `UPDATE workspace_checkpoint_requests request
       SET state = CASE WHEN request.final_save_attempt_ordinal>0 THEN 'recovery_delivered' ELSE 'delivered' END, delivery_count = delivery_count + 1,
           last_delivered_at = now()
       WHERE request.id = (
         SELECT candidate.id
         FROM workspace_checkpoint_requests candidate
         WHERE candidate.workspace_id = $1 AND candidate.org_id = $2
           AND candidate.generation = $3
           AND (candidate.state IN ('queued','delivered') OR ($4=1 AND candidate.state IN ('recovery_queued','recovery_delivered')
             AND EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries recovery
               JOIN cloud_workspace_engine_instances engine ON engine.id=recovery.engine_instance_id
               WHERE recovery.lifecycle_intent_id=candidate.final_save_recovery_id AND recovery.current_request_id=candidate.id
                 AND engine.id=$5 AND engine.final_save_version=1 AND engine.revoked_at IS NULL
                 AND engine.registered_at=recovery.registered_at AND engine.heartbeat_token_hash=recovery.registration_token_sha256)))
           AND (candidate.final_save_recovery_id IS NULL OR EXISTS (
             SELECT 1 FROM cloud_workspace_final_save_recoveries recovery WHERE recovery.lifecycle_intent_id=candidate.final_save_recovery_id
               AND recovery.current_request_id=candidate.id AND (recovery.state='capturing' OR recovery.next_attempt_at<=clock_timestamp())))
           AND candidate.deadline_at > now()
         ORDER BY candidate.created_at, candidate.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING request.id, request.reason, request.deadline_at, request.idle_engine_instance_id, request.final_save_attempt_ordinal`,
      [input.workspaceId, input.organizationId, input.generation, input.finalSaveVersion ?? null, input.engineInstanceId ?? null],
    )
  ).rows[0];
  const finalSave = row ? await readFinalSaveDirective(tx, { requestId: row.id,
    ...(input.engineInstanceId ? { engineInstanceId: input.engineInstanceId } : {}),
    ...(input.finalSaveVersion ? { finalSaveVersion: input.finalSaveVersion } : {}) }) : undefined;
  if (row?.final_save_attempt_ordinal && !finalSave) throw new CloudFinalSaveRejected();
  return row
    ? {
        id: row.id,
        reason: row.reason,
        deadlineAtMs: row.deadline_at.getTime(),
        ...(finalSave ? { finalSave } : {}),
        ...(row.idle_engine_instance_id ? { idleStop: true as const } : {}),
      }
    : null;
}

export async function completeWorkspaceCheckpointRequest(
  tx: Tx,
  input: {
    requestId: string;
    workspaceId: string;
    organizationId: string;
    generation: number;
    reason: string;
    checkpointId: string;
    engineInstanceId?: string;
  },
): Promise<void> {
  // Order completion with lifecycle admission, including a wake cancelling
  // capture. Content commit already owns these locks; direct callers must too.
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [input.organizationId]);
  await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [input.workspaceId, input.organizationId]);
  const idle = await tx.query("SELECT 1 FROM workspace_checkpoint_requests WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND idle_engine_instance_id IS NOT NULL",
    [input.requestId, input.workspaceId, input.organizationId, input.generation]);
  if (idle.rowCount && await cloudWorkspaceHasActiveWork(tx, input)) throw new Error("Workspace became active before idle checkpoint completed");
  if (["before_stop", "before_archive", "before_delete", "before_rebuild"].includes(input.reason) &&
      (await tx.query(`SELECT 1 FROM cloud_workspace_local_command_writers
        WHERE workspace_id=$1 AND org_id=$2 AND generation=$3 AND state='active' AND sealed_sequence IS NULL`,
      [input.workspaceId, input.organizationId, input.generation])).rowCount) {
    throw new Error("Final checkpoint requires the current native writer seal");
  }
  const result = await tx.query(
    `UPDATE workspace_checkpoint_requests
     SET state = 'succeeded', checkpoint_id = $6, completed_at = clock_timestamp(),
         error_code = NULL
     WHERE id = $1 AND workspace_id = $2 AND org_id = $3
       AND generation = $4 AND reason = $5
       AND state IN ('queued','delivered','recovery_queued','recovery_delivered') AND deadline_at>clock_timestamp()
       AND (final_save_recovery_id IS NULL OR EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries recovery
         JOIN cloud_workspace_engine_instances engine ON engine.id=recovery.engine_instance_id
         WHERE recovery.lifecycle_intent_id=workspace_checkpoint_requests.final_save_recovery_id
           AND recovery.current_request_id=workspace_checkpoint_requests.id
           AND ($7::uuid IS NULL OR engine.id=$7) AND engine.registered_at=recovery.registered_at
           AND engine.heartbeat_token_hash=recovery.registration_token_sha256))`,
    [
      input.requestId,
      input.workspaceId,
      input.organizationId,
      input.generation,
      input.reason,
      input.checkpointId,
      input.engineInstanceId ?? null,
    ],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("workspace checkpoint request is no longer current");
  }
}

/** A finite capture deadline never retires an accepted final-save operation.
 * The recovery row and durable job own retries; unrelated manual/fork request
 * deadlines retain their existing behavior. No provider authority is owned here. */
export class CloudWorkspaceCheckpointRequestWorker {
  private readonly scheduler: CloudWorkerScheduler;
  private started = false;
  private stopped = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: {
      intervalMs?: number;
      workosEnabled?: boolean;
      logger?: Pick<Console, "error">;
    } = {},
  ) {
    const interval = options.intervalMs ?? 60_000;
    if (
      !Number.isSafeInteger(interval) ||
      interval < 500 ||
      interval > 300_000
    ) {
      throw new Error("workspace checkpoint request worker timing is invalid");
    }
    this.scheduler = new CloudWorkerScheduler(interval, async () => { await this.expireOnce(); }, () => {
      (this.options.logger ?? console).error("[cloud-workspace] checkpoint expiry tick failed; will retry");
    }, () => readCloudWorkerNextDelay(this.pool, "checkpoints"), { readBeforeRun: true, jitter: options.intervalMs === undefined });
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped) throw new Error("workspace checkpoint request worker lifecycle is invalid");
    this.started = true;
    this.scheduler.start();
    return () => this.stop();
  }

  notify(): void { this.scheduler.notify(); }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.scheduler.stop();
  }

  recoverOnce(workspaceId: string | null = null): Promise<number> {
    return runFinalSaveRecovery(this.pool, workspaceId, this.options.workosEnabled ?? false);
  }

  async expireOnce(): Promise<number> {
    let count = 0;
    const visited: string[] = [];
    // Acquire parents before children, as lifecycle admission does. Each
    // transaction owns one scope only; a busy organization/workspace must not
    // prevent expiry in another scope or accumulate cross-tenant lock waits.
    for (let attempt = 0; attempt < 32 && count < 100; attempt += 1) {
      const result = await withSystemTx(this.pool, async (tx) => {
        const candidate = (await tx.query<{workspace_id:string;org_id:string}>(
          `SELECT request.workspace_id, request.org_id
           FROM organizations organization
           JOIN workspace_checkpoint_requests request ON request.org_id = organization.id
           WHERE (request.state IN ('queued','delivered','recovery_queued','recovery_delivered') OR
             (request.state='cancelled' AND request.error_code='mandatory_capture_cancelled')) AND request.deadline_at <= now()
             AND (request.final_save_recovery_id IS NULL OR request.state IN ('queued','delivered','recovery_queued','recovery_delivered'))
             AND NOT (request.workspace_id = ANY($1::uuid[]))
           ORDER BY request.deadline_at, request.id
           FOR UPDATE OF organization SKIP LOCKED LIMIT 1`, [visited],
        )).rows[0];
        if (!candidate) return null;
        visited.push(candidate.workspace_id);
        const workspace = await tx.query(
          `SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2
           FOR UPDATE SKIP LOCKED`, [candidate.workspace_id,candidate.org_id],
        );
        if (!workspace.rowCount) return 0;
        const expired = await tx.query<{
        id: string;
        lifecycle_intent_id: string | null;
        generation: number;
        mandatory: boolean;
        final_save_recovery_id: string | null;
      }>(
        `SELECT id, lifecycle_intent_id, generation, final_save_recovery_id, cloud_workspace_drain_is_mandatory(lifecycle_intent_id) AS mandatory
         FROM workspace_checkpoint_requests
         WHERE workspace_id=$1 AND org_id=$2 AND (state IN ('queued','delivered','recovery_queued','recovery_delivered') OR
           (state='cancelled' AND error_code='mandatory_capture_cancelled'))
           AND deadline_at <= now() AND (final_save_recovery_id IS NULL OR state IN ('queued','delivered','recovery_queued','recovery_delivered'))
         ORDER BY deadline_at, id LIMIT $3`,
        [candidate.workspace_id,candidate.org_id,100-count],
      );
      for (const request of expired.rows) {
        if (request.lifecycle_intent_id) {
          await ensureFinalSaveRecovery(tx, request.lifecycle_intent_id);
          request.final_save_recovery_id = (await tx.query<{ final_save_recovery_id: string | null }>(
            "SELECT final_save_recovery_id FROM workspace_checkpoint_requests WHERE id=$1", [request.id])).rows[0]!.final_save_recovery_id;
        }
      }
      const intentIds = expired.rows
        .filter(row => !row.final_save_recovery_id)
        .map((row) => row.lifecycle_intent_id)
        .filter((id): id is string => id !== null);
      if (intentIds.length > 0) {
        const cancelledTransitions = await tx.query<{
          workspace_id: string;
          org_id: string;
          candidate_generation: number;
        }>(
          `UPDATE cloud_workspace_generation_transitions transition
           SET state = 'cancelled', completed_at = now(), updated_at = now(),
               error_code = 'checkpoint_deadline_exceeded',
               error_message = 'Final durable checkpoint did not complete'
           WHERE transition.drain_intent_id = ANY($1::uuid[])
             AND transition.state = 'draining'
           RETURNING transition.workspace_id, transition.org_id,
                     transition.candidate_generation`,
          [intentIds],
        );
        for (const transition of cancelledTransitions.rows) {
          await tx.query(
            `UPDATE cloud_workspace_generations
             SET retired_at = coalesce(retired_at, now())
             WHERE workspace_id = $1 AND org_id = $2 AND generation = $3`,
            [
              transition.workspace_id,
              transition.org_id,
              transition.candidate_generation,
            ],
          );
        }
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'failed', completed_at = now(), updated_at = now(),
               error_code = 'checkpoint_deadline_exceeded',
               error_message = 'Final durable checkpoint did not complete'
           WHERE id = ANY($1::uuid[]) AND state IN ('queued', 'observing')`,
          [intentIds],
        );
      }
      await tx.query(
        `UPDATE workspace_checkpoint_requests
         SET state='expired',completed_at=now(),error_code='checkpoint_deadline_exceeded'
         WHERE id=ANY($1::uuid[]) AND (state IN ('queued','delivered','recovery_queued','recovery_delivered') OR
           (state='cancelled' AND error_code='mandatory_capture_cancelled' AND final_save_recovery_id IS NULL)) AND deadline_at<=now()`,
        [expired.rows.map(row=>row.id)],
      );
      return expired.rowCount ?? 0;
      });
      if(result===null)break;
      count+=result;
    }
    return count;
  }
}
