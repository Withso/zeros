import { randomUUID } from "node:crypto";

import type pg from "pg";

import { withSystemTx, type Tx } from "../db.js";

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
};

const SAFE_IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,128}$/;

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
    }>(
      `INSERT INTO workspace_checkpoint_requests (
         id, workspace_id, generation, org_id, requested_by,
         lifecycle_intent_id, reason, idempotency_key, deadline_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         now() + ($9::bigint * interval '1 millisecond')
       )
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id, deadline_at, generation, lifecycle_intent_id, reason`,
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
      }>(
        `SELECT id, deadline_at, generation, lifecycle_intent_id, reason
         FROM workspace_checkpoint_requests
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey],
      )
    ).rows[0];
  if (
    !row ||
    row.generation !== input.generation ||
    row.lifecycle_intent_id !== (input.lifecycleIntentId ?? null) ||
    row.reason !== input.reason
  ) {
    throw new Error("workspace checkpoint request idempotency conflict");
  }
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
  },
): Promise<WorkspaceCheckpointDirective | null> {
  const row = (
    await tx.query<{
      id: string;
      reason: WorkspaceCheckpointRequestReason;
      deadline_at: Date;
    }>(
      `UPDATE workspace_checkpoint_requests request
       SET state = 'delivered', delivery_count = delivery_count + 1,
           last_delivered_at = now()
       WHERE request.id = (
         SELECT candidate.id
         FROM workspace_checkpoint_requests candidate
         WHERE candidate.workspace_id = $1 AND candidate.org_id = $2
           AND candidate.generation = $3
           AND candidate.state IN ('queued', 'delivered')
           AND candidate.deadline_at > now()
         ORDER BY candidate.created_at, candidate.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING request.id, request.reason, request.deadline_at`,
      [input.workspaceId, input.organizationId, input.generation],
    )
  ).rows[0];
  return row
    ? {
        id: row.id,
        reason: row.reason,
        deadlineAtMs: row.deadline_at.getTime(),
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
  },
): Promise<void> {
  const result = await tx.query(
    `UPDATE workspace_checkpoint_requests
     SET state = 'succeeded', checkpoint_id = $6, completed_at = now(),
         error_code = NULL
     WHERE id = $1 AND workspace_id = $2 AND org_id = $3
       AND generation = $4 AND reason = $5
       AND state IN ('queued', 'delivered') AND deadline_at > now()`,
    [
      input.requestId,
      input.workspaceId,
      input.organizationId,
      input.generation,
      input.reason,
      input.checkpointId,
    ],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("workspace checkpoint request is no longer current");
  }
}

/** Expires checkpoint gates without changing workspace authority. A failed
 * final checkpoint leaves the source running and makes the lifecycle intent
 * retryable by an explicit new user request; it never guesses that shutdown is
 * safe. */
export class CloudWorkspaceCheckpointRequestWorker {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: {
      intervalMs?: number;
      logger?: Pick<Console, "error">;
    } = {},
  ) {
    const interval = options.intervalMs ?? 5_000;
    if (
      !Number.isSafeInteger(interval) ||
      interval < 500 ||
      interval > 300_000
    ) {
      throw new Error("workspace checkpoint request worker timing is invalid");
    }
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped) {
      throw new Error("workspace checkpoint request worker lifecycle is invalid");
    }
    this.started = true;
    const run = (): void => {
      if (this.stopped) return;
      const task = this.expireOnce()
        .then(() => undefined)
        .catch((error) => {
        (this.options.logger ?? console).error(
          `[cloud-workspace] checkpoint expiry tick failed: ${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
        });
      this.active = task;
      void task.finally(() => {
        if (this.active === task) this.active = null;
        if (this.stopped) return;
        this.timer = setTimeout(run, this.options.intervalMs ?? 5_000);
        this.timer.unref();
      });
    };
    run();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  async expireOnce(): Promise<number> {
    return withSystemTx(this.pool, async (tx) => {
      const expired = await tx.query<{
        id: string;
        lifecycle_intent_id: string | null;
      }>(
        `UPDATE workspace_checkpoint_requests request
         SET state = 'expired', completed_at = now(),
             error_code = 'checkpoint_deadline_exceeded'
         WHERE request.id IN (
           SELECT candidate.id
           FROM workspace_checkpoint_requests candidate
           WHERE candidate.state IN ('queued', 'delivered')
             AND candidate.deadline_at <= now()
           ORDER BY candidate.deadline_at, candidate.id
           FOR UPDATE SKIP LOCKED
           LIMIT 100
         )
         RETURNING request.id, request.lifecycle_intent_id`,
      );
      const intentIds = expired.rows
        .map((row) => row.lifecycle_intent_id)
        .filter((id): id is string => id !== null);
      if (intentIds.length > 0) {
        await tx.query(
          `UPDATE cloud_workspace_lifecycle_intents
           SET state = 'failed', completed_at = now(), updated_at = now(),
               error_code = 'checkpoint_deadline_exceeded',
               error_message = 'Final durable checkpoint did not complete'
           WHERE id = ANY($1::uuid[]) AND state IN ('queued', 'observing')`,
          [intentIds],
        );
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
      }
      return expired.rowCount ?? 0;
    });
  }
}
