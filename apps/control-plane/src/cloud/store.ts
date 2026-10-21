import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { HttpError } from "../authz.js";
import type { CloudV2MessageRow } from "./contract.js";
import { hashCloudV2Token, newCloudV2Token } from "./tokens.js";

export type CloudV2WorkspaceState =
  | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted" | "failed";

export type CloudV2Workspace = {
  id: string;
  organizationId: string;
  creatorUserId: string;
  name: string;
  repository: string;
  branch: string;
  state: CloudV2WorkspaceState;
  boatSandboxId: string | null;
  computerBuildId: string | null;
  errorCode: string | null;
  activeAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string; org_id: string; creator_user_id: string; name: string; repository: string; branch: string;
  state: CloudV2WorkspaceState; boat_sandbox_id: string | null; computer_build_id: string | null;
  error_code: string | null; active_at: Date | null; created_at: Date; updated_at: Date;
};

const COLUMNS = `id, org_id, creator_user_id, name, repository, branch, state, boat_sandbox_id,
  computer_build_id, error_code, active_at, created_at, updated_at`;

function workspace(row: Row): CloudV2Workspace {
  return {
    id: row.id,
    organizationId: row.org_id,
    creatorUserId: row.creator_user_id,
    name: row.name,
    repository: row.repository,
    branch: row.branch,
    state: row.state,
    boatSandboxId: row.boat_sandbox_id,
    computerBuildId: row.computer_build_id,
    errorCode: row.error_code,
    activeAt: row.active_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const notFound = () => new HttpError(404, "not_found", "Cloud workspace not found");

/** v1 is creator-only: the caller must have created the workspace and still
 * belong to its organization. Anyone else sees the same 404. */
async function ownedRow(tx: Tx, id: string, userId: string, lock = false): Promise<Row> {
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM cloud_v2_workspaces w
     WHERE w.id = $1 AND w.creator_user_id = $2 AND w.state <> 'deleted'
       AND EXISTS (SELECT 1 FROM organization_members m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
                   WHERE m.org_id = w.org_id AND m.user_id = $2)
     ${lock ? "FOR UPDATE OF w" : ""}`,
    [id, userId],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

export class CloudV2Store {
  constructor(private readonly pool: pg.Pool) {}

  /** Returns the worker token once; only its hash is stored. */
  async createWorkspace(input: {
    id: string; organizationId: string; creatorUserId: string; name: string; repository: string; branch: string;
    computerBuildId: string | null;
  }): Promise<{ workspace: CloudV2Workspace; workerToken: string }> {
    const worker = newCloudV2Token("worker");
    const row = await withSystemTx(this.pool, async tx => {
      const member = await tx.query(
        `SELECT 1 FROM organization_members m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
         WHERE m.org_id = $1 AND m.user_id = $2 AND NOT o.is_personal AND o.cloud_workspaces_allowed`,
        [input.organizationId, input.creatorUserId],
      );
      if (!member.rowCount) throw new HttpError(404, "not_found", "Organization not found");
      return (await tx.query<Row>(
        `INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, state,
           computer_build_id, worker_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6, 'creating', $7, $8) RETURNING ${COLUMNS}`,
        [input.id, input.organizationId, input.creatorUserId, input.name, input.repository, input.branch,
          input.computerBuildId, worker.hash],
      )).rows[0]!;
    });
    return { workspace: workspace(row), workerToken: worker.token };
  }

  async get(id: string, userId: string): Promise<CloudV2Workspace> {
    return workspace(await withSystemTx(this.pool, tx => ownedRow(tx, id, userId)));
  }

  async list(organizationId: string, userId: string): Promise<CloudV2Workspace[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_workspaces w
       WHERE w.org_id = $1 AND w.creator_user_id = $2 AND w.state <> 'deleted'
         AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = w.org_id AND m.user_id = $2)
       ORDER BY w.created_at DESC, w.id LIMIT 200`,
      [organizationId, userId],
    ));
    return rows.map(workspace);
  }

  /** Compare-and-set. Returns null when the workspace was not in `from`. */
  async transition(id: string, from: readonly CloudV2WorkspaceState[], to: CloudV2WorkspaceState,
    patch: { boatSandboxId?: string | null; errorCode?: string | null } = {}): Promise<CloudV2Workspace | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `UPDATE cloud_v2_workspaces SET state = $3,
         boat_sandbox_id = CASE WHEN $4::boolean THEN $5 ELSE boat_sandbox_id END,
         error_code = CASE WHEN $6::boolean THEN $7 ELSE error_code END,
         worker_token_hash = CASE WHEN $3 = 'deleted' THEN NULL ELSE worker_token_hash END,
         updated_at = clock_timestamp()
       WHERE id = $1 AND state = ANY($2::text[]) RETURNING ${COLUMNS}`,
      [id, from, to, patch.boatSandboxId !== undefined, patch.boatSandboxId ?? null,
        patch.errorCode !== undefined, patch.errorCode ?? null],
    ));
    return rows[0] ? workspace(rows[0]) : null;
  }

  /** The worker's identity. A deleted workspace has no token hash. */
  async byWorkerToken(token: string): Promise<CloudV2Workspace | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_workspaces WHERE worker_token_hash = $1 AND state NOT IN ('deleting','deleted')`,
      [hashCloudV2Token(token)],
    ));
    return rows[0] ? workspace(rows[0]) : null;
  }

  async markActive(id: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET active_at = clock_timestamp() WHERE id = $1`, [id]));
  }

  /** Workspaces running with no activity since `before`. */
  async idleSince(before: Date, limit = 50): Promise<CloudV2Workspace[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS} FROM cloud_v2_workspaces
       WHERE state = 'running' AND coalesce(active_at, updated_at) < $1
       ORDER BY coalesce(active_at, updated_at) LIMIT $2`,
      [before, limit],
    ));
    return rows.map(workspace);
  }

  /** A one-use app connect ticket, or a worker model-proxy token. */
  async issueToken(input: { workspaceId: string; kind: "connect" | "proxy"; userId: string | null; ttlMs: number }) {
    const issued = newCloudV2Token(input.kind);
    const expiresAt = new Date(Date.now() + input.ttlMs);
    await withSystemTx(this.pool, async tx => {
      await tx.query(`DELETE FROM cloud_v2_tokens WHERE expires_at < clock_timestamp() - interval '1 hour'`);
      await tx.query(
        `INSERT INTO cloud_v2_tokens (token_hash, workspace_id, kind, user_id, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [issued.hash, input.workspaceId, input.kind, input.userId, expiresAt],
      );
    });
    return { token: issued.token, expiresAt };
  }

  /** Consumes a connect ticket exactly once. */
  async consumeConnectTicket(token: string, workspaceId: string): Promise<{ userId: string } | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ user_id: string }>(
      `UPDATE cloud_v2_tokens t SET used_at = clock_timestamp()
       FROM cloud_v2_workspaces w
       WHERE t.token_hash = $1 AND t.kind = 'connect' AND t.workspace_id = $2 AND t.used_at IS NULL
         AND t.expires_at > clock_timestamp() AND w.id = t.workspace_id AND w.creator_user_id = t.user_id
         AND w.state NOT IN ('deleting','deleted')
       RETURNING t.user_id`,
      [hashCloudV2Token(token), workspaceId],
    ));
    return rows[0] ? { userId: rows[0].user_id } : null;
  }

  async verifyProxyToken(token: string): Promise<CloudV2Workspace | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")} FROM cloud_v2_tokens t JOIN cloud_v2_workspaces w ON w.id = t.workspace_id
       WHERE t.token_hash = $1 AND t.kind = 'proxy' AND t.expires_at > clock_timestamp() AND w.state = 'running'`,
      [hashCloudV2Token(token)],
    ));
    return rows[0] ? workspace(rows[0]) : null;
  }

  /** Mirror of the worker's history; the same rows Local persists. */
  async writeHistory(workspaceId: string, input: {
    chats?: readonly { id: string }[] | undefined; chatDeletions?: readonly string[] | undefined;
    messages?: { chatId: string; rows: readonly CloudV2MessageRow[] } | undefined;
  }): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      for (const chat of input.chats ?? []) {
        await tx.query(
          `INSERT INTO cloud_v2_chats (workspace_id, chat_id, row) VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, chat_id) DO UPDATE SET row = EXCLUDED.row, deleted_at = NULL, updated_at = clock_timestamp()`,
          [workspaceId, chat.id, JSON.stringify(chat)],
        );
      }
      for (const chatId of input.chatDeletions ?? []) {
        await tx.query(`DELETE FROM cloud_v2_messages WHERE workspace_id = $1 AND chat_id = $2`, [workspaceId, chatId]);
        await tx.query(
          `INSERT INTO cloud_v2_chats (workspace_id, chat_id, row, deleted_at) VALUES ($1, $2, jsonb_build_object('id', $2::text), clock_timestamp())
           ON CONFLICT (workspace_id, chat_id) DO UPDATE SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()`,
          [workspaceId, chatId],
        );
      }
      const batch = input.messages;
      if (batch?.rows.length) {
        await tx.query(
          `INSERT INTO cloud_v2_messages (workspace_id, chat_id, msg_id, kind, payload, created_at_ms)
           SELECT $1, $2, r.msg_id, r.kind, r.payload, r.created_at_ms
           FROM jsonb_to_recordset($3::jsonb) AS r(msg_id text, kind text, payload text, created_at_ms bigint)
           ON CONFLICT (workspace_id, chat_id, msg_id) DO UPDATE
             SET kind = EXCLUDED.kind, payload = EXCLUDED.payload, created_at_ms = EXCLUDED.created_at_ms`,
          [workspaceId, batch.chatId, JSON.stringify(batch.rows.map(row => ({
            msg_id: row.msgId, kind: row.kind, payload: row.payload, created_at_ms: row.createdAt,
          })))],
        );
      }
    });
  }

  async listChats(workspaceId: string): Promise<{ chats: unknown[]; chatDeletions: string[] }> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ chat_id: string; row: unknown; deleted_at: Date | null }>(
      `SELECT chat_id, row, deleted_at FROM cloud_v2_chats WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT 1000`,
      [workspaceId],
    ));
    return {
      chats: rows.filter(row => !row.deleted_at).map(row => row.row),
      chatDeletions: rows.filter(row => row.deleted_at).map(row => row.chat_id),
    };
  }

  /** Newest `limit` rows in chronological order. */
  async windowMessages(workspaceId: string, chatId: string, limit: number): Promise<CloudV2MessageRow[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ msg_id: string; kind: string; payload: string; created_at_ms: string }>(
      `SELECT msg_id, kind, payload, created_at_ms FROM (
         SELECT * FROM cloud_v2_messages WHERE workspace_id = $1 AND chat_id = $2 ORDER BY ord DESC LIMIT $3
       ) newest ORDER BY ord`,
      [workspaceId, chatId, Math.max(1, Math.min(limit, 1000))],
    ));
    return rows.map(row => ({ msgId: row.msg_id, kind: row.kind, payload: row.payload, createdAt: Number(row.created_at_ms) }));
  }
}
