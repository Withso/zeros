import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import type { AuthedUser } from "../auth.js";
import { securityStreamAuthority } from "../security-events.js";
import { HttpError } from "../authz.js";
import type { CloudV2MessageRow } from "./contract.js";
import { hashCloudV2Token, newCloudV2Token } from "./tokens.js";

import { mirrorMessageWindow, type MessageWindow, type WindowOptions } from "./history.js";

export type CloudV2WorkspaceState =
  | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted" | "failed";

export type CloudV2InstalledRepository = { repository: string; defaultBranch: string | null };
type CreateWorkspace = {
  id: string; organizationId: string; creatorUserId: string; name: string; repository: string; branch: string;
  baseBranch: string; computerBuildId: string | null;
};
type CreateReceipt = { status: 201; response: Record<string, unknown> };

export type CloudV2Workspace = {
  id: string;
  organizationId: string;
  creatorUserId: string;
  name: string;
  repository: string;
  branch: string;
  baseBranch: string;
  state: CloudV2WorkspaceState;
  boatSandboxId: string | null;
  computerBuildId: string | null;
  errorCode: string | null;
  activeAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string; org_id: string; creator_user_id: string; name: string; repository: string; branch: string; base_branch: string;
  state: CloudV2WorkspaceState; boat_sandbox_id: string | null; computer_build_id: string | null;
  error_code: string | null; active_at: Date | null; archived_at: Date | null; created_at: Date; updated_at: Date;
};

const COLUMNS = `id, org_id, creator_user_id, name, repository, branch, base_branch, state, boat_sandbox_id,
  computer_build_id, error_code, active_at, archived_at, created_at, updated_at`;

function workspace(row: Row): CloudV2Workspace {
  return {
    id: row.id,
    organizationId: row.org_id,
    creatorUserId: row.creator_user_id,
    name: row.name,
    repository: row.repository,
    branch: row.branch,
    baseBranch: row.base_branch,
    state: row.state,
    boatSandboxId: row.boat_sandbox_id,
    computerBuildId: row.computer_build_id,
    errorCode: row.error_code,
    activeAt: row.active_at?.toISOString() ?? null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Every long-lived capability also needs a live account and membership.
const LIVE_ACCESS = `EXISTS (
  SELECT 1 FROM organization_members m
  JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
  JOIN users u ON u.id = m.user_id AND u.auth_status = 'active' AND u.deleted_at IS NULL
  WHERE m.org_id = w.org_id AND m.user_id = w.creator_user_id
    AND NOT o.is_personal AND o.cloud_workspaces_allowed)`;

const notFound = () => new HttpError(404, "not_found", "Cloud workspace not found");

/** v2 is creator-only: the caller must have created the workspace and still
 * belong to its organization. Anyone else sees the same 404. */
async function ownedRow(tx: Tx, id: string, userId: string, lock = false): Promise<Row> {
  const { rows } = await tx.query<Row>(
    `SELECT ${COLUMNS} FROM cloud_v2_workspaces w
     WHERE w.id = $1 AND w.creator_user_id = $2 AND w.state <> 'deleted'
       AND ${LIVE_ACCESS}
     ${lock ? "FOR UPDATE OF w" : ""}`,
    [id, userId],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

export class CloudV2Store {
  constructor(private readonly pool: pg.Pool) {}

  async createWorkspace(input: CreateWorkspace): Promise<CloudV2Workspace> {
    return withSystemTx(this.pool, tx => this.insertWorkspace(tx, input));
  }

  private async insertWorkspace(tx: Tx, input: CreateWorkspace): Promise<CloudV2Workspace> {
    const member = await tx.query(
      `SELECT 1 FROM organization_members m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
       WHERE m.org_id = $1 AND m.user_id = $2 AND NOT o.is_personal AND o.cloud_workspaces_allowed FOR SHARE OF o,m`,
      [input.organizationId, input.creatorUserId],
    );
    if (!member.rowCount) throw new HttpError(404, "not_found", "Organization not found");
    const row = (await tx.query<Row>(
      `INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, computer_build_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'creating', $8) RETURNING ${COLUMNS}`,
      [input.id, input.organizationId, input.creatorUserId, input.name, input.repository, input.branch,
        input.baseBranch, input.computerBuildId],
    )).rows[0]!;
    return workspace(row);
  }

  private async createReceipt(tx: Tx, creator: string, key: string, hash: string): Promise<CreateReceipt | null> {
    const { rows } = await tx.query<CreateReceipt & { request_hash: string }>(
      "SELECT request_hash,status,response FROM cloud_v2_create_requests WHERE creator_user_id=$1 AND request_key=$2", [creator, key]);
    if (!rows[0]) return null;
    if (rows[0].request_hash !== hash) throw new HttpError(409, "idempotency_conflict", "This creation key was already used with different content");
    return { status: rows[0].status, response: rows[0].response };
  }

  readCreateReceipt(creator: string, key: string, hash: string): Promise<CreateReceipt | null> {
    return withSystemTx(this.pool, tx => this.createReceipt(tx, creator, key, hash));
  }

  createWorkspaceOnce(input: CreateWorkspace, key: string, hash: string,
    response: (workspace: CloudV2Workspace) => Record<string, unknown>): Promise<CreateReceipt> {
    return withSystemTx(this.pool, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cloud-v2-create:${input.creatorUserId}:${key}`]);
      const previous = await this.createReceipt(tx, input.creatorUserId, key, hash);
      if (previous) return previous;
      const workspace = await this.insertWorkspace(tx, input);
      const receipt = { status: 201 as const, response: response(workspace) };
      await tx.query(`INSERT INTO cloud_v2_create_requests(creator_user_id,request_key,request_hash,workspace_id,status,response)
        VALUES($1,$2,$3,$4,$5,$6)`, [input.creatorUserId, key, hash, workspace.id, receipt.status, JSON.stringify(receipt.response)]);
      return receipt;
    });
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

  /** Serialize a creator's intent with lifecycle progress. Flag-only changes
   * advance the document version without rescheduling a pending stop. */
  async requestLifecycle(id: string, userId: string, action: "start" | "stop" | "archive"):
    Promise<{ workspace: CloudV2Workspace; moved: boolean }> {
    return withSystemTx(this.pool, async tx => {
      const current = await ownedRow(tx, id, userId, true);
      if (action === "archive" && (current.state === "creating" || current.state === "deleting"))
        throw new HttpError(409, "workspace_unavailable", "This cloud workspace cannot be archived yet");
      const state = action === "start"
        ? current.state === "stopped" || current.state === "failed" ? "starting" : current.state
        : current.state === "running" || current.state === "starting" ? "stopping" : current.state;
      const moved = state !== current.state;
      const archived = action === "archive" || (action === "stop" && current.archived_at !== null);
      if (!moved && archived === (current.archived_at !== null)) return { workspace: workspace(current), moved };
      const { rows } = await tx.query<Row>(
        `UPDATE cloud_v2_workspaces SET
           archived_at = CASE WHEN $3::boolean THEN coalesce(archived_at, clock_timestamp()) ELSE NULL END,
           attempts = CASE WHEN state <> $2 THEN 0 ELSE attempts END,
           next_attempt_at = CASE WHEN state <> $2 THEN NULL ELSE next_attempt_at END,
           updated_at = clock_timestamp(),
           state = $2
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, state, archived],
      );
      return { workspace: workspace(rows[0]!), moved };
    });
  }

  /** Compare-and-set. Returns null when the workspace was not in `from`. */
  async transition(id: string, from: readonly CloudV2WorkspaceState[], to: CloudV2WorkspaceState,
    patch: { boatSandboxId?: string | null; errorCode?: string | null } = {}): Promise<CloudV2Workspace | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `UPDATE cloud_v2_workspaces SET state = $3,
         boat_sandbox_id = CASE WHEN $4::boolean THEN $5 ELSE boat_sandbox_id END,
         error_code = CASE WHEN $6::boolean THEN $7 ELSE error_code END,
         worker_token_hash = CASE WHEN $3 = 'deleted' THEN NULL ELSE worker_token_hash END,
         active_at = CASE WHEN $3 = 'running' THEN clock_timestamp() ELSE active_at END,
         archived_at = CASE WHEN $3 = 'starting' THEN NULL ELSE archived_at END,
         attempts = 0, next_attempt_at = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND state = ANY($2::text[]) RETURNING ${COLUMNS}`,
      [id, from, to, patch.boatSandboxId !== undefined, patch.boatSandboxId ?? null,
        patch.errorCode !== undefined, patch.errorCode ?? null],
    ));
    return rows[0] ? workspace(rows[0]) : null;
  }

  /** The worker's identity. A deleted workspace has no token hash. */
  async byWorkerToken(token: string): Promise<(CloudV2Workspace & { accessEpoch: string }) | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { access_epoch: string }>(
      `SELECT ${COLUMNS}, access_epoch::text FROM cloud_v2_workspaces w
       WHERE worker_token_hash = $1 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`,
      [hashCloudV2Token(token)],
    ));
    return rows[0] ? { ...workspace(rows[0]), accessEpoch: rows[0].access_epoch } : null;
  }

  async accessEpoch(id: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ access_epoch: string }>(
      `SELECT access_epoch::text FROM cloud_v2_workspaces w
       WHERE id = $1 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}`, [id]));
    return rows[0]?.access_epoch ?? null;
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
  async issueToken(input: { workspaceId: string; kind: "connect" | "proxy"; userId: string | null; ttlMs: number; authority?: AuthedUser }) {
    const issued = newCloudV2Token(input.kind);
    const expiresAt = new Date(Date.now() + input.ttlMs);
    await withSystemTx(this.pool, async tx => {
      // Serialize issuance with revocation; authentication may have changed
      // after the HTTP middleware accepted the request.
      const allowed = await tx.query(`SELECT id FROM cloud_v2_workspaces w
        WHERE id = $1 AND state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}
          AND ($2::text = 'proxy' OR creator_user_id = $3) FOR UPDATE`,
        [input.workspaceId, input.kind, input.userId]);
      if (!allowed.rowCount) throw notFound();
      if (input.authority && !await securityStreamAuthority(tx, input.authority))
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      await tx.query(`DELETE FROM cloud_v2_tokens WHERE expires_at < clock_timestamp() - interval '1 hour'`);
      await tx.query(
        `INSERT INTO cloud_v2_tokens (token_hash, workspace_id, kind, user_id, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [issued.hash, input.workspaceId, input.kind, input.userId, expiresAt],
      );
    });
    return { token: issued.token, expiresAt };
  }

  /** Consumes a connect ticket exactly once. */
  async consumeConnectTicket(token: string, workspaceId: string): Promise<{ userId: string; accessEpoch: string } | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ user_id: string; access_epoch: string }>(
      `UPDATE cloud_v2_tokens t SET used_at = clock_timestamp()
       FROM cloud_v2_workspaces w
       WHERE t.token_hash = $1 AND t.kind = 'connect' AND t.workspace_id = $2 AND t.used_at IS NULL
         AND t.expires_at > clock_timestamp() AND w.id = t.workspace_id AND w.creator_user_id = t.user_id
         AND w.state NOT IN ('deleting','deleted') AND ${LIVE_ACCESS}
       RETURNING t.user_id, w.access_epoch::text`,
      [hashCloudV2Token(token), workspaceId],
    ));
    return rows[0] ? { userId: rows[0].user_id, accessEpoch: rows[0].access_epoch } : null;
  }

  async verifyProxyToken(token: string): Promise<CloudV2Workspace | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row>(
      `SELECT ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")} FROM cloud_v2_tokens t JOIN cloud_v2_workspaces w ON w.id = t.workspace_id
       WHERE t.token_hash = $1 AND t.kind = 'proxy' AND t.expires_at > clock_timestamp() AND w.state = 'running' AND ${LIVE_ACCESS}`,
      [hashCloudV2Token(token)],
    ));
    return rows[0] ? workspace(rows[0]) : null;
  }

  /** Leases up to `limit` workspaces in a transitional state to one lifecycle
   * worker. A crashed worker's lease simply expires. */
  async claimPending(limit: number, leaseMs: number): Promise<(CloudV2Workspace & { attempts: number })[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<Row & { attempts: number }>(
      `UPDATE cloud_v2_workspaces w SET attempts = w.attempts + 1,
         next_attempt_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000)
       WHERE w.id IN (
         SELECT id FROM cloud_v2_workspaces
         WHERE state IN ('creating','starting','stopping','deleting')
           AND coalesce(next_attempt_at, '-infinity') <= clock_timestamp()
         ORDER BY coalesce(next_attempt_at, updated_at) LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING ${COLUMNS.replace(/\b(\w+)\b/g, "w.$1")}, w.attempts`,
      [limit, leaseMs],
    ));
    return rows.map(row => ({ ...workspace(row), attempts: row.attempts }));
  }

  /** Schedules the next step. Waiting for an outside event (the worker's
   * hello) clears the failure count; a failure keeps it. `updated_at` stays
   * the time the state was entered. */
  async defer(id: string, state: CloudV2WorkspaceState, ms: number, patch: { boatSandboxId?: string; failure?: boolean } = {}): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces SET next_attempt_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000),
         boat_sandbox_id = coalesce($4, boat_sandbox_id), attempts = CASE WHEN $5::boolean THEN attempts ELSE 0 END
       WHERE id = $1 AND state = $2`,
      [id, state, ms, patch.boatSandboxId ?? null, patch.failure === true],
    ));
  }

  /** Replaces the worker credential; the plaintext goes only to the VM. */
  async rotateWorkerToken(id: string): Promise<string> {
    const worker = newCloudV2Token("worker");
    const changed = await withSystemTx(this.pool, tx => tx.query(
      `UPDATE cloud_v2_workspaces w SET worker_token_hash = $2 WHERE id = $1 AND state IN ('creating','starting','running') AND ${LIVE_ACCESS}`,
      [id, worker.hash],
    ));
    if (!changed.rowCount) throw notFound();
    return worker.token;
  }

  async loginRevision(id: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ revision: string }>(
      "SELECT login_revision::text AS revision FROM cloud_v2_workspaces WHERE id=$1 AND state<>'deleted'", [id]));
    return rows[0]?.revision ?? null;
  }

  async computerSnapshot(organizationId: string): Promise<string | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ snapshot_name: string | null }>(
      `SELECT snapshot_name FROM cloud_v2_computers WHERE org_id = $1`, [organizationId]));
    return rows[0]?.snapshot_name ?? null;
  }

  /** Repositories installed on the organization's active Cloud Computer, or
   * null when it has none yet. */
  async installedRepositories(organizationId: string): Promise<CloudV2InstalledRepository[] | null> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ recipe: { repositories?: { repository?: unknown; ref?: unknown; branch?: unknown }[] } }>(
      `SELECT build.recipe FROM cloud_v2_computers computer
       JOIN cloud_v2_computer_builds build ON build.id = computer.active_build_id AND build.org_id = computer.org_id
       WHERE computer.org_id = $1 AND computer.snapshot_name IS NOT NULL AND build.state = 'succeeded'`,
      [organizationId],
    ));
    if (!rows[0]) return null;
    return (rows[0].recipe.repositories ?? []).flatMap(entry => typeof entry.repository === "string" ? [{
      repository: entry.repository,
      // A recipe ref can be a tag. Only the build's verified branch is a
      // supported source for the worker's origin/<baseBranch> checkout.
      defaultBranch: typeof entry.branch === "string" && entry.branch ? entry.branch : null,
    }] : []);
  }

  /** Revokes a stopped or deleted workspace's tokens; deletion also drops its history. */
  async revoke(id: string, history: boolean): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await tx.query(`DELETE FROM cloud_v2_tokens WHERE workspace_id = $1`, [id]);
      if (!history) return;
      await tx.query(`DELETE FROM cloud_v2_messages WHERE workspace_id = $1`, [id]);
      await tx.query(`DELETE FROM cloud_v2_chats WHERE workspace_id = $1`, [id]);
    });
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

  messageWindow(workspaceId: string, chatId: string, options: WindowOptions = {}): Promise<MessageWindow> {
    return withSystemTx(this.pool, tx => mirrorMessageWindow(tx, workspaceId, chatId, options), { consistentRead: true });
  }

  /** Rows-only compatibility for internal callers; HTTP also returns turnOpening. */
  async windowMessages(workspaceId: string, chatId: string, limit: number): Promise<CloudV2MessageRow[]> {
    return (await this.messageWindow(workspaceId, chatId, { limit })).messages;
  }
}
