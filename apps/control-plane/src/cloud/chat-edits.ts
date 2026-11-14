import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudV2ChatEdit } from "./prompt-contract.js";
import { RUNTIME_HANDOFF_SESSION } from "./runtime-handoff-store.js";
import { hashCloudV2Token } from "./tokens.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";

type Patch = { title?: string; archived?: boolean };
type Scope = { organizationId: string; userId: string };
type EditRow = { chat_id: string; version: string; title: string | null; archived: boolean | null };
const fields = (row: Pick<EditRow, "title" | "archived">): Patch => ({
  ...(row.title === null ? {} : { title: row.title }), ...(row.archived === null ? {} : { archived: row.archived }),
});
const notFound = () => new HttpError(404, "not_found", "Session not found");

/** The workspace lock orders edits with prompt claims, history and lifecycle.
 * Delivery bookkeeping never enters the prompt queue or advances activity. */
export class CloudV2ChatEdits {
  constructor(private readonly pool: pg.Pool) {}

  async apply(scope: Scope, workspaceId: string, chatId: string, patch: Patch, authorize: (tx: Tx) => Promise<void>): Promise<{ id: string; title: string; archived: boolean }> {
    return this.applyAuthorized(scope,workspaceId,chatId,patch,authorize,false);
  }

  applyForManager(scope: Scope, workspaceId: string, chatId: string, patch: Patch, authorize: (tx: Tx) => Promise<void>) {
    return this.applyAuthorized(scope,workspaceId,chatId,patch,authorize,true);
  }

  private async applyAuthorized(scope: Scope, workspaceId: string, chatId: string, patch: Patch, authorize: (tx: Tx) => Promise<void>, shared: boolean) {
    return withSystemTx(this.pool, async tx => {
      const locked = await tx.query(`SELECT id FROM cloud_v2_workspaces w WHERE id=$1 AND org_id=$2
        AND ($4::boolean OR creator_user_id=$3) AND state NOT IN ('deleting','deleted') FOR UPDATE`, [workspaceId, scope.organizationId, scope.userId, shared]);
      if (!locked.rowCount) throw notFound();
      // The lock may have waited behind a revocation. Its subqueries need a
      // fresh statement snapshot, and credential rechecking uses this same tx.
      const current = (await tx.query<{ state: string; capable: boolean | null; working: boolean }>(`SELECT w.state,
        w.worker_boot_id=ANY(w.chat_edit_boot_ids) AS capable,
        EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p JOIN cloud_v2_prompt_chats c USING(workspace_id,chat_id)
          WHERE p.workspace_id=w.id AND p.chat_id=$2 AND p.epoch=c.epoch
            AND p.state IN ('queued','inboxed','dispatching','accepted')) AS working
        FROM cloud_v2_workspaces w JOIN cloud_v2_chats h ON h.workspace_id=w.id AND h.chat_id=$2
        WHERE w.id=$1 AND h.deleted_at IS NULL AND coalesce(h.row->>'kind','')<>'terminal' AND ${CLOUD_V2_LIVE_ACCESS}`,
      [workspaceId, chatId])).rows[0];
      if (!current) throw notFound();
      await authorize(tx);
      if (current.state === "running" && !current.capable)
        throw new HttpError(409, "worker_update_required", "Update the workspace runtime before editing its sessions");
      if (patch.archived === true && current.working)
        throw new HttpError(409, "session_busy", "Cancel the session's current turn before archiving it");
      const edited = await tx.query(`INSERT INTO cloud_v2_chat_edits(workspace_id,chat_id,version,title,archived)
        VALUES($1,$2,1,$3,$4) ON CONFLICT(workspace_id,chat_id) DO UPDATE SET version=cloud_v2_chat_edits.version+1,
          title=coalesce(EXCLUDED.title,cloud_v2_chat_edits.title), archived=coalesce(EXCLUDED.archived,cloud_v2_chat_edits.archived)
        WHERE cloud_v2_chat_edits.version<9223372036854775806 RETURNING version`, [workspaceId, chatId, patch.title ?? null, patch.archived ?? null]);
      if (!edited.rowCount) throw new HttpError(409, "session_version_exhausted", "This session cannot accept further edits");
      // Preserve the chat's JSON updatedAt: metadata edits must not reorder it.
      const saved = (await tx.query<{ row: Record<string, unknown> }>("UPDATE cloud_v2_chats SET row=row || $3::jsonb WHERE workspace_id=$1 AND chat_id=$2 RETURNING row",
        [workspaceId, chatId, JSON.stringify(patch)])).rows[0]!;
      await tx.query("SELECT pg_notify('zeros_cloud_v2_prompts',$1)", [workspaceId]);
      if (shared) await authorize(tx);
      return { id: chatId, title: typeof saved.row.title === "string" ? saved.row.title : "", archived: saved.row.archived === true };
    });
  }

  async advertise(token: string, bootId: string, supported: boolean, handoff?: string, transaction?: Tx): Promise<boolean> {
    // A current-boot hello can finish after the candidate's hello, before promotion.
    const advertise = (tx: Tx) => tx.query(`UPDATE cloud_v2_workspaces w SET chat_edit_boot_ids=ARRAY(
      SELECT DISTINCT id FROM unnest(chat_edit_boot_ids || CASE WHEN $5 THEN ARRAY[$2::uuid] ELSE '{}'::uuid[] END) AS boots(id)
      WHERE (id=w.worker_boot_id OR id=$2::uuid OR ($3::uuid IS NULL AND id=(
        SELECT CASE WHEN h.state='rolling_back' THEN h.rollback_boot_id ELSE h.next_boot_id END
        FROM cloud_worker_runtime_handoffs h WHERE h.workspace_id=w.id AND h.old_boot_id=w.worker_boot_id
          AND h.token_hash=w.worker_token_hash AND h.state IN ('activating','rolling_back'))))
        AND (id<>$2::uuid OR $5))
      WHERE worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${CLOUD_V2_LIVE_ACCESS}
        AND (($3::uuid IS NULL AND worker_boot_id=$2) OR ($3::uuid IS NOT NULL AND ${RUNTIME_HANDOFF_SESSION}))`,
    [hashCloudV2Token(token), bootId, handoff ?? null, null, supported]);
    const result = await (transaction ? advertise(transaction) : withSystemTx(this.pool, advertise));
    return Boolean(result.rowCount);
  }
}

/** New edits can release a held poll. Once it is ready for any reason, due
 * reoffers share the same fair selection without another database round trip. */
export async function offerCloudChatEdits(tx: Tx, workspaceId: string, bootId: string, mode: "new" | "due"): Promise<CloudV2ChatEdit[]> {
  const { rows } = await tx.query<EditRow>(`WITH ready AS MATERIALIZED (
    SELECT $3::boolean OR EXISTS (SELECT 1 FROM cloud_v2_chat_edits
      WHERE workspace_id=$1 AND version>acknowledged_version
        AND (last_offered_boot_id IS DISTINCT FROM $2::uuid OR last_offered_version IS DISTINCT FROM version)) AS value),
    candidates AS MATERIALIZED (
    SELECT chat_id,last_offered_at FROM cloud_v2_chat_edits WHERE workspace_id=$1 AND version>acknowledged_version
      AND (SELECT value FROM ready)
      AND (last_offered_boot_id IS DISTINCT FROM $2::uuid OR last_offered_version IS DISTINCT FROM version
        OR last_offered_at<=clock_timestamp()-interval '30 seconds')
    ORDER BY last_offered_at NULLS FIRST,chat_id LIMIT 128),
    offered AS (UPDATE cloud_v2_chat_edits e SET last_offered_boot_id=$2,last_offered_version=version,last_offered_at=clock_timestamp()
      FROM candidates c WHERE e.workspace_id=$1 AND e.chat_id=c.chat_id RETURNING e.chat_id,e.version::text,e.title,e.archived)
    SELECT o.* FROM offered o JOIN candidates c USING(chat_id) ORDER BY c.last_offered_at NULLS FIRST,c.chat_id`, [workspaceId, bootId, mode === "due"]);
  return rows.map(row => ({ chatId: row.chat_id, version: row.version, ...fields(row) }));
}

export async function overlayCloudChatEdits<T extends { id: string }>(tx: Tx, workspaceId: string, chats: readonly T[]): Promise<readonly T[]> {
  if (!chats.length) return chats;
  const { rows } = await tx.query<Omit<EditRow, "version">>(`SELECT chat_id,title,archived FROM cloud_v2_chat_edits
    WHERE workspace_id=$1 AND chat_id=ANY($2::text[]) AND version>acknowledged_version`, [workspaceId, chats.map(chat => chat.id)]);
  if (!rows.length) return chats;
  const pending = new Map(rows.map(row => [row.chat_id, fields(row)]));
  return chats.map(chat => pending.has(chat.id) ? { ...chat, ...pending.get(chat.id) } : chat);
}

/** Only the sequenced history batch carrying the worker's applied row may
 * retire an overlay. Retain the version even when no fields remain pending. */
export async function acknowledgeCloudChatEdits(tx: Tx, workspaceId: string, acks: readonly { chatId: string; version: string }[]): Promise<void> {
  if (!acks.length) return;
  await tx.query(`WITH acked AS (SELECT chat_id,max(version) AS version FROM jsonb_to_recordset($2::jsonb) AS r(chat_id text,version bigint) GROUP BY chat_id)
    UPDATE cloud_v2_chat_edits e SET acknowledged_version=greatest(e.acknowledged_version,least(e.version,a.version)),
      title=CASE WHEN a.version>=e.version THEN NULL ELSE e.title END,
      archived=CASE WHEN a.version>=e.version THEN NULL ELSE e.archived END
    FROM acked a WHERE e.workspace_id=$1 AND e.chat_id=a.chat_id`, [workspaceId, JSON.stringify(acks.map(ack => ({ chat_id: ack.chatId, version: ack.version })))]);
}
