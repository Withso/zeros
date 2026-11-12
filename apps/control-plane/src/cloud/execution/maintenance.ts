import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { CloudWorkerScheduler } from "../../worker-scheduler.js";
import type { CloudV2ContextReason } from "../contract.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import type { CloudExecutionContexts, ExecutionContext } from "./store.js";

type Revocation = { contextId: string; reason: CloudV2ContextReason; bootId: string };
export class CloudExecutionMaintenance {
  constructor(readonly contexts: CloudExecutionContexts) {}

  async workspace(id: string): Promise<Revocation[]> {
    return withSystemTx(this.contexts.pool, async tx => {
      if (!(await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND execution_mode='active' FOR UPDATE", [id])).rowCount) {
        await tx.query("DELETE FROM cloud_v2_execution_invalidations WHERE workspace_id=$1", [id]);
        return [];
      }
      await this.cancelQueued(tx, id);
      const rows = (await tx.query<ExecutionContext>("SELECT * FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='active' ORDER BY id", [id])).rows;
      for (const row of rows) {
        let reason: CloudV2ContextReason | null = row.expires_at.getTime() <= Date.now() ? "expired" : null;
        if (!reason) {
          try {
            if (!row.user_id) reason = "access_revoked";
            else {
              const person = await this.contexts.deps.authority.snapshot(tx, id, row.user_id, row.source_fingerprint);
              if (person.signature !== row.authority.signature || person.state === "stopping") reason = "actor_changed";
              if (person.verifications.some(value => value.failureStatus && [401,403,404].includes(value.failureStatus))) reason = "access_revoked";
              if (row.provider_session_id && !(await tx.query(`SELECT 1 FROM auth_sessions WHERE user_id=$1 AND provider='workos' AND provider_session_id=$2
                AND status='active' AND revoked_at IS NULL AND (provider_session_expires_at IS NULL OR provider_session_expires_at>clock_timestamp())`, [row.user_id,row.provider_session_id])).rowCount)
                reason = "access_revoked";
              if (row.client_token_expires_at && row.client_token_expires_at.getTime() <= Date.now()) reason = "client_closed";
              if (row.agent && row.selection) await this.contexts.deps.logins.select(row.org_id, row.user_id, row.agent, row.selection, tx);
            }
          } catch (error) {
            if (error instanceof HttpError && error.status < 500) reason = error.code === "member_access_revoked" ? "access_revoked" : "actor_changed";
            else if (!(error instanceof HttpError)) throw error;
          }
        }
        if (reason) await this.contexts.revoke(tx, row.id, reason);
      }
      await this.cancelQueued(tx, id);
      return this.revocations(tx, id);
    });
  }

  private async revocations(tx: Tx, id: string, after?: string): Promise<Revocation[]> {
    const rows = (await tx.query<{ id: string; reason: CloudV2ContextReason; worker_boot_id: string }>(
      `SELECT id,reason,worker_boot_id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='revoked'
        AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 128`, [id, after ?? null])).rows;
    return rows.map(row => ({ contextId: row.id, reason: row.reason, bootId: row.worker_boot_id }));
  }

  async publish(id: string, push: (id: string, frames: Revocation[]) => void | Promise<void>) {
    let frames = await this.workspace(id);
    while (frames.length) {
      await push(id, frames);
      await withSystemTx(this.contexts.pool, async tx => {
        await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [id]);
        await this.contexts.clients.retireHandles(tx, id, frames.map(frame => frame.contextId));
      });
      if (frames.length < 128) break;
      const after = frames.at(-1)!.contextId;
      frames = await withSystemTx(this.contexts.pool, tx => this.revocations(tx, id, after));
    }
  }

  async cancelQueued(tx: Tx, id: string) {
    const changed = await tx.query(`UPDATE cloud_v2_prompt_outbox p SET cancel_requested=true,
      state=CASE WHEN p.state IN ('dispatching','accepted') AND EXISTS(SELECT 1 FROM cloud_v2_execution_contexts c
        WHERE c.id=p.execution_context_id AND c.reason IN ('worker_changed','expired')) THEN 'interrupted' ELSE 'cancelled' END,
      terminal_at=coalesce(terminal_at,clock_timestamp()),updated_at=clock_timestamp(),payload=NULL,payload_bytes=0
      FROM cloud_v2_workspaces w WHERE w.id=$1 AND p.workspace_id=w.id AND p.state IN ('queued','inboxed','dispatching','accepted') AND (
        NOT ${CLOUD_V2_LIVE_ACCESS} OR NOT EXISTS(SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.org_id=w.org_id AND m.user_id=p.creator_user_id AND u.auth_status='active' AND u.deleted_at IS NULL
            AND NOT ${memberOnHoldSql("m.org_id","m.user_id")})
        OR EXISTS(SELECT 1 FROM cloud_v2_execution_invalidations i WHERE i.workspace_id=p.workspace_id
          AND (i.user_id IS NULL OR i.user_id=p.creator_user_id) AND p.created_at<=i.created_at)
        OR EXISTS(SELECT 1 FROM cloud_v2_execution_contexts c WHERE c.id=p.execution_context_id AND c.state<>'active' AND c.reason<>'completed'))`, [id]);
    await tx.query("DELETE FROM cloud_v2_execution_invalidations WHERE workspace_id=$1", [id]);
    await tx.query(`UPDATE cloud_v2_connected_macs cm SET disconnected_at=clock_timestamp(),syncing=false,sync_wanted=false
      FROM cloud_v2_workspaces w WHERE w.id=$1 AND cm.workspace_id=w.id AND cm.disconnected_at IS NULL AND (
        NOT ${CLOUD_V2_LIVE_ACCESS} OR NOT EXISTS(SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.org_id=w.org_id AND m.user_id=cm.user_id AND u.auth_status='active' AND u.deleted_at IS NULL
            AND NOT ${memberOnHoldSql("m.org_id","m.user_id")}))`, [id]);
    if (changed.rowCount) await tx.query("SELECT pg_notify('zeros_cloud_v2_prompts',$1)", [id]);
  }

  async due(): Promise<string[]> {
    return withSystemTx(this.contexts.pool, async tx => (await tx.query<{ id: string }>(`SELECT id FROM (
      SELECT workspace_id AS id FROM cloud_v2_execution_contexts WHERE state='active' AND expires_at<=clock_timestamp()
      UNION SELECT workspace_id FROM cloud_v2_execution_invalidations) pending ORDER BY id LIMIT 128`)).rows.map(row => row.id));
  }

  async affected(scope: { userId?: string; organizationId?: string }, after?: string): Promise<string[]> {
    return withSystemTx(this.contexts.pool, async tx => (await tx.query<{ id: string }>(`SELECT DISTINCT workspace_id AS id
      FROM cloud_v2_execution_contexts WHERE state IN ('active','revoked') AND ($1::uuid IS NULL OR user_id=$1)
        AND ($2::uuid IS NULL OR org_id=$2) AND ($3::uuid IS NULL OR workspace_id>$3) ORDER BY id LIMIT 128`,
    [scope.userId ?? null, scope.organizationId ?? null, after ?? null])).rows.map(row => row.id));
  }

  async sweep(push: (id: string, frames: Revocation[]) => void | Promise<void>) {
    for (const id of await this.due()) await this.publish(id, push);
    const stale = await withSystemTx(this.contexts.pool, async tx => (await tx.query<{ id: string }>(`SELECT DISTINCT c.workspace_id AS id
      FROM cloud_v2_execution_contexts c WHERE c.state='retired' AND c.retired_at<clock_timestamp()-interval '7 days'
        AND NOT EXISTS(SELECT 1 FROM cloud_v2_execution_contexts child WHERE child.parent_context_id=c.id
          AND (child.state<>'retired' OR child.retired_at>=clock_timestamp()-interval '7 days'))
        AND NOT (c.kind='bootstrap' AND EXISTS(SELECT 1 FROM cloud_v2_workspaces w
          WHERE w.id=c.workspace_id AND w.worker_boot_id=c.worker_boot_id AND w.execution_intent_id=c.intent_id)) LIMIT 32`)).rows);
    for (const { id } of stale) await withSystemTx(this.contexts.pool, async tx => {
      await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [id]);
      await tx.query("SELECT 1 FROM cloud_v2_prompt_chats WHERE workspace_id=$1 ORDER BY chat_id FOR UPDATE", [id]);
      await tx.query(`DELETE FROM cloud_v2_execution_contexts WHERE id IN (SELECT c.id FROM cloud_v2_execution_contexts c
        WHERE c.workspace_id=$1 AND c.state='retired' AND c.retired_at<clock_timestamp()-interval '7 days'
          AND NOT EXISTS(SELECT 1 FROM cloud_v2_execution_contexts child WHERE child.parent_context_id=c.id
            AND (child.state<>'retired' OR child.retired_at>=clock_timestamp()-interval '7 days'))
          AND NOT (c.kind='bootstrap' AND EXISTS(SELECT 1 FROM cloud_v2_workspaces w
            WHERE w.id=c.workspace_id AND w.worker_boot_id=c.worker_boot_id AND w.execution_intent_id=c.intent_id))
        ORDER BY c.retired_at LIMIT 128)`, [id]);
      await tx.query(`DELETE FROM cloud_v2_execution_boots b WHERE workspace_id=$1 AND replaced_by IS NOT NULL AND created_at<clock_timestamp()-interval '7 days'
        AND NOT EXISTS(SELECT 1 FROM cloud_v2_execution_contexts c WHERE c.workspace_id=b.workspace_id AND c.worker_boot_id=b.boot_id)`, [id]);
    });
  }

  start(push: (id: string, frames: Revocation[]) => void | Promise<void>, logger: Pick<Console,"error"> = console) {
    const scheduler = new CloudWorkerScheduler(10_000, () => this.sweep(push), () => logger.error("[cloud-v2] execution_maintenance_unavailable"),
      async () => withSystemTx(this.contexts.pool, async tx => {
        const row = (await tx.query<{ delay: number | null }>(`SELECT CASE WHEN EXISTS(SELECT 1 FROM cloud_v2_execution_invalidations) THEN 0
          ELSE extract(epoch FROM (min(expires_at)-clock_timestamp()))*1000 END AS delay FROM cloud_v2_execution_contexts WHERE state='active'`)).rows[0];
        return row?.delay === null || row?.delay === undefined ? null : Number(row.delay);
      }), { jitter: true });
    scheduler.start();
    return () => scheduler.stop();
  }
}
