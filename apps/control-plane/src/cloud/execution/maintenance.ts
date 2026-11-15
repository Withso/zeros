import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { cloudTeamOwnershipEnabled } from "../../db-context.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { CloudWorkerScheduler } from "../../worker-scheduler.js";
import type { CloudV2ContextReason } from "../contract.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { continuationPrincipal, senderContinuable, senderEnded, type CloudExecutionContexts, type ExecutionContext } from "./store.js";
import { matchesExecutionSignature } from "./signatures.js";

/** Work delivered on a started turn that another person pays for. Sender loss never cancels it: the loop below moves the
 * turn to its payer or revokes it, and a revoked turn's work is cancelled on the next pass. */
const STARTED = (prompt: string) => `EXISTS(SELECT 1 FROM cloud_v2_execution_contexts s WHERE s.id=${prompt}.execution_context_id
  AND s.state='active' AND s.kind='turn' AND s.material IS NOT NULL
  AND coalesce(s.selection->>'version'='2' AND s.selection#>>'{payer,userId}'<>s.user_id::text,false))`;
/** Already moved to its payer: no longer the sender's inventory, so it never re-invalidates them. */
const SPONSORED = (prompt: string) => `EXISTS(SELECT 1 FROM cloud_v2_execution_contexts s WHERE s.id=${prompt}.execution_context_id
  AND s.state='active' AND s.sender_ended_at IS NOT NULL)`;
type Revocation = { contextId: string; reason: CloudV2ContextReason; bootId: string };
/** The source answer's approved 10-minute window: the longest an R2 boot goes without re-admitting its people. */
export const AUTHORITY_SOURCE_RECHECK_MS = 10 * 60_000;
export class CloudExecutionMaintenance {
  constructor(readonly contexts: CloudExecutionContexts) {}

  async workspace(id: string): Promise<Revocation[]> {
    return withSystemTx(this.contexts.pool, async tx => {
      if (!(await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND execution_mode='active' FOR UPDATE", [id])).rowCount) {
        await tx.query("DELETE FROM cloud_v2_execution_invalidations WHERE workspace_id=$1", [id]);
        return [];
      }
      if (cloudTeamOwnershipEnabled(this.contexts.pool)) await tx.query("SELECT clear_cloud_creator_ownership(NULL,NULL,NULL,$1)", [id]);
      await this.contexts.deps.logins.refreshAvailability(id, tx);
      await this.cancelQueued(tx, id);
      const rows = (await tx.query<ExecutionContext>("SELECT * FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='active' ORDER BY id", [id])).rows;
      for (const listed of rows) {
        // A fence that committed since the list may have moved a started turn to its payer: read it again, locked at its turn.
        let row = senderContinuable(listed) && !senderEnded(listed)
          ? (await tx.query<ExecutionContext>("SELECT * FROM cloud_v2_execution_contexts WHERE id=$1 FOR UPDATE", [listed.id])).rows[0] : listed;
        if (!row || row.state !== "active") continue;
        let reason: CloudV2ContextReason | null = row.expires_at.getTime() <= Date.now() ? "expired" : null;
        if (!reason) {
          try {
            if (!row.user_id) reason = "access_revoked";
            else {
              let person;
              try { person = await this.contexts.deps.authority.snapshot(tx, id, continuationPrincipal(row)!, undefined, row.id); }
              catch (error) {
                // The sender lost access with no write the fence saw (a Hold window opening): a started turn moves to its payer.
                if (!(error instanceof HttpError) || error.code !== "member_access_revoked" || senderEnded(row) || !senderContinuable(row)) throw error;
                row = (await tx.query<ExecutionContext>(`UPDATE cloud_v2_execution_contexts SET sender_ended_at=coalesce(sender_ended_at,clock_timestamp())
                  WHERE id=$1 RETURNING *`, [row.id])).rows[0]!;
                person = await this.contexts.deps.authority.snapshot(tx, id, continuationPrincipal(row)!, undefined, row.id);
              }
              if (!senderEnded(row) && !matchesExecutionSignature(row.authority, row.authority.signature, person, "signature") || person.state === "stopping") reason = "actor_changed";
              if (row.provider_session_id && !(await tx.query(`SELECT 1 FROM auth_sessions WHERE user_id=$1 AND provider='workos' AND provider_session_id=$2
                AND status='active' AND revoked_at IS NULL AND (provider_session_expires_at IS NULL OR provider_session_expires_at>clock_timestamp())`, [row.user_id,row.provider_session_id])).rowCount)
                reason = "access_revoked";
              if (row.client_token_expires_at && row.client_token_expires_at.getTime() <= Date.now()) reason = "client_closed";
              if (row.agent && row.selection) await this.contexts.deps.logins.select(row.org_id, row.user_id!, row.agent, row.selection, tx);
            }
          } catch (error) {
            if (error instanceof HttpError && error.status < 500) reason = error.code === "member_access_revoked" ? "access_revoked" : "actor_changed";
            else if (!(error instanceof HttpError)) throw error;
          }
        }
        if (reason) await this.contexts.revoke(tx, row.id, reason);
      }
      await this.cancelQueued(tx, id);
      await this.scheduleRecheck(tx, id);
      return this.revocations(tx, id);
    });
  }

  /** R2 boots are never renewed, so a cut with no database write (a Hold window opening, a session or client token
   * expiring, the source answer's 10-minute window) needs its own evaluation: the earliest of them. The barrier never
   * extends a context past it. Lease boots keep their renewals and get none. */
  private async scheduleRecheck(tx: Tx, id: string) {
    await tx.query("DELETE FROM cloud_v2_authority_rechecks WHERE workspace_id=$1", [id]);
    await tx.query(`WITH live AS MATERIALIZED (
        SELECT c.* FROM cloud_v2_execution_contexts c JOIN cloud_v2_workspaces w ON w.id=c.workspace_id
        JOIN cloud_v2_execution_boots b ON b.workspace_id=w.id AND b.boot_id=w.worker_boot_id AND b.authority_mode='message-authority-v1'
        WHERE c.workspace_id=$1 AND c.state='active' AND c.worker_boot_id=w.worker_boot_id),
      people AS (SELECT user_id FROM live WHERE user_id IS NOT NULL
        UNION SELECT (selection#>>'{payer,userId}')::uuid FROM live WHERE selection->>'version'='2')
      INSERT INTO cloud_v2_authority_rechecks(workspace_id,at)
        SELECT $1,least(
          clock_timestamp()+make_interval(secs=>$2::double precision/1000),
          (SELECT min(client_token_expires_at) FROM live),
          (SELECT min(s.provider_session_expires_at) FROM auth_sessions s JOIN live l ON l.provider_session_id=s.provider_session_id
            AND s.user_id=l.user_id AND s.provider='workos'),
          (SELECT min(edge) FROM organization_member_seat_periods p CROSS JOIN LATERAL unnest(p.hold_periods) r
            CROSS JOIN LATERAL (VALUES (lower(r)),(upper(r))) v(edge)
            WHERE p.org_id=(SELECT org_id FROM cloud_v2_workspaces WHERE id=$1) AND p.user_id IN (SELECT user_id FROM people)
              AND edge>clock_timestamp()))
        WHERE EXISTS(SELECT 1 FROM live)`, [id, AUTHORITY_SOURCE_RECHECK_MS]);
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
    // Clock-driven Hold and N-1 writers can leave inventory behind the protocol
    // policy. Reconcile it under the same personal cutoff as a visible writer.
    await tx.query(`INSERT INTO cloud_v2_execution_invalidations(workspace_id,user_id)
      SELECT w.id,person.user_id FROM cloud_v2_workspaces w CROSS JOIN LATERAL (
        SELECT user_id FROM cloud_v2_execution_contexts WHERE workspace_id=w.id AND state='active' AND sender_ended_at IS NULL
        UNION SELECT creator_user_id FROM cloud_v2_prompt_outbox p WHERE workspace_id=w.id AND state IN ('queued','inboxed','dispatching','accepted')
          AND NOT ${SPONSORED("p")}
        UNION SELECT user_id FROM cloud_v2_tokens WHERE workspace_id=w.id AND expires_at>clock_timestamp()
        UNION SELECT user_id FROM cloud_v2_connected_macs WHERE workspace_id=w.id AND disconnected_at IS NULL
        UNION SELECT user_id FROM cloud_v2_chat_sender_bindings WHERE workspace_id=w.id AND NOT retired
        UNION SELECT user_id FROM cloud_v2_workspace_presence WHERE workspace_id=w.id AND expires_at>clock_timestamp()
      ) person WHERE w.id=$1 AND w.execution_mode='active' AND person.user_id IS NOT NULL AND (
        NOT ${CLOUD_V2_LIVE_ACCESS} OR NOT EXISTS(SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.org_id=w.org_id AND m.user_id=person.user_id AND u.auth_status='active' AND u.deleted_at IS NULL
            AND NOT ${memberOnHoldSql("m.org_id","m.user_id")}))`, [id]);
    const changed = await tx.query(`UPDATE cloud_v2_prompt_outbox p SET cancel_requested=true,
      state=CASE WHEN p.state IN ('dispatching','accepted') AND EXISTS(SELECT 1 FROM cloud_v2_execution_contexts c
        WHERE c.id=p.execution_context_id AND c.reason IN ('worker_changed','expired')) THEN 'interrupted' ELSE 'cancelled' END,
      terminal_at=coalesce(terminal_at,clock_timestamp()),updated_at=clock_timestamp(),payload=NULL,payload_bytes=0
      FROM cloud_v2_workspaces w WHERE w.id=$1 AND p.workspace_id=w.id AND p.state IN ('queued','inboxed','dispatching','accepted')
        AND NOT ${STARTED("p")} AND (
        NOT ${CLOUD_V2_LIVE_ACCESS} OR NOT EXISTS(SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.org_id=w.org_id AND m.user_id=p.creator_user_id AND u.auth_status='active' AND u.deleted_at IS NULL
            AND NOT ${memberOnHoldSql("m.org_id","m.user_id")})
        OR EXISTS(SELECT 1 FROM cloud_v2_execution_invalidations i WHERE i.workspace_id=p.workspace_id
          AND (i.user_id IS NULL OR i.user_id=p.creator_user_id) AND p.created_at<=i.created_at)
        OR EXISTS(SELECT 1 FROM cloud_v2_execution_contexts c WHERE c.id=p.execution_context_id AND c.state<>'active' AND c.reason<>'completed'))`, [id]);
    await tx.query("DELETE FROM cloud_v2_execution_invalidations WHERE workspace_id=$1", [id]);
    if (changed.rowCount) await tx.query("SELECT pg_notify('zeros_cloud_v2_prompts',$1)", [id]);
  }

  async due(): Promise<string[]> {
    return withSystemTx(this.contexts.pool, async tx => (await tx.query<{ id: string }>(`SELECT id FROM (
      SELECT workspace_id AS id FROM cloud_v2_execution_contexts WHERE state='active' AND expires_at<=clock_timestamp()
      UNION SELECT workspace_id FROM cloud_v2_execution_invalidations
      UNION SELECT workspace_id FROM cloud_v2_authority_rechecks WHERE at<=clock_timestamp()
      ${cloudTeamOwnershipEnabled(this.contexts.pool) ? `UNION SELECT w.id FROM cloud_v2_workspaces w WHERE w.execution_mode='active'
        AND w.creator_user_id IS NOT NULL AND w.state<>'deleted' AND NOT EXISTS(
          SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.org_id=w.org_id AND m.user_id=w.creator_user_id AND u.auth_status='active' AND u.deleted_at IS NULL
            AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")})` : ""}) pending ORDER BY id LIMIT 128`)).rows.map(row => row.id));
  }

  async affected(scope: { userId?: string; organizationId?: string }, after?: string): Promise<string[]> {
    return withSystemTx(this.contexts.pool, async tx => (await tx.query<{ id: string }>(`SELECT DISTINCT w.id FROM (
      SELECT workspace_id,user_id FROM cloud_v2_execution_contexts WHERE state IN ('active','revoked')
      UNION ALL SELECT id,creator_user_id FROM cloud_v2_workspaces WHERE execution_mode='active' AND state<>'deleted'
      UNION ALL SELECT workspace_id,(selection#>>'{payer,userId}')::uuid FROM cloud_v2_execution_contexts
        WHERE state IN ('active','revoked') AND selection->>'version'='2'
      UNION ALL SELECT workspace_id,creator_user_id FROM cloud_v2_prompt_outbox
        WHERE execution_authority IS NOT NULL AND state IN ('queued','inboxed','dispatching','accepted')
      UNION ALL SELECT workspace_id,user_id FROM cloud_v2_tokens WHERE execution_authority IS NOT NULL AND expires_at>clock_timestamp()
      UNION ALL SELECT workspace_id,user_id FROM cloud_v2_connected_macs WHERE disconnected_at IS NULL
      UNION ALL SELECT workspace_id,user_id FROM cloud_v2_chat_sender_bindings WHERE NOT retired
      UNION ALL SELECT workspace_id,user_id FROM cloud_v2_workspace_presence WHERE expires_at>clock_timestamp()
      ) resource JOIN cloud_v2_workspaces w ON w.id=resource.workspace_id
      WHERE w.execution_mode='active' AND ($1::uuid IS NULL OR resource.user_id=$1)
        AND ($2::uuid IS NULL OR w.org_id=$2) AND ($3::uuid IS NULL OR w.id>$3) ORDER BY w.id LIMIT 128`,
    [scope.userId ?? null, scope.organizationId ?? null, after ?? null])).rows.map(row => row.id));
  }

  async sweep(push: (id: string, frames: Revocation[]) => void | Promise<void>) {
    for (const id of await this.due()) await this.publish(id, push);
    await withSystemTx(this.contexts.pool, tx => tx.query(`DELETE FROM cloud_v2_reassignments WHERE (workspace_id,caller_user_id,request_id) IN (
      SELECT workspace_id,caller_user_id,request_id FROM cloud_v2_reassignments WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 128)`));
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
    const scheduler = new CloudWorkerScheduler(60_000, () => this.sweep(push), () => logger.error("[cloud-v2] execution_maintenance_unavailable"),
      async () => withSystemTx(this.contexts.pool, async tx => {
        const row = (await tx.query<{ delay: number | null }>(`SELECT CASE WHEN EXISTS(SELECT 1 FROM cloud_v2_execution_invalidations) THEN 0
          ELSE extract(epoch FROM (least((SELECT min(expires_at) FROM cloud_v2_execution_contexts WHERE state='active'),
            (SELECT min(at) FROM cloud_v2_authority_rechecks))-clock_timestamp()))*1000 END AS delay`)).rows[0];
        return row?.delay === null || row?.delay === undefined ? null : Number(row.delay);
      }));
    scheduler.start();
    return () => scheduler.stop();
  }
}
