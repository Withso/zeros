import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { securityStreamAuthority } from "../security-events.js";
import { hashCloudV2Token } from "./tokens.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";
import { CLOUD_V2_MAX_PROMPT_BYTES, CloudV2PromptSchema, type CloudV2Prompt, type CloudV2PromptReceipt,
  type CloudV2PromptPullReply, type CloudV2PromptState, type CloudV2PromptStatus } from "./prompt-contract.js";

const PENDING = "('queued','inboxed','dispatching','accepted')";
export const CLOUD_V2_PROMPT_LIMITS = { pending: 128, bytes: 32 * 1024 * 1024, receipts: 10_000, leaseMs: 30_000, readBytes: 14 * 1024 * 1024 };
type Limits = typeof CLOUD_V2_PROMPT_LIMITS;
type Workspace = { id: string; repository: string; state: CloudV2PromptReceipt["workspaceState"]; access_epoch: string; worker_boot_id: string | null };
type Row = { user_message_id: string; chat_id: string; sequence: string; epoch: string; access_epoch: string;
  payload_hash: string; payload: CloudV2Prompt | null; receipt: CloudV2PromptReceipt; state: CloudV2PromptState;
  cancel_requested: boolean; delivery_id: string | null; worker_boot_id: string | null; dispatch_id: string | null };
const notFound = () => new HttpError(404, "not_found", "Cloud workspace not found");
const unauthorized = () => new HttpError(401, "worker_unauthorized", "Worker authorization is no longer current");
const conflict = () => new HttpError(409, "prompt_conflict", "This message id was already used for a different send");
const terminal = (state: CloudV2PromptState) => !["queued", "inboxed", "dispatching", "accepted"].includes(state);
const status = (row: Row): CloudV2PromptStatus => ({ receipt: row.receipt, state: row.state, payload: row.payload, cancelRequested: row.cancel_requested });
const notify = (tx: Tx, id: string) => tx.query("SELECT pg_notify('zeros_cloud_v2_prompts', $1)", [id]);

/** No VM or provider I/O under these transactions. Workspace-row locking gives
 * enqueue, claims, Stop and the existing authority triggers one ordering. The
 * original receipt/hash survives terminal payload compaction: retries never
 * become new executions merely because a retention window ended. */
export class CloudV2PromptOutbox {
  constructor(private readonly pool: pg.Pool, private readonly limits: Limits = CLOUD_V2_PROMPT_LIMITS) {}

  private async owned(tx: Tx, id: string, userId: string, lock: boolean): Promise<Workspace> {
    const { rows } = await tx.query<Workspace>(`SELECT id, repository, state, access_epoch::text, worker_boot_id
      FROM cloud_v2_workspaces w WHERE id=$1 AND creator_user_id=$2 AND state NOT IN ('deleting','deleted')
        AND ${CLOUD_V2_LIVE_ACCESS} ${lock ? "FOR UPDATE OF w" : ""}`, [id, userId]);
    if (!rows[0]) throw notFound();
    // READ COMMITTED can wait on the workspace row after evaluating a member
    // subquery in its old statement snapshot. Use a fresh statement after the
    // lock; the authority trigger cannot commit a later revocation behind us.
    if (lock && !(await tx.query(`SELECT 1 FROM cloud_v2_workspaces w WHERE id=$1 AND ${CLOUD_V2_LIVE_ACCESS}`, [id])).rowCount) throw notFound();
    return rows[0];
  }

  private async worker(tx: Tx, token: string, bootId: string): Promise<Workspace> {
    const { rows } = await tx.query<Workspace>(`SELECT id, repository, state, access_epoch::text, worker_boot_id
      FROM cloud_v2_workspaces w WHERE worker_token_hash=$1 AND worker_boot_id=$2
        AND state IN ('running','stopping') AND ${CLOUD_V2_LIVE_ACCESS} FOR UPDATE OF w`, [hashCloudV2Token(token), bootId]);
    if (!rows[0]) throw unauthorized();
    if (!(await tx.query(`SELECT 1 FROM cloud_v2_workspaces w WHERE id=$1 AND ${CLOUD_V2_LIVE_ACCESS}`, [rows[0].id])).rowCount) throw unauthorized();
    return rows[0];
  }

  private async chat(tx: Tx, id: string, chatId: string) {
    if ((await tx.query("SELECT 1 FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id=$2 AND deleted_at IS NOT NULL", [id, chatId])).rowCount)
      throw new HttpError(409, "conversation_deleted", "This conversation was deleted");
    // Stop can arrive before the first send. Bound those empty fence records,
    // too, rather than allowing arbitrary chat IDs to grow a second queue.
    const existing = (await tx.query<{ epoch: string; next_sequence: string }>(
      "SELECT epoch::text,next_sequence::text FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND chat_id=$2", [id, chatId])).rows[0];
    if (existing) return existing;
    const count = (await tx.query<{ count: number }>("SELECT count(*)::int FROM cloud_v2_prompt_chats WHERE workspace_id=$1", [id])).rows[0]!.count;
    if (count >= this.limits.receipts) throw new HttpError(429, "prompt_outbox_full", "The saved message queue is full");
    await tx.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [id, chatId]);
    return (await tx.query<{ epoch: string; next_sequence: string }>(
      "SELECT epoch::text,next_sequence::text FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND chat_id=$2", [id, chatId])).rows[0]!;
  }

  async enqueue(id: string, userId: string, raw: CloudV2Prompt, authority?: AuthedUser): Promise<{ receipt: CloudV2PromptReceipt; replay: boolean }> {
    const parsed = CloudV2PromptSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid cloud prompt");
    const payload = parsed.data, encoded = JSON.stringify(payload), bytes = Buffer.byteLength(encoded);
    if (bytes > CLOUD_V2_MAX_PROMPT_BYTES) throw new HttpError(413, "payload_too_large", "Message is too large");
    const hash = createHash("sha256").update(encoded).digest("hex");
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.owned(tx, id, userId, true);
      if (authority?.authentication && !await securityStreamAuthority(tx, authority))
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      const previous = (await tx.query<Row>("SELECT * FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [id, payload.userMessageId])).rows[0];
      if (previous) {
        if (previous.payload_hash !== hash) throw conflict();
        return { receipt: previous.receipt, replay: true };
      }
      if (workspace.state === "failed") throw new HttpError(409, "workspace_unavailable", "This cloud workspace is unavailable");
      const chat = await this.chat(tx, id, payload.chatId);
      // Bound retained bytes as well as pending bytes. Terminal prompt bodies
      // duplicate the transcript and may be compacted; their receipts may not.
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET payload=NULL,payload_bytes=0
        WHERE workspace_id=$1 AND payload IS NOT NULL AND terminal_at < clock_timestamp() - interval '7 days'`, [id]);
      const usage = (await tx.query<{ total: number; pending: number; bytes: number }>(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE state IN ${PENDING})::int AS pending,
        coalesce(sum(payload_bytes) FILTER (WHERE state IN ${PENDING}),0)::int AS bytes
        FROM cloud_v2_prompt_outbox WHERE workspace_id=$1`, [id])).rows[0]!;
      if (usage.total >= this.limits.receipts || usage.pending >= this.limits.pending || usage.bytes + bytes > this.limits.bytes)
        throw new HttpError(429, "prompt_outbox_full", "The saved message queue is full. Wait for messages to finish or delete old chats");
      const retained = (await tx.query<{ bytes: number }>("SELECT coalesce(sum(payload_bytes),0)::int AS bytes FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [id])).rows[0]!.bytes;
      if (retained + bytes > this.limits.bytes * 2) await tx.query(`UPDATE cloud_v2_prompt_outbox SET payload=NULL,payload_bytes=0
        WHERE workspace_id=$1 AND terminal_at IS NOT NULL AND payload IS NOT NULL`, [id]);
      const sequence = (BigInt(chat.next_sequence) + 1n).toString();
      const receipt: CloudV2PromptReceipt = { workspaceId: id, chatId: payload.chatId, userMessageId: payload.userMessageId,
        sequence, epoch: chat.epoch, acceptedAt: new Date().toISOString(), workspaceState: workspace.state };
      await tx.query(`INSERT INTO cloud_v2_prompt_outbox(workspace_id,user_message_id,chat_id,creator_user_id,sequence,epoch,access_epoch,payload_hash,payload,payload_bytes,receipt,wake_after_stop)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, payload.userMessageId, payload.chatId, userId, sequence, chat.epoch, workspace.access_epoch, hash, encoded, bytes, JSON.stringify(receipt), workspace.state === "stopping"]);
      await tx.query("UPDATE cloud_v2_prompt_chats SET next_sequence=$3 WHERE workspace_id=$1 AND chat_id=$2", [id, payload.chatId, sequence]);
      // A new chat must be discoverable after app exit, even before its VM has
      // booted. Keep prompt bubbles in the outbox until the worker records them:
      // pre-inserting transcript rows would reorder a queued follow-up ahead of
      // the preceding turn's later tools/assistant rows.
      await tx.query(`INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [id, payload.chatId, JSON.stringify({ id: payload.chatId, folder: `/home/user/${workspace.repository}`,
          agentId: payload.agentId, agentName: { codex: "Codex", claude: "Claude", cursor: "Cursor" }[payload.agentId],
          title: "", model: payload.model ?? null, effort: payload.effort ?? "", createdAt: payload.startedAt, updatedAt: payload.startedAt })]);
      // One explicit wake belongs to this committed send, not to its retries.
      // A send racing stopping remains pending until the stop has completed.
      await tx.query(`UPDATE cloud_v2_workspaces SET state=CASE WHEN state='stopped' THEN 'starting' ELSE state END,
        worker_token_hash=CASE WHEN state='stopped' THEN NULL ELSE worker_token_hash END,
        worker_boot_id=CASE WHEN state='stopped' THEN NULL ELSE worker_boot_id END,
        archived_at=NULL, active_at=clock_timestamp(),
        attempts=CASE WHEN state='stopped' THEN 0 ELSE attempts END,
        next_attempt_at=CASE WHEN state='stopped' THEN NULL ELSE next_attempt_at END,
        updated_at=CASE WHEN state='stopped' THEN clock_timestamp() ELSE updated_at END WHERE id=$1`, [id]);
      await notify(tx, id);
      return { receipt, replay: false };
    });
  }

  async list(id: string, userId: string, chatId: string, after = "0", limit = 100): Promise<{ epoch: string; items: CloudV2PromptStatus[]; nextAfter: string | null }> {
    return withSystemTx(this.pool, async tx => {
      await this.owned(tx, id, userId, false);
      const chat = (await tx.query<{ epoch: string; next_sequence: string }>("SELECT epoch::text,next_sequence::text FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND chat_id=$2", [id, chatId])).rows[0];
      const { rows } = await tx.query<Row>(`WITH candidates AS (
        SELECT user_message_id,sequence,payload_bytes FROM cloud_v2_prompt_outbox
        WHERE workspace_id=$1 AND chat_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4),
        bounded AS (SELECT user_message_id,sum(payload_bytes) OVER (ORDER BY sequence) AS bytes FROM candidates)
        SELECT p.* FROM cloud_v2_prompt_outbox p JOIN bounded b USING(user_message_id)
        WHERE p.workspace_id=$1 AND b.bytes<=$5 ORDER BY p.sequence`, [id, chatId, after, limit, this.limits.readBytes]);
      const last = rows.at(-1)?.sequence;
      return { epoch: chat?.epoch ?? "0", items: rows.map(status), nextAfter: last && BigInt(last) < BigInt(chat?.next_sequence ?? "0") ? last : null };
    }, { consistentRead: true });
  }

  async stop(id: string, userId: string, chatId: string, throughEpoch: string, authority?: AuthedUser): Promise<{ chatId: string; epoch: string }> {
    return withSystemTx(this.pool, async tx => {
      await this.owned(tx, id, userId, true);
      if (authority?.authentication && !await securityStreamAuthority(tx, authority))
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      const chat = await this.chat(tx, id, chatId);
      if (BigInt(throughEpoch) > BigInt(chat.epoch)) throw new HttpError(409, "prompt_epoch_changed", "Conversation delivery changed");
      if (throughEpoch !== chat.epoch) return { chatId, epoch: chat.epoch };
      const epoch = (BigInt(chat.epoch) + 1n).toString();
      await tx.query("UPDATE cloud_v2_prompt_chats SET epoch=$3 WHERE workspace_id=$1 AND chat_id=$2", [id, chatId, epoch]);
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET cancel_requested=true,
        state=CASE WHEN state IN ('queued','inboxed') THEN 'cancelled' ELSE state END,
        terminal_at=CASE WHEN state IN ('queued','inboxed') THEN clock_timestamp() ELSE terminal_at END,
        updated_at=clock_timestamp() WHERE workspace_id=$1 AND chat_id=$2 AND state IN ${PENDING}`, [id, chatId]);
      await notify(tx, id);
      return { chatId, epoch };
    });
  }

  async pull(token: string, bootId: string): Promise<CloudV2PromptPullReply> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId), id = workspace.id;
      if (workspace.state !== "running") return { prompts: [], stops: [] };
      // The old process might have passed a request to its provider. Only an
      // explicit new send can recover it: a new boot is never a replay permit.
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'interrupted' END,
        terminal_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND state IN ('dispatching','accepted') AND worker_boot_id IS DISTINCT FROM $2`, [id, bootId]);
      const rows = (await tx.query<Row>(`WITH candidates AS (
        SELECT p.user_message_id,p.payload_bytes,p.created_at,p.chat_id,p.sequence FROM cloud_v2_prompt_outbox p
        JOIN cloud_v2_prompt_chats c USING(workspace_id,chat_id)
        WHERE p.workspace_id=$1 AND p.state IN ('queued','inboxed') AND p.epoch=c.epoch AND p.access_epoch=$2
          AND NOT p.cancel_requested AND p.payload IS NOT NULL
          AND (p.worker_boot_id IS DISTINCT FROM $3 OR p.lease_until IS NULL OR p.lease_until<=clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox older WHERE older.workspace_id=p.workspace_id
            AND older.chat_id=p.chat_id AND older.sequence<p.sequence AND older.state IN ${PENDING})
        ORDER BY p.created_at,p.chat_id,p.sequence LIMIT 16),
        bounded AS (SELECT user_message_id,sum(payload_bytes) OVER (ORDER BY created_at,chat_id,sequence) AS bytes FROM candidates)
        SELECT p.* FROM cloud_v2_prompt_outbox p JOIN bounded b USING(user_message_id)
        WHERE p.workspace_id=$1 AND b.bytes<=$4 ORDER BY p.created_at,p.chat_id,p.sequence`, [id, workspace.access_epoch, bootId, this.limits.readBytes])).rows;
      const prompts: CloudV2PromptPullReply["prompts"] = [];
      for (const row of rows) {
        const deliveryId = row.worker_boot_id === bootId && row.delivery_id ? row.delivery_id : randomUUID();
        await tx.query(`UPDATE cloud_v2_prompt_outbox SET delivery_id=$3,worker_boot_id=$4,
          lease_until=clock_timestamp()+make_interval(secs=>$5::double precision/1000),updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND user_message_id=$2`, [id, row.user_message_id, deliveryId, bootId, this.limits.leaseMs]);
        prompts.push({ receipt: row.receipt, payload: row.payload!, deliveryId });
      }
      const stops = (await tx.query<{ chatId: string; epoch: string }>(`SELECT chat_id AS "chatId",epoch::text FROM cloud_v2_prompt_chats
        WHERE workspace_id=$1 AND stop_acked_epoch<epoch ORDER BY chat_id LIMIT 128`, [id])).rows;
      return { prompts, stops };
    });
  }

  private async row(tx: Tx, id: string, messageId: string): Promise<Row> {
    const row = (await tx.query<Row>("SELECT * FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [id, messageId])).rows[0];
    if (!row) throw new HttpError(404, "prompt_not_found", "Saved message not found");
    return row;
  }

  async ack(token: string, bootId: string, input: { userMessageId: string; deliveryId: string }): Promise<{ state: CloudV2PromptState }> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId), row = await this.row(tx, workspace.id, input.userMessageId);
      if (terminal(row.state)) return { state: row.state };
      if (row.worker_boot_id !== bootId || row.delivery_id !== input.deliveryId) throw conflict();
      if (row.state === "queued") await tx.query(`UPDATE cloud_v2_prompt_outbox SET state='inboxed',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND user_message_id=$2`, [workspace.id, input.userMessageId]);
      return { state: row.state === "queued" ? "inboxed" : row.state };
    });
  }

  async begin(token: string, bootId: string, input: { userMessageId: string; deliveryId: string; dispatchId: string }): Promise<{ dispatch: boolean; state: CloudV2PromptState }> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId), row = await this.row(tx, workspace.id, input.userMessageId);
      if (terminal(row.state)) return { dispatch: false, state: row.state };
      const chat = await this.chat(tx, workspace.id, row.chat_id);
      if (row.cancel_requested || row.epoch !== chat.epoch || row.access_epoch !== workspace.access_epoch || workspace.state !== "running")
        return { dispatch: false, state: "cancelled" };
      if (row.worker_boot_id !== bootId || row.delivery_id !== input.deliveryId) throw conflict();
      if (row.state === "dispatching" || row.state === "accepted") {
        if (row.dispatch_id !== input.dispatchId) throw conflict();
        return { dispatch: true, state: row.state };
      }
      if (row.state !== "inboxed") throw new HttpError(409, "prompt_inbox_required", "Persist the message before dispatch");
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET state='dispatching',dispatch_id=$3,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND user_message_id=$2`, [workspace.id, input.userMessageId, input.dispatchId]);
      return { dispatch: true, state: "dispatching" };
    });
  }

  async outcome(token: string, bootId: string, input: { userMessageId: string; dispatchId: string; state: "accepted" | "completed" | "failed" | "cancelled" | "interrupted" }): Promise<{ state: CloudV2PromptState }> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId), row = await this.row(tx, workspace.id, input.userMessageId);
      if (terminal(row.state)) return { state: row.state };
      if (row.worker_boot_id !== bootId || row.dispatch_id !== input.dispatchId || !["dispatching", "accepted"].includes(row.state)) throw conflict();
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET state=$3,updated_at=clock_timestamp(),
        terminal_at=CASE WHEN $3='accepted' THEN NULL ELSE clock_timestamp() END
        WHERE workspace_id=$1 AND user_message_id=$2`, [workspace.id, input.userMessageId, input.state]);
      if (input.state !== "accepted") await notify(tx, workspace.id);
      return { state: input.state };
    });
  }

  async ackStop(token: string, bootId: string, input: { chatId: string; epoch: string }): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId);
      await tx.query(`UPDATE cloud_v2_prompt_chats SET stop_acked_epoch=greatest(stop_acked_epoch,$3::bigint)
        WHERE workspace_id=$1 AND chat_id=$2 AND epoch>=$3`, [workspace.id, input.chatId, input.epoch]);
    });
  }

  /** Called by lifecycle, not a VM poll. Only previously committed explicit
   * work may wake a VM after its in-progress stop has actually finished. */
  async wakePending(): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(`WITH woke AS (
      UPDATE cloud_v2_workspaces w SET state='starting',attempts=0,next_attempt_at=NULL,
        worker_token_hash=NULL,worker_boot_id=NULL,archived_at=NULL,updated_at=clock_timestamp()
        WHERE id IN (SELECT workspace_id FROM cloud_v2_prompt_outbox WHERE wake_after_stop AND state IN ('queued','inboxed'))
          AND state='stopped' AND ${CLOUD_V2_LIVE_ACCESS} AND EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox p
            WHERE p.workspace_id=w.id AND p.wake_after_stop AND p.state IN ('queued','inboxed') AND p.access_epoch=w.access_epoch AND NOT p.cancel_requested)
        RETURNING w.id)
      UPDATE cloud_v2_prompt_outbox SET wake_after_stop=false WHERE workspace_id IN (SELECT id FROM woke) AND wake_after_stop`));
  }

  /** Compaction retains the hash/receipt until erasure. Never forget a message
   * ID and thereby turn a late HTTP retry into a fresh provider execution. */
  async prune(): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_prompt_outbox SET payload=NULL,payload_bytes=0
      WHERE (workspace_id,user_message_id) IN (SELECT workspace_id,user_message_id FROM cloud_v2_prompt_outbox
        WHERE payload IS NOT NULL AND terminal_at<clock_timestamp()-interval '7 days' ORDER BY terminal_at LIMIT 1000)`));
  }
}
