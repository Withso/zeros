import type pg from "pg";
import { DatabaseAcquireTimeoutError, withSystemTx } from "../db.js";
import { CloudCheckpointProgressSchema, type CloudCheckpointProgress } from "./checkpoint-progress-contract.js";
import { assertCurrentCloudEngineAuthority, CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";

export type CloudEngineCheckpointProgressInput = CloudCheckpointProgress & { token: string };

export class CloudEngineCheckpointProgressRejected extends Error {
  readonly code = "engine_checkpoint_progress_rejected";
  constructor() { super("Cloud engine checkpoint progress was rejected"); }
}

export class CloudEngineCheckpointProgressUnavailable extends Error {
  readonly code = "engine_checkpoint_progress_unavailable";
  constructor() { super("Cloud engine checkpoint progress is unavailable"); }
}

/** Closed operational evidence only. No delivery, checkpoint, seal, lease or
 * authority mutation. Receipts keep the audit trail's existing erasure policy. */
export class CloudEngineCheckpointProgress {
  constructor(private readonly pool: pg.Pool, private readonly options: { workosEnabled: boolean }) {}

  async report(input: CloudEngineCheckpointProgressInput): Promise<void> {
    const { token, ...body } = input;
    const parsed = CloudCheckpointProgressSchema.safeParse(body);
    if (!parsed.success || !/^zwh_[A-Za-z0-9_-]{43}$/.test(token)) throw new CloudEngineCheckpointProgressRejected();
    // PostgreSQL UUIDs are case-insensitive; JSON audit keys are not. One
    // canonical key must own replay, first failure and the sixty-four-row cap.
    const progress = { ...parsed.data,
      organizationId: parsed.data.organizationId.toLowerCase(), workspaceId: parsed.data.workspaceId.toLowerCase(),
      engineInstanceId: parsed.data.engineInstanceId.toLowerCase(), requestId: parsed.data.requestId.toLowerCase(),
    };
    try {
      await withSystemTx(this.pool, async tx => {
        // Optional diagnostics must release contended authority promptly. These
        // transaction-local limits never change a checkpoint or engine deadline.
        await tx.query("SET LOCAL lock_timeout='250ms'; SET LOCAL statement_timeout='500ms'");
        await assertCurrentCloudEngineAuthority(tx, {
          ...progress, heartbeatToken: token, workosEnabled: this.options.workosEnabled,
        });
        const request = (await tx.query<{ created_at: Date; deadline_at: Date; window_ms: number }>(
          `SELECT request.created_at,request.deadline_at,
             floor(extract(epoch FROM request.deadline_at-request.created_at)*1000)::int AS window_ms
           FROM workspace_checkpoint_requests request
           JOIN cloud_workspace_engine_instances engine ON engine.id=$5
             AND engine.workspace_id=request.workspace_id AND engine.org_id=request.org_id
             AND engine.generation=request.generation
           WHERE request.id=$1 AND request.workspace_id=$2 AND request.org_id=$3 AND request.generation=$4
             AND request.state='delivered' AND request.delivery_count>0
             AND request.last_delivered_at>=engine.created_at
             AND request.deadline_at>clock_timestamp() AND engine.revoked_at IS NULL
           FOR UPDATE OF request`,
          [progress.requestId, progress.workspaceId, progress.organizationId, progress.generation, progress.engineInstanceId],
        )).rows[0];
        if (!request || progress.elapsedMs > request.window_ms) throw new CloudEngineCheckpointProgressRejected();

        // The org/time index bounds the search to the original request window;
        // the workspace authority lock serializes all writers for this request.
        const rows = (await tx.query<{ subject: unknown }>(
          `SELECT subject FROM audit_log WHERE org_id=$1 AND created_at>=$2 AND created_at<=$3
             AND action='cloud_workspace.checkpoint_progress' AND subject->>'requestId'=$4
           ORDER BY created_at,id LIMIT 65`,
          [progress.organizationId, request.created_at, request.deadline_at, progress.requestId],
        )).rows;
        if (rows.length > 64) throw new CloudEngineCheckpointProgressRejected();
        const receipts = rows.map(row => {
          const receipt = CloudCheckpointProgressSchema.safeParse(row.subject);
          if (!receipt.success || receipt.data.engineInstanceId !== progress.engineInstanceId ||
              receipt.data.workspaceId !== progress.workspaceId || receipt.data.organizationId !== progress.organizationId ||
              receipt.data.generation !== progress.generation) throw new CloudEngineCheckpointProgressRejected();
          return receipt.data;
        });
        const duplicate = receipts.find(receipt => receipt.sequence === progress.sequence);
        if (duplicate) {
          if (JSON.stringify(duplicate) !== JSON.stringify(progress)) throw new CloudEngineCheckpointProgressRejected();
          return;
        }
        // A late first failure is useful even after a newer running edge. Once
        // recorded, later cleanup/completion cannot replace or obscure it.
        if (receipts.some(receipt => receipt.state === "failed")) return;
        if (progress.state !== "failed" && receipts.some(receipt => receipt.sequence > progress.sequence)) return;
        const inserted = await tx.query(
          `INSERT INTO audit_log(org_id,actor_id,action,subject,created_at)
           SELECT $2,NULL,'cloud_workspace.checkpoint_progress',$3::jsonb,clock_timestamp()
           FROM workspace_checkpoint_requests request
           JOIN cloud_workspace_engine_instances engine ON engine.id=$4
           WHERE request.id=$1 AND request.state='delivered' AND request.deadline_at>clock_timestamp()
             AND engine.lease_expires_at>clock_timestamp() AND engine.revoked_at IS NULL
             AND cloud_workspace_runtime_authority_live(engine.workspace_id,engine.generation,engine.account_user_id,$5)
           RETURNING id`,
          [progress.requestId, progress.organizationId, JSON.stringify(progress), progress.engineInstanceId, this.options.workosEnabled],
        );
        if (inserted.rowCount !== 1) throw new CloudEngineCheckpointProgressRejected();
      });
    } catch (error) {
      if (error instanceof CloudWorkspaceEngineAuthorityError) throw new CloudEngineCheckpointProgressRejected();
      if (error instanceof DatabaseAcquireTimeoutError || (error instanceof Error && "code" in error &&
          (error.code === "55P03" || error.code === "57014"))) throw new CloudEngineCheckpointProgressUnavailable();
      throw error;
    }
  }
}
