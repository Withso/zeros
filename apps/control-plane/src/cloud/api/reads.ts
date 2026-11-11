import type pg from "pg";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { CLOUD_V2_LIVE_ACCESS, cloudV2ActorAccess } from "../workspace-access.js";
import type { CloudExecutionContexts } from "../execution/store.js";
import { CloudV2PromptIdSchema } from "../prompt-contract.js";
import type { ApiMessageList, ApiSessionList } from "./contract.js";

export type ApiScope = { userId: string; organizationId: string };
export type ApiChatRow = { workspaceId: string; id: string; row: Record<string, unknown>; updatedAt: string; createdBySessionId: string | null };
type ChatRow = { workspace_id: string; chat_id: string; row: Record<string, unknown>; updated_at: Date; created_by_session_id: string | null };
type MessageRow = { msg_id: string; ord: string; kind: string; payload: string; created_at_ms: string; created_by_session_id: string | null };
const MESSAGE_PAGE_BYTES = 8 * 1024 * 1024;
const chat = (row: ChatRow): ApiChatRow => ({ workspaceId: row.workspace_id, id: row.chat_id, row: row.row,
  updatedAt: row.updated_at.toISOString(), createdBySessionId: row.created_by_session_id });
const notFound = () => new HttpError(404, "not_found", "Session or message not found");
const message = (row: MessageRow, sessionId: string, index: number) => {
  let content: unknown;
  try { content = JSON.parse(row.payload); } catch { content = row.payload; }
  return { id: row.msg_id, sessionId, index, type: row.kind, content, createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    createdBySessionId: row.created_by_session_id };
};

/** Additional projections of the existing history mirror; never a worker RPC. */
export class CloudApiReads {
  execution?: CloudExecutionContexts;
  constructor(private readonly pool: pg.Pool) {}

  private async read<T>(scope: ApiScope, workspaceId: string, action: (tx: Tx) => Promise<T>) {
    const proof = await this.execution?.active(workspaceId) ? await this.execution!.deps.authority.admit(workspaceId, scope.userId) : undefined;
    if (proof && proof.person.organizationId !== scope.organizationId) throw notFound();
    const result = await withSystemTx(this.pool, async tx => {
      if (proof) await this.execution!.deps.authority.assert(proof, tx);
      const value = await action(tx);
      if (proof) await this.execution!.deps.authority.assert(proof, tx);
      return value;
    }, { consistentRead: !proof });
    if (proof) await this.execution!.deps.authority.assert(proof);
    return result;
  }

  async attribution(scope: ApiScope & { workspaceId?: string }, id: string | undefined): Promise<string | null> {
    if (!CloudV2PromptIdSchema.safeParse(id).success) return null;
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ chat_id: string }>(`SELECT c.chat_id FROM cloud_v2_chats c
      JOIN cloud_v2_workspaces w ON w.id=c.workspace_id WHERE c.chat_id=$1 AND w.org_id=$2 AND ${cloudV2ActorAccess("$3")}
        AND ($4::uuid IS NULL OR w.id=$4) AND w.state NOT IN ('deleting','deleted')
        AND c.deleted_at IS NULL AND coalesce(c.row->>'kind','')<>'terminal' AND ${CLOUD_V2_LIVE_ACCESS}
      LIMIT 2`, [id, scope.organizationId, scope.userId, scope.workspaceId ?? null]));
    return rows.length === 1 ? rows[0]!.chat_id : null;
  }

  private async owned(tx: Tx, scope: ApiScope, workspaceId: string, chatId?: string): Promise<void> {
    const result = await tx.query(`SELECT 1 FROM cloud_v2_workspaces w WHERE w.id=$1 AND ${cloudV2ActorAccess("$2")}
      AND w.org_id=$3 AND w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}
      AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM cloud_v2_chats c WHERE c.workspace_id=w.id AND c.chat_id=$4
        AND c.deleted_at IS NULL AND coalesce(c.row->>'kind','')<>'terminal'))`, [workspaceId, scope.userId, scope.organizationId, chatId ?? null]);
    if (!result.rowCount) throw notFound();
  }

  async resolve(scope: ApiScope, id: string): Promise<ApiChatRow> {
    const saved = await withSystemTx(this.pool, async tx => {
      const { rows } = await tx.query<ChatRow>(`SELECT c.workspace_id,c.chat_id,c.row,c.updated_at,c.created_by_session_id FROM cloud_v2_chats c
        JOIN cloud_v2_workspaces w ON w.id=c.workspace_id WHERE c.chat_id=$1 AND w.org_id=$2 AND ${cloudV2ActorAccess("$3")}
          AND w.state<>'deleted' AND c.deleted_at IS NULL AND coalesce(c.row->>'kind','')<>'terminal' AND ${CLOUD_V2_LIVE_ACCESS}
        LIMIT 2`, [id, scope.organizationId, scope.userId]);
      if (rows.length !== 1) throw notFound();
      return chat(rows[0]!);
    });
    return this.read(scope, saved.workspaceId, async tx => { await this.owned(tx, scope, saved.workspaceId, saved.id); return saved; });
  }

  sessions(scope: ApiScope, workspaceId: string, page: ApiSessionList) {
    return this.read(scope, workspaceId, async tx => {
      await this.owned(tx, scope, workspaceId);
      const { rows } = await tx.query<ChatRow>(`SELECT workspace_id,chat_id,row,updated_at,created_by_session_id FROM cloud_v2_chats
        WHERE workspace_id=$1 AND deleted_at IS NULL AND coalesce(row->>'kind','')<>'terminal'
          AND ($2::boolean OR row->>'archived' IS DISTINCT FROM 'true')
        ORDER BY updated_at,chat_id LIMIT $3 OFFSET $4`, [workspaceId, page.includeArchived, page.limit + 1, page.offset]);
      return rows.map(chat);
    });
  }

  status(scope: ApiScope, workspaceId: string, id: string) {
    return this.read(scope, workspaceId, async tx => {
      await this.owned(tx, scope, workspaceId, id);
      const { rows } = await tx.query<{ working: boolean; latest_state: string | null; epoch: string; updated_at: Date }>(`SELECT
        EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p JOIN cloud_v2_prompt_chats c USING(workspace_id,chat_id)
          WHERE p.workspace_id=h.workspace_id AND p.chat_id=h.chat_id AND p.epoch=c.epoch
            AND p.state IN ('queued','inboxed','dispatching','accepted')) AS working,
        (SELECT state FROM cloud_v2_prompt_outbox p WHERE p.workspace_id=h.workspace_id AND p.chat_id=h.chat_id ORDER BY sequence DESC LIMIT 1) AS latest_state,
        coalesce((SELECT epoch::text FROM cloud_v2_prompt_chats c WHERE c.workspace_id=h.workspace_id AND c.chat_id=h.chat_id),'0') AS epoch,
        greatest(h.updated_at,(SELECT max(updated_at) FROM cloud_v2_prompt_outbox p WHERE p.workspace_id=h.workspace_id AND p.chat_id=h.chat_id)) AS updated_at
        FROM cloud_v2_chats h WHERE workspace_id=$1 AND chat_id=$2`, [workspaceId, id]);
      const row = rows[0]!;
      return { epoch: row.epoch, status: row.working ? "working" as const : row.latest_state === "failed" ? "error" as const : "idle" as const,
        updatedAt: row.updated_at.toISOString() };
    });
  }

  messages(scope: ApiScope, workspaceId: string, id: string, page: ApiMessageList) {
    return this.read(scope, workspaceId, async tx => {
      await this.owned(tx, scope, workspaceId, id);
      let after: string | null = null, index = page.offset;
      if (page.after !== undefined) {
        const anchor = (await tx.query<{ ord: string }>("SELECT ord::text FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2 AND msg_id=$3", [workspaceId, id, page.after])).rows[0];
        if (!anchor) throw notFound();
        after = anchor.ord;
        index += Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2 AND ord<=$3", [workspaceId, id, after])).rows[0]!.n);
      }
      const candidates = (await tx.query<{ msg_id: string; bytes: number }>(`SELECT msg_id,octet_length(payload) AS bytes FROM cloud_v2_messages
        WHERE workspace_id=$1 AND chat_id=$2 AND ($3::bigint IS NULL OR ord>$3)
        ORDER BY ord LIMIT $4 OFFSET $5`, [workspaceId, id, after, page.limit + 1, page.offset])).rows;
      const ids: string[] = [];
      let bytes = 1024;
      for (const candidate of candidates.slice(0, page.limit)) {
        if (bytes + candidate.bytes + 1024 > MESSAGE_PAGE_BYTES) break;
        ids.push(candidate.msg_id); bytes += candidate.bytes + 1024;
      }
      if (candidates.length && !ids.length) throw new HttpError(413, "message_too_large", "This message exceeds the response limit");
      const { rows } = await tx.query<MessageRow>(`SELECT m.msg_id,m.ord,m.kind,m.payload,m.created_at_ms,p.created_by_session_id FROM cloud_v2_messages m
        LEFT JOIN cloud_v2_prompt_outbox p ON p.workspace_id=m.workspace_id AND p.chat_id=m.chat_id AND p.user_message_id=m.msg_id
        WHERE m.workspace_id=$1 AND m.chat_id=$2 AND m.msg_id=ANY($3::text[]) ORDER BY m.ord`, [workspaceId, id, ids]);
      const data: ReturnType<typeof message>[] = [];
      bytes = 1024;
      for (const row of rows) {
        const document = message(row, id, index + data.length + 1), size = Buffer.byteLength(JSON.stringify(document)) + 1;
        if (bytes + size > MESSAGE_PAGE_BYTES) break;
        data.push(document); bytes += size;
      }
      if (rows.length && !data.length) throw new HttpError(413, "message_too_large", "This message exceeds the response limit");
      return { data, offset: index, hasMore: candidates.length > data.length };
    });
  }

  message(scope: ApiScope, workspaceId: string, id: string, messageId: string) {
    return this.read(scope, workspaceId, async tx => {
      await this.owned(tx, scope, workspaceId, id);
      const { rows } = await tx.query<MessageRow & { position: string }>(`SELECT m.msg_id,m.ord,m.kind,m.payload,m.created_at_ms,p.created_by_session_id,
        (SELECT count(*) FROM cloud_v2_messages earlier WHERE earlier.workspace_id=m.workspace_id AND earlier.chat_id=m.chat_id AND earlier.ord<=m.ord) AS position
        FROM cloud_v2_messages m
        LEFT JOIN cloud_v2_prompt_outbox p ON p.workspace_id=m.workspace_id AND p.chat_id=m.chat_id AND p.user_message_id=m.msg_id
        WHERE m.workspace_id=$1 AND m.chat_id=$2 AND m.msg_id=$3`, [workspaceId, id, messageId]);
      if (!rows[0]) throw notFound();
      return message(rows[0], id, Number(rows[0].position));
    });
  }
}
