import { randomUUID } from "node:crypto";

import type pg from "pg";

import { withSystemTx } from "../db.js";

export interface CloudWorkspaceDeletionObjectService {
  deleteUnreferencedSystem(input: {
    blobId: string;
    organizationId: string;
  }): Promise<
    "deleted" | "already_deleted" | "still_referenced" | "protected"
  >;
}

type DeletionJob = {
  id: string;
  workspaceId: string;
  organizationId: string;
  state: "waiting_for_provider" | "deleting_objects" | "deleting_records";
  leaseOwner: string;
  attemptCount: number;
};

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempt, 9));
}

function failureCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^[a-z][a-z0-9_]{2,127}$/u.test(error.message)
  ) {
    return error.message;
  }
  return "workspace_deletion_unknown_failure";
}

/**
 * Production housekeeping that is deliberately independent from sandbox
 * setup. Every mutation is tenant-scoped and lease/idempotency safe, so any
 * Railway replica can take over after a crash.
 */
export class CloudWorkspaceOperationsWorker {
  private readonly workerId: string;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly deletionBatchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly objects: CloudWorkspaceDeletionObjectService,
    private readonly options: {
      workerId?: string;
      intervalMs?: number;
      leaseMs?: number;
      maxAttempts?: number;
      deletionBatchSize?: number;
      logger?: Pick<Console, "error">;
    } = {},
  ) {
    this.workerId = options.workerId ?? `cloud-operations:${randomUUID()}`;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.deletionBatchSize = options.deletionBatchSize ?? 50;
    if (
      this.workerId.length < 1 ||
      this.workerId.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(this.workerId) ||
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 1_000 ||
      this.intervalMs > 300_000 ||
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 5_000 ||
      this.leaseMs > 3_600_000 ||
      !Number.isSafeInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 100 ||
      !Number.isSafeInteger(this.deletionBatchSize) ||
      this.deletionBatchSize < 1 ||
      this.deletionBatchSize > 1_000
    ) {
      throw new Error("cloud workspace operations configuration is invalid");
    }
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped) {
      throw new Error("cloud workspace operations lifecycle is invalid");
    }
    this.started = true;
    const tick = () => {
      if (this.stopped) return;
      const task = this.runOnce()
        .then(() => undefined)
        .catch((error) => {
          (this.options.logger ?? console).error(
            `[cloud-workspace] operations tick failed: ${
              error instanceof Error ? error.name : "unknown"
            }`,
          );
        });
      this.active = task;
      void task.finally(() => {
        if (this.active === task) this.active = null;
        if (this.stopped) return;
        this.timer = setTimeout(tick, this.intervalMs);
        this.timer.unref();
      });
    };
    tick();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  async runOnce(): Promise<{
    expiredExports: number;
    deletionSteps: number;
    retentionApplied: boolean;
  }> {
    let expiredExports = 0;
    while (expiredExports < 100 && (await this.expireExportOnce())) {
      expiredExports += 1;
    }
    let deletionSteps = 0;
    while (
      deletionSteps < this.deletionBatchSize &&
      (await this.processDeletionOnce())
    ) {
      deletionSteps += 1;
    }
    const retentionApplied = await this.applyRetentionOnce();
    await withSystemTx(this.pool, (tx) =>
      tx.query(`DELETE FROM device_request_nonces WHERE expires_at <= now()`),
    );
    return { expiredExports, deletionSteps, retentionApplied };
  }

  async expireExportOnce(): Promise<boolean> {
    return withSystemTx(this.pool, async (tx) => {
      const row = (
        await tx.query<{ id: string }>(
          `SELECT id
           FROM workspace_exports
           WHERE state = 'available' AND expires_at <= now()
           ORDER BY expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
        )
      ).rows[0];
      if (!row) return false;
      await tx.query(
        `UPDATE workspace_export_grants
         SET revoked_at = coalesce(revoked_at, now())
         WHERE export_id = $1 AND revoked_at IS NULL`,
        [row.id],
      );
      await tx.query(
        `DELETE FROM workspace_blob_references
         WHERE reference_kind = 'export' AND reference_id = $1`,
        [row.id],
      );
      await tx.query(
        `UPDATE workspace_exports
         SET state = 'expired', checkpoint_id = NULL,
             lease_owner = NULL, lease_expires_at = NULL,
             completed_at = coalesce(completed_at, now())
         WHERE id = $1 AND state = 'available'`,
        [row.id],
      );
      return true;
    });
  }

  async applyRetentionOnce(): Promise<boolean> {
    return withSystemTx(this.pool, async (tx) => {
      await tx.query(
        `INSERT INTO workspace_retention_policies (workspace_id, org_id)
         SELECT workspace.id, workspace.org_id
         FROM cloud_workspaces workspace
         WHERE workspace.data_deleted_at IS NULL
         ON CONFLICT (workspace_id) DO NOTHING`,
      );
      const policy = (
        await tx.query<{
          workspace_id: string;
          org_id: string;
          record_event_days: number;
          content_event_days: number;
          checkpoint_days: number;
          legal_hold: boolean;
        }>(
          `SELECT policy.workspace_id, policy.org_id,
                  policy.record_event_days, policy.content_event_days,
                  policy.checkpoint_days, policy.legal_hold
           FROM workspace_retention_policies policy
           JOIN cloud_workspaces workspace
             ON workspace.id = policy.workspace_id
            AND workspace.org_id = policy.org_id
           WHERE workspace.data_deleted_at IS NULL
           ORDER BY policy.last_applied_at NULLS FIRST, policy.workspace_id
           FOR UPDATE OF policy SKIP LOCKED
           LIMIT 1`,
        )
      ).rows[0];
      if (!policy) return false;
      if (!policy.legal_hold) {
        // Completed request rows are operational delivery state, not audit
        // history. Release them before selecting checkpoint candidates.
        await tx.query(
          `DELETE FROM workspace_checkpoint_requests request
           USING workspace_checkpoints checkpoint
           WHERE request.checkpoint_id = checkpoint.id
             AND request.workspace_id = $1 AND request.org_id = $2
             AND request.completed_at <=
                 now() - ($3::integer * interval '1 day')
             AND checkpoint.id <> coalesce((
               SELECT current_checkpoint_id FROM workspace_content_heads
               WHERE workspace_id = $1 AND org_id = $2
             ), '00000000-0000-0000-0000-000000000000'::uuid)
             AND NOT EXISTS (
               SELECT 1 FROM cloud_workspace_generations generation
               WHERE generation.workspace_id = $1 AND generation.org_id = $2
                 AND generation.recovery_checkpoint_id = checkpoint.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM workspace_exports export
               WHERE export.checkpoint_id = checkpoint.id
             )`,
          [
            policy.workspace_id,
            policy.org_id,
            policy.checkpoint_days,
          ],
        );

        const checkpointIds = (
          await tx.query<{ id: string }>(
            `SELECT checkpoint.id
             FROM workspace_checkpoints checkpoint
             WHERE checkpoint.workspace_id = $1 AND checkpoint.org_id = $2
               AND checkpoint.created_at <=
                   now() - ($3::integer * interval '1 day')
               AND checkpoint.state IN ('durable', 'invalid')
               AND NOT checkpoint.legal_hold
               AND (checkpoint.retention_until IS NULL
                    OR checkpoint.retention_until <= now())
               AND checkpoint.id <> coalesce((
                 SELECT current_checkpoint_id FROM workspace_content_heads
                 WHERE workspace_id = $1 AND org_id = $2
               ), '00000000-0000-0000-0000-000000000000'::uuid)
               AND NOT EXISTS (
                 SELECT 1 FROM cloud_workspace_generations generation
                 WHERE generation.workspace_id = $1 AND generation.org_id = $2
                   AND generation.recovery_checkpoint_id = checkpoint.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM workspace_checkpoint_requests request
                 WHERE request.checkpoint_id = checkpoint.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM workspace_exports export
                 WHERE export.checkpoint_id = checkpoint.id
               )
             ORDER BY checkpoint.created_at, checkpoint.id
             FOR UPDATE SKIP LOCKED
             LIMIT 100`,
            [
              policy.workspace_id,
              policy.org_id,
              policy.checkpoint_days,
            ],
          )
        ).rows.map((row) => row.id);
        if (checkpointIds.length > 0) {
          await tx.query(
            `DELETE FROM workspace_blob_references
             WHERE workspace_id = $1 AND org_id = $2
               AND reference_kind IN (
                 'checkpoint_manifest', 'checkpoint_artifact', 'checkpoint_file'
               )
               AND reference_id = ANY($3::text[])`,
            [policy.workspace_id, policy.org_id, checkpointIds],
          );
          await tx.query(
            `DELETE FROM workspace_checkpoints
             WHERE workspace_id = $1 AND org_id = $2
               AND id = ANY($3::uuid[])`,
            [policy.workspace_id, policy.org_id, checkpointIds],
          );
        }

        const contentHead = (
          await tx.query<{
            current_revision: string | number;
            durable_revision: string | number;
            minimum_retained_revision: string | number;
            current_checkpoint_id: string | null;
          }>(
            `SELECT current_revision, durable_revision,
                    minimum_retained_revision, current_checkpoint_id
             FROM workspace_content_heads
             WHERE workspace_id = $1 AND org_id = $2
             FOR UPDATE`,
            [policy.workspace_id, policy.org_id],
          )
        ).rows[0];
        if (contentHead?.current_checkpoint_id) {
          const timeUpper = Number(
            (
              await tx.query<{ revision: string | number | null }>(
                `SELECT max(revision)::bigint AS revision
                 FROM workspace_content_revisions
                 WHERE workspace_id = $1 AND org_id = $2
                   AND created_at <=
                       now() - ($3::integer * interval '1 day')`,
                [
                  policy.workspace_id,
                  policy.org_id,
                  policy.content_event_days,
                ],
              )
            ).rows[0]?.revision ?? 0,
          );
          const protectedRevision = Number(
            (
              await tx.query<{ revision: string | number | null }>(
                `SELECT min(content_revision)::bigint AS revision
                 FROM workspace_checkpoints
                 WHERE workspace_id = $1 AND org_id = $2`,
                [policy.workspace_id, policy.org_id],
              )
            ).rows[0]?.revision ??
              Number(contentHead.current_revision) + 1,
          );
          const cutoff = Math.min(
            timeUpper,
            Number(contentHead.durable_revision),
            protectedRevision - 1,
          );
          if (cutoff > Number(contentHead.minimum_retained_revision)) {
            await tx.query(
              `DELETE FROM workspace_blob_references reference
               USING workspace_file_events event
               WHERE reference.workspace_id = $1 AND reference.org_id = $2
                 AND reference.reference_kind = 'file_event'
                 AND event.workspace_id = $1 AND event.org_id = $2
                 AND event.revision <= $3
                 AND reference.blob_id = event.blob_id
                 AND reference.reference_id =
                     event.workspace_id::text || ':' || event.revision::text ||
                     ':' || event.sequence::text`,
              [policy.workspace_id, policy.org_id, cutoff],
            );
            await tx.query(
              `DELETE FROM workspace_content_revisions
               WHERE workspace_id = $1 AND org_id = $2 AND revision <= $3`,
              [policy.workspace_id, policy.org_id, cutoff],
            );
            await tx.query(
              `UPDATE workspace_content_heads
               SET minimum_retained_revision = $3, updated_at = now()
               WHERE workspace_id = $1 AND org_id = $2`,
              [policy.workspace_id, policy.org_id, cutoff],
            );
          }
        }

        const recordHead = (
          await tx.query<{
            current_revision: string | number;
            minimum_retained_revision: string | number;
          }>(
            `SELECT current_revision, minimum_retained_revision
             FROM workspace_record_heads
             WHERE workspace_id = $1 AND org_id = $2
             FOR UPDATE`,
            [policy.workspace_id, policy.org_id],
          )
        ).rows[0];
        if (recordHead) {
          const activeChatExport =
            (
              await tx.query(
                `SELECT 1 FROM workspace_exports
                 WHERE workspace_id = $1 AND org_id = $2
                   AND state = 'available' AND expires_at > now()
                   AND include_chats
                 LIMIT 1`,
                [policy.workspace_id, policy.org_id],
              )
            ).rowCount !== 0;
          if (!activeChatExport) {
            const cutoff = Number(
              (
                await tx.query<{ revision: string | number }>(
                  `SELECT coalesce(
                            min(first_revision) - 1,
                            $4::bigint
                          )::bigint AS revision
                   FROM workspace_record_batches
                   WHERE workspace_id = $1 AND org_id = $2
                     AND created_at >
                         now() - ($3::integer * interval '1 day')`,
                  [
                    policy.workspace_id,
                    policy.org_id,
                    policy.record_event_days,
                    Number(recordHead.current_revision),
                  ],
                )
              ).rows[0]!.revision,
            );
            if (cutoff > Number(recordHead.minimum_retained_revision)) {
              await tx.query(
                `DELETE FROM workspace_record_entities
                 WHERE workspace_id = $1 AND org_id = $2
                   AND tombstoned_at IS NOT NULL AND revision <= $3`,
                [policy.workspace_id, policy.org_id, cutoff],
              );
              await tx.query(
                `DELETE FROM workspace_record_batches
                 WHERE workspace_id = $1 AND org_id = $2
                   AND last_revision <= $3`,
                [policy.workspace_id, policy.org_id, cutoff],
              );
              await tx.query(
                `UPDATE workspace_record_heads
                 SET minimum_retained_revision = $3, updated_at = now()
                 WHERE workspace_id = $1 AND org_id = $2`,
                [policy.workspace_id, policy.org_id, cutoff],
              );
            }
          }
        }
      }
      await tx.query(
        `UPDATE workspace_retention_policies
         SET last_applied_at = now()
         WHERE workspace_id = $1 AND org_id = $2`,
        [policy.workspace_id, policy.org_id],
      );
      return true;
    });
  }

  private async discoverDeletionJobs(): Promise<void> {
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `INSERT INTO workspace_deletion_jobs (
           workspace_id, org_id, requested_by, idempotency_key
         )
         SELECT workspace.id, workspace.org_id,
                coalesce((
                  SELECT intent.requested_by
                  FROM cloud_workspace_lifecycle_intents intent
                  WHERE intent.workspace_id = workspace.id
                    AND intent.org_id = workspace.org_id
                    AND intent.operation = 'delete'
                  ORDER BY intent.created_at DESC LIMIT 1
                ), workspace.owner_user_id),
                'workspace-delete-v1'
         FROM cloud_workspaces workspace
         WHERE workspace.desired_state = 'deleted'
           AND workspace.data_deleted_at IS NULL
         ON CONFLICT (workspace_id, org_id) DO NOTHING`,
      ),
    );
  }

  private async claimDeletionJob(): Promise<DeletionJob | null> {
    return withSystemTx(this.pool, async (tx) => {
      const row = (
        await tx.query<{
          id: string;
          workspace_id: string;
          org_id: string;
          state: DeletionJob["state"];
          attempt_count: number;
        }>(
          `WITH candidate AS (
             SELECT job.id
             FROM workspace_deletion_jobs job
             JOIN cloud_workspaces workspace
               ON workspace.id = job.workspace_id AND workspace.org_id = job.org_id
             LEFT JOIN workspace_retention_policies policy
               ON policy.workspace_id = job.workspace_id AND policy.org_id = job.org_id
             WHERE job.state IN (
                     'waiting_for_provider', 'deleting_objects', 'deleting_records'
                   )
               AND job.next_attempt_at <= now()
               AND (job.lease_owner IS NULL OR job.lease_expires_at <= now())
               AND workspace.status = 'deleted'
               AND workspace.data_deleted_at IS NULL
               AND coalesce(policy.legal_hold, false) = false
               AND NOT EXISTS (
                 SELECT 1 FROM workspace_blob_references reference
                 JOIN workspace_blobs blob
                   ON blob.id = reference.blob_id AND blob.org_id = reference.org_id
                 WHERE reference.workspace_id = job.workspace_id
                   AND reference.org_id = job.org_id AND blob.legal_hold
               )
               AND NOT EXISTS (
                 SELECT 1 FROM workspace_checkpoints checkpoint
                 WHERE checkpoint.workspace_id = job.workspace_id
                   AND checkpoint.org_id = job.org_id AND checkpoint.legal_hold
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM cloud_workspace_generations generation
                 LEFT JOIN cloud_workspace_provider_bindings binding
                   ON binding.workspace_id = generation.workspace_id
                  AND binding.generation = generation.generation
                  AND binding.org_id = generation.org_id
                 WHERE generation.workspace_id = job.workspace_id
                   AND generation.org_id = job.org_id
                   AND binding.deletion_verified_at IS NULL
               )
             ORDER BY job.next_attempt_at, job.created_at, job.id
             FOR UPDATE OF job SKIP LOCKED
             LIMIT 1
           )
           UPDATE workspace_deletion_jobs job
           SET lease_owner = $1,
               lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
               last_started_at = now(), updated_at = now(), error_code = NULL
           FROM candidate
           WHERE job.id = candidate.id
           RETURNING job.id, job.workspace_id, job.org_id, job.state,
                     job.attempt_count`,
          [this.workerId, this.leaseMs],
        )
      ).rows[0];
      return row
        ? {
            id: row.id,
            workspaceId: row.workspace_id,
            organizationId: row.org_id,
            state: row.state,
            leaseOwner: this.workerId,
            attemptCount: row.attempt_count,
          }
        : null;
    });
  }

  async processDeletionOnce(): Promise<boolean> {
    await this.discoverDeletionJobs();
    const job = await this.claimDeletionJob();
    if (!job) return false;
    try {
      if (job.state === "waiting_for_provider") {
        await this.detachDeletionObjects(job);
      } else if (job.state === "deleting_objects") {
        await this.deleteNextObject(job);
      } else {
        await this.purgeDeletionRecords(job);
      }
    } catch (error) {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_deletion_jobs
           SET attempt_count = attempt_count + 1,
               state = CASE WHEN attempt_count + 1 >= $3
                            THEN 'failed' ELSE state END,
               lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = now() +
                 ($4::bigint * interval '1 millisecond'),
               error_code = $5, updated_at = now(),
               completed_at = CASE WHEN attempt_count + 1 >= $3
                                   THEN now() ELSE NULL END
           WHERE id = $1 AND lease_owner = $2`,
          [
            job.id,
            job.leaseOwner,
            this.maxAttempts,
            retryDelayMs(job.attemptCount + 1),
            failureCode(error),
          ],
        ),
      );
      (this.options.logger ?? console).error(
        `[cloud-workspace] deletion step failed (${failureCode(error)})`,
      );
    }
    return true;
  }

  private async detachDeletionObjects(job: DeletionJob): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM workspace_deletion_jobs
         WHERE id = $1 AND state = 'waiting_for_provider'
           AND lease_owner = $2 FOR UPDATE`,
        [job.id, job.leaseOwner],
      );
      if ((owned.rowCount ?? 0) !== 1) return;
      await tx.query(
        `UPDATE workspace_fork_intents
         SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
             completed_at = now(), updated_at = now(),
             error_code = 'workspace_deleted'
         WHERE org_id = $1
           AND (source_cloud_workspace_id = $2 OR target_cloud_workspace_id = $2)
           AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
        [job.organizationId, job.workspaceId],
      );
      await tx.query(
        `UPDATE workspace_exports
         SET state = 'expired', checkpoint_id = NULL,
             lease_owner = NULL, lease_expires_at = NULL,
             completed_at = coalesce(completed_at, now())
         WHERE workspace_id = $1 AND org_id = $2
           AND state NOT IN ('expired', 'deleted')`,
        [job.workspaceId, job.organizationId],
      );
      await tx.query(
        `UPDATE workspace_export_grants
         SET revoked_at = coalesce(revoked_at, now())
         WHERE workspace_id = $1 AND org_id = $2 AND revoked_at IS NULL`,
        [job.workspaceId, job.organizationId],
      );
      await tx.query(
        `UPDATE workspace_replica_grants
         SET revoked_at = coalesce(revoked_at, now())
         WHERE workspace_id = $1 AND org_id = $2 AND revoked_at IS NULL`,
        [job.workspaceId, job.organizationId],
      );
      await tx.query(
        `INSERT INTO workspace_deletion_blob_targets (
           job_id, blob_id, org_id, requires_physical_delete, completed_at
         )
         SELECT DISTINCT $1::uuid, reference.blob_id, reference.org_id,
                NOT EXISTS (
                  SELECT 1 FROM workspace_blob_references other
                  WHERE other.blob_id = reference.blob_id
                    AND other.org_id = reference.org_id
                    AND other.workspace_id <> $2
                ),
                CASE WHEN EXISTS (
                  SELECT 1 FROM workspace_blob_references other
                  WHERE other.blob_id = reference.blob_id
                    AND other.org_id = reference.org_id
                    AND other.workspace_id <> $2
                ) THEN now() ELSE NULL END
         FROM workspace_blob_references reference
         WHERE reference.workspace_id = $2 AND reference.org_id = $3
         ON CONFLICT (job_id, blob_id) DO NOTHING`,
        [job.id, job.workspaceId, job.organizationId],
      );
      await tx.query(
        `DELETE FROM workspace_blob_references
         WHERE workspace_id = $1 AND org_id = $2`,
        [job.workspaceId, job.organizationId],
      );
      await tx.query(
        `UPDATE workspace_deletion_jobs
         SET state = 'deleting_objects', lease_owner = NULL,
             lease_expires_at = NULL, next_attempt_at = now(), updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [job.id, job.leaseOwner],
      );
    });
  }

  private async deleteNextObject(job: DeletionJob): Promise<void> {
    const targets = await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM workspace_deletion_jobs
         WHERE id = $1 AND state = 'deleting_objects'
           AND lease_owner = $2 FOR UPDATE`,
        [job.id, job.leaseOwner],
      );
      if ((owned.rowCount ?? 0) !== 1) return [];
      return (
        await tx.query<{ blob_id: string }>(
          `SELECT blob_id FROM workspace_deletion_blob_targets
           WHERE job_id = $1 AND completed_at IS NULL
           ORDER BY created_at, blob_id
           LIMIT $2`,
          [job.id, this.deletionBatchSize],
        )
      ).rows;
    });
    if (targets.length === 0) {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_deletion_jobs
           SET state = 'deleting_records', lease_owner = NULL,
               lease_expires_at = NULL, next_attempt_at = now(), updated_at = now()
           WHERE id = $1 AND state = 'deleting_objects' AND lease_owner = $2`,
          [job.id, job.leaseOwner],
        ),
      );
      return;
    }
    for (const target of targets) {
      const outcome = await this.objects.deleteUnreferencedSystem({
        blobId: target.blob_id,
        organizationId: job.organizationId,
      });
      if (outcome === "protected") {
        throw new Error("workspace_deletion_blob_protected");
      }
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workspace_deletion_blob_targets
           SET completed_at = now()
           WHERE job_id = $1 AND blob_id = $2 AND completed_at IS NULL`,
          [job.id, target.blob_id],
        ),
      );
    }
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE workspace_deletion_jobs
         SET lease_owner = NULL, lease_expires_at = NULL,
             next_attempt_at = now(), updated_at = now()
         WHERE id = $1 AND state = 'deleting_objects' AND lease_owner = $2`,
        [job.id, job.leaseOwner],
      ),
    );
  }

  private async purgeDeletionRecords(job: DeletionJob): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const owned = await tx.query(
        `SELECT 1 FROM workspace_deletion_jobs
         WHERE id = $1 AND state = 'deleting_records'
           AND lease_owner = $2 FOR UPDATE`,
        [job.id, job.leaseOwner],
      );
      if ((owned.rowCount ?? 0) !== 1) return;
      const remaining = await tx.query(
        `SELECT 1 FROM workspace_deletion_blob_targets
         WHERE job_id = $1 AND completed_at IS NULL LIMIT 1`,
        [job.id],
      );
      if ((remaining.rowCount ?? 0) !== 0) {
        throw new Error("workspace_deletion_objects_incomplete");
      }
      const scope = [job.workspaceId, job.organizationId];
      for (const statement of [
        `DELETE FROM workspace_export_grants
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_replica_grants
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_replicas
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_setup_recovery_grants
         WHERE workspace_id = $1 AND org_id = $2`,
        `UPDATE cloud_workspace_generations SET recovery_checkpoint_id = NULL
         WHERE workspace_id = $1 AND org_id = $2`,
        `UPDATE workspace_content_heads SET current_checkpoint_id = NULL
         WHERE workspace_id = $1 AND org_id = $2`,
        `UPDATE workspace_exports
         SET checkpoint_id = NULL, state = CASE
           WHEN state = 'deleted' THEN state ELSE 'expired'::workspace_export_state END,
           lease_owner = NULL, lease_expires_at = NULL
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_checkpoint_requests
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_record_heads
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_content_heads
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_fork_import_entries
         WHERE target_workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_fork_import_records
         WHERE target_workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_ports
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM port_forward_sessions
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_executions
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM cloud_workspace_setup_runs
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM cloud_workspace_endpoint_grants
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM cloud_workspace_client_access_grants
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM cloud_workspace_setup_secrets
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM cloud_workspace_setup_specs
         WHERE workspace_id = $1 AND org_id = $2`,
        `DELETE FROM workspace_settings_versions
         WHERE workspace_id = $1 AND org_id = $2`,
      ]) {
        await tx.query(statement, scope);
      }
      await tx.query(
        `UPDATE cloud_workspaces
         SET data_deleted_at = coalesce(data_deleted_at, now()),
             last_error_code = NULL, last_error_message = NULL,
             updated_at = now(), version = version + 1,
             authority_epoch = authority_epoch + 1
         WHERE id = $1 AND org_id = $2 AND status = 'deleted'`,
        [job.workspaceId, job.organizationId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_outbox (
           org_id, workspace_id, event_type, aggregate_key,
           aggregate_revision, idempotency_key, payload
         )
         SELECT workspace.org_id, workspace.id, 'workspace.data_deleted',
                'workspace:' || workspace.id::text, workspace.version,
                'data-deleted:' || $3,
                jsonb_build_object(
                  'workspaceId', workspace.id,
                  'dataDeletedAt', workspace.data_deleted_at
                )
         FROM cloud_workspaces workspace
         WHERE workspace.id = $1 AND workspace.org_id = $2
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [job.workspaceId, job.organizationId, job.id],
      );
      await tx.query(
        `UPDATE workspace_deletion_jobs
         SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
             error_code = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [job.id, job.leaseOwner],
      );
    });
  }
}
