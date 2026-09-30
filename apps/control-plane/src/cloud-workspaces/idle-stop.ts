import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { withSystemTx } from "../db.js";
import { audit } from "../audit.js";
import type { CloudActorEngineScope } from "./actor-sessions.js";
import { assertCurrentCloudEngineAuthority, assertCloudEngineIdentityForIdempotentReplay } from "./engine-authority.js";
import { enqueueWorkspaceCheckpointRequest, type WorkspaceCheckpointDirective } from "./checkpoint-requests.js";
import { cloudWorkspaceHasActiveWork } from "./idle-workloads.js";

export const CLOUD_IDLE_STOP_PATH = "/internal/v1/cloud-workspaces/engine/idle-stop";
export class DatabaseCloudIdleStop {
  constructor(private readonly pool: pg.Pool, private readonly workosEnabled: boolean) {}
  async request(scope: CloudActorEngineScope, attemptId: string): Promise<WorkspaceCheckpointDirective | null> {
    if (!z.string().uuid().safeParse(attemptId).success) throw new Error("Invalid idle stop attempt");
    return withSystemTx(this.pool, async tx => {
      await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.workosEnabled });
      // A fresh/replacement worker must observe a full quiet interval itself.
      if (!(await tx.query("SELECT 1 FROM cloud_workspace_engine_instances WHERE id=$1 AND created_at<=clock_timestamp()-interval '10 minutes'", [scope.engineInstanceId])).rowCount ||
          await cloudWorkspaceHasActiveWork(tx, scope)) return null;
      const active = await tx.query<{ id: string; deadline_at: Date; idle_engine_instance_id: string | null; request_state: string | null }>(`SELECT request.id,request.deadline_at,request.idle_engine_instance_id,request.state AS request_state
        FROM cloud_workspace_lifecycle_intents intent LEFT JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=intent.id
        WHERE intent.workspace_id=$1 AND intent.org_id=$2 AND intent.affects_workspace AND intent.state IN ('queued','observing','dispatching')`, [scope.workspaceId, scope.organizationId]);
      if (active.rowCount) {
        const prior = active.rows.length === 1 ? active.rows[0] : undefined;
        return prior?.idle_engine_instance_id === scope.engineInstanceId && ["queued", "delivered"].includes(prior.request_state ?? "") && prior.deadline_at.getTime() > Date.now()
          ? { id: prior.id, reason: "before_stop", deadlineAtMs: prior.deadline_at.getTime(), idleStop: true } : null;
      }
      const intentId = randomUUID(), key = `system:idle:${scope.engineInstanceId}:${attemptId}`;
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
        VALUES($1,$2,$3,$4,NULL,'stop',$5,$6)`, [intentId, scope.workspaceId, scope.generation, scope.organizationId, key, createHash("sha256").update(key).digest()]);
      const checkpoint = await enqueueWorkspaceCheckpointRequest(tx, { ...scope, requestedBy: null, lifecycleIntentId: intentId,
        reason: "before_stop", idempotencyKey: `idle.${intentId}`, deadlineMs: 5 * 60_000 });
      await tx.query("UPDATE workspace_checkpoint_requests SET idle_engine_instance_id=$2 WHERE id=$1", [checkpoint.id, scope.engineInstanceId]);
      await audit(tx, scope.organizationId, null, "cloud_workspace.idle_stop_requested", { workspaceId: scope.workspaceId, generation: scope.generation, idleMinutes: 10 });
      return { id: checkpoint.id, reason: "before_stop", deadlineAtMs: checkpoint.deadlineAt.getTime(), idleStop: true };
    });
  }
  async cancel(scope: CloudActorEngineScope, requestId: string): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await assertCloudEngineIdentityForIdempotentReplay(tx, scope);
      // The same acknowledged cancellation is usable by an explicit final
      // capture. Authenticate the submitting epoch; an old engine cannot
      // cancel a later engine's unassigned user-requested checkpoint.
      const request = (await tx.query<{ state: string }>(`SELECT request.state FROM workspace_checkpoint_requests request
        WHERE request.id=$1 AND request.workspace_id=$2 AND request.org_id=$3 AND request.generation=$4
          AND (request.idle_engine_instance_id=$5 OR (request.idle_engine_instance_id IS NULL
            AND request.reason IN ('before_stop','before_archive','before_delete') AND EXISTS (
              SELECT 1 FROM cloud_workspace_engine_instances engine WHERE engine.id=$5 AND engine.workspace_id=$2
                AND engine.generation=$4 AND engine.created_at<=request.created_at AND engine.state='ready' AND engine.revoked_at IS NULL)))`,
        [requestId, scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId])).rows[0];
      if (!request || request.state === 'succeeded') throw new Error("Final checkpoint cannot be cancelled");
      await tx.query(`WITH cancelled AS (UPDATE workspace_checkpoint_requests SET state='cancelled',completed_at=now(),error_code='workspace_active'
        WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND state IN ('queued','delivered') RETURNING lifecycle_intent_id)
        UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now(),error_code='workspace_active'
        WHERE id IN (SELECT lifecycle_intent_id FROM cancelled) AND state IN ('queued','observing')`,
      [requestId, scope.workspaceId, scope.organizationId, scope.generation]);
    });
  }
}
const requestSchema = z.object({ workspaceId: z.string().uuid(), organizationId: z.string().uuid(), generation: z.number().int().positive().safe(), engineInstanceId: z.string().uuid(),
  request: z.discriminatedUnion("kind", [z.object({ kind: z.literal("request"), attemptId: z.string().uuid() }).strict(), z.object({ kind: z.literal("cancel"), requestId: z.string().uuid() }).strict()]),
}).strict();
export function createCloudIdleStopRoutes(service: DatabaseCloudIdleStop): Hono {
  const app = new Hono();
  app.use(CLOUD_IDLE_STOP_PATH, bodyLimit({ maxSize: 4096 }));
  app.post(CLOUD_IDLE_STOP_PATH, async c => {
    c.header("Cache-Control", "no-store");
    const heartbeatToken = /^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!heartbeatToken) return c.json({ error: "engine_authority_rejected" }, 401);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_idle_stop" }, 422);
    const { request, ...identity } = parsed.data, scope = { ...identity, heartbeatToken };
    try {
      if (request.kind === "cancel") { await service.cancel(scope, request.requestId); return c.json({ cancelled: true }); }
      return c.json({ checkpoint: await service.request(scope, request.attemptId) });
    } catch { return c.json({ error: "idle_stop_rejected" }, 403); }
  });
  return app;
}
