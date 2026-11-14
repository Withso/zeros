import { createHash } from "node:crypto";
import type pg from "pg";
import { offerCloudChatEdits } from "./chat-edits.js";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { securityStreamAuthority } from "../security-events.js";
import { hashCloudV2Token } from "./tokens.js";
import { CloudLocalDevices } from "./local-commands/devices.js";
import type { LocalDeviceBinding } from "./local-commands/contract.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";
import { CLOUD_V2_MAX_PROMPT_BYTES, CloudV2PromptSchema, CloudV2SessionNameSchema, type CloudV2Prompt, type CloudV2PromptReceipt,
  type CloudV2PromptPullReply, type CloudV2PromptState, type CloudV2PromptStatus } from "./prompt-contract.js";

import type { CloudExecutionContexts, PromptExecutionAdmission } from "./execution/store.js";
import { executionIntentAuthority } from "./execution/authority.js";
import { memberOnHoldSql } from "../organization-seats.js";
import { assertNoExecutionTransition } from "./execution/activation-state.js";
import { CLOUD_RECOVERY_TURN_HOLD, assertRecoveryTurnReady } from "./recovery-state.js";

export type CloudApiPrompt = {
  chatId: string; userMessageId: string; agentId: CloudV2Prompt["agentId"];
  message: string; model?: string | undefined; effort?: string | undefined; startedAt?: number | undefined;
  sessionName?: string | undefined;
  createdBySessionId?: string | null | undefined;
  senderCredential?: { kind: "api_key" | "workspace_token"; credentialId: string; contextId?: string | undefined } | undefined;
};

const PENDING = "('queued','inboxed','dispatching','accepted')";
export const CLOUD_V2_PROMPT_LIMITS = { pending: 128, bytes: 32 * 1024 * 1024, receipts: 10_000, leaseMs: 30_000, readBytes: 14 * 1024 * 1024 };
type Limits = typeof CLOUD_V2_PROMPT_LIMITS;
type Workspace = { id: string; repository: string; state: CloudV2PromptReceipt["workspaceState"]; archived_at: Date | null;
  access_epoch: string; worker_boot_id: string | null; execution_mode: string; previous?: Row };
type Row = { user_message_id: string; chat_id: string; creator_user_id: string; sequence: string; epoch: string; access_epoch: string;
  payload_hash: string; payload: CloudV2Prompt | null; receipt: CloudV2PromptReceipt; state: CloudV2PromptState;
  created_by_session_id: string | null;
  cancel_requested: boolean; delivery_id: string | null; worker_boot_id: string | null; dispatch_id: string | null };
type WorkerSnapshot = Workspace & { handoff: boolean; recoveryHeld: boolean; prompt?: Row; chatEpoch: string | null; chatDeleted: boolean };
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
  private readonly localDevices: CloudLocalDevices;
  execution?: CloudExecutionContexts;
  constructor(private readonly pool: pg.Pool, private readonly limits: Limits = CLOUD_V2_PROMPT_LIMITS) {
    this.localDevices = new CloudLocalDevices(pool);
  }

  private async owned(tx: Tx, id: string, userId: string, lock: boolean, messageId?: string): Promise<Workspace> {
    const { rows } = await tx.query<Workspace>(`SELECT id, repository, state, archived_at, access_epoch::text, worker_boot_id, execution_mode
      FROM cloud_v2_workspaces w WHERE id=$1 AND (creator_user_id=$2 OR execution_mode='active' AND EXISTS (
        SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=w.org_id AND m.user_id=$2
          AND u.auth_status='active' AND u.deleted_at IS NULL AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")})) AND state NOT IN ('deleting','deleted')
        AND ${CLOUD_V2_LIVE_ACCESS} ${lock ? "FOR UPDATE OF w" : ""}`, [id, userId]);
    if (!rows[0]) throw notFound();
    // READ COMMITTED can wait on the workspace row after evaluating a member
    // subquery in its old statement snapshot. Use a fresh statement after the
    // lock; the authority trigger cannot commit a later revocation behind us.
    if (!lock) return rows[0];
    const current = (await tx.query<Row & { live: boolean }>(`SELECT p.*,${CLOUD_V2_LIVE_ACCESS} AS live
      FROM cloud_v2_workspaces w LEFT JOIN cloud_v2_prompt_outbox p ON p.workspace_id=w.id AND p.user_message_id=$2
      WHERE w.id=$1`, [id, messageId ?? null])).rows[0];
    if (!current?.live) throw notFound();
    return { ...rows[0], ...(current.user_message_id ? { previous: current } : {}) };
  }

  private async worker(tx: Tx, token: string, bootId: string, messageId?: string): Promise<WorkerSnapshot> {
    const { rows } = await tx.query<Workspace>(`SELECT id, repository, state, archived_at, access_epoch::text, worker_boot_id, execution_mode
      FROM cloud_v2_workspaces w WHERE worker_token_hash=$1 AND worker_boot_id=$2
        AND state IN ('running','stopping') AND ${CLOUD_V2_LIVE_ACCESS} FOR UPDATE OF w`, [hashCloudV2Token(token), bootId]);
    if (!rows[0]) throw unauthorized();
    const current = (await tx.query<Row & { live: boolean; handoff: boolean; recovery_held: boolean; chat_epoch: string | null; chat_deleted: boolean }>(
      `SELECT p.*,${CLOUD_V2_LIVE_ACCESS} AS live,
        (${CLOUD_RECOVERY_TURN_HOLD}) AS recovery_held,
        EXISTS (SELECT 1 FROM cloud_worker_runtime_handoffs WHERE workspace_id=w.id AND state IN ('committed','activating','rolling_back')) AS handoff,
        c.epoch::text AS chat_epoch,h.deleted_at IS NOT NULL AS chat_deleted
      FROM cloud_v2_workspaces w
      LEFT JOIN cloud_v2_prompt_outbox p ON p.workspace_id=w.id AND p.user_message_id=$2
      LEFT JOIN cloud_v2_prompt_chats c ON c.workspace_id=w.id AND c.chat_id=p.chat_id
      LEFT JOIN cloud_v2_chats h ON h.workspace_id=w.id AND h.chat_id=p.chat_id
      WHERE w.id=$1`, [rows[0].id, messageId ?? null])).rows[0];
    if (!current?.live) throw unauthorized();
    return { ...rows[0], handoff: current.handoff, recoveryHeld: current.recovery_held, ...(current.user_message_id ? { prompt: current } : {}),
      chatEpoch: current.chat_epoch, chatDeleted: current.chat_deleted };
  }

  private async chat(tx: Tx, id: string, chatId: string) {
    // Stop can arrive before the first send. Bound those empty fence records,
    // too, rather than allowing arbitrary chat IDs to grow a second queue.
    const current = (await tx.query<{ deleted: boolean; at_capacity: boolean; epoch: string | null; next_sequence: string | null }>(
      `WITH existing AS MATERIALIZED (
        SELECT epoch,next_sequence FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND chat_id=$2),
      capacity AS MATERIALIZED (SELECT
        EXISTS (SELECT 1 FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id=$2 AND deleted_at IS NOT NULL) AS deleted,
        CASE WHEN EXISTS (SELECT 1 FROM existing) THEN false ELSE
          (SELECT count(*) >= $3 FROM (SELECT 1 FROM cloud_v2_prompt_chats WHERE workspace_id=$1 LIMIT $3) bounded) END AS at_capacity),
      created AS (INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id)
        SELECT $1,$2 FROM capacity WHERE NOT deleted AND NOT at_capacity AND NOT EXISTS (SELECT 1 FROM existing)
        ON CONFLICT DO NOTHING RETURNING epoch,next_sequence)
      SELECT capacity.deleted,capacity.at_capacity,c.epoch::text,c.next_sequence::text FROM capacity
      LEFT JOIN (SELECT * FROM existing UNION ALL SELECT * FROM created) c ON true`, [id, chatId, this.limits.receipts])).rows[0]!;
    if (current.deleted) throw new HttpError(409, "conversation_deleted", "This conversation was deleted");
    if (current.epoch !== null) return { epoch: current.epoch, next_sequence: current.next_sequence! };
    if (current.at_capacity) throw new HttpError(429, "prompt_outbox_full", "The saved message queue is full");
    return (await tx.query<{ epoch: string; next_sequence: string }>(
      "SELECT epoch::text,next_sequence::text FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND chat_id=$2", [id, chatId])).rows[0]!;
  }

  enqueueApi(id: string, userId: string, input: CloudApiPrompt, tx?: Tx, authorize?: (tx: Tx) => Promise<void>, executionAdmission?: PromptExecutionAdmission) {
    const { chatId, userMessageId, agentId, model, effort, message } = input;
    const payload: CloudV2Prompt = { chatId, userMessageId, agentId, startedAt: input.startedAt ?? Date.now(),
      prompt: [{ type: "text", text: message }], ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
    // API retries carry text and an ID, not the producer's original timestamp.
    // This digest survives terminal payload compaction just like native receipts.
    const requestHash = createHash("sha256").update(JSON.stringify(["cloud-api-v0", chatId, message])).digest("hex");
    return this.enqueue(id, userId, payload, undefined, { tx, requestHash, apiSession: true, sessionName: input.sessionName,
      createdBySessionId: input.createdBySessionId, senderCredential: input.senderCredential, authorize, ...(executionAdmission ? { executionAdmission } : {}) });
  }

  async enqueue(id: string, userId: string, raw: CloudV2Prompt, authority?: AuthedUser,
    options?: { tx?: Tx | undefined; requestHash?: string; apiSession?: boolean; sessionName?: string | undefined;
      createdBySessionId?: string | null | undefined; device?: LocalDeviceBinding | undefined;
      senderCredential?: CloudApiPrompt["senderCredential"]; executionAdmission?: PromptExecutionAdmission; authorize?: ((tx: Tx) => Promise<void>) | undefined }): Promise<{ receipt: CloudV2PromptReceipt; replay: boolean; createdBySessionId: string | null }> {
    const parsed = CloudV2PromptSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid cloud prompt");
    const named = CloudV2SessionNameSchema.transform(value => value.trim()).optional().safeParse(options?.sessionName);
    if (!named.success) throw new HttpError(400, "invalid_request", "Invalid session name");
    const payload = parsed.data, encoded = JSON.stringify(payload), bytes = Buffer.byteLength(encoded);
    if (bytes > CLOUD_V2_MAX_PROMPT_BYTES) throw new HttpError(413, "payload_too_large", "Message is too large");
    const hash = options?.requestHash ?? createHash("sha256").update(encoded).digest("hex");
    const executionAdmission = options?.executionAdmission ?? (!options?.tx ? await this.execution?.preflightPrompt(id, userId, payload, authority) : undefined);
    const write = async (tx: Tx) => {
      const workspace = await this.owned(tx, id, userId, true, payload.userMessageId);
      await assertNoExecutionTransition(tx, id);
      await options?.authorize?.(tx);
      if (workspace.execution_mode === "active") {
        if (!this.execution || !executionAdmission || executionAdmission.person.userId !== userId || executionAdmission.person.workspaceId !== id)
          throw new HttpError(503, "agent_credentials_unavailable", "Execution admission is required");
        await this.execution.assertPrompt(tx, executionAdmission, payload);
      }
      if (options?.apiSession) {
        if (workspace.archived_at) throw new HttpError(409, "workspace_archived", "Unarchive the workspace before sending a message");
        // API session URLs omit the workspace. Serialize same-ID creates so
        // two workspaces cannot make that URL ambiguous after both enqueue.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0)) /* lock_purpose='cloud-api-session' */", [JSON.stringify([userId, payload.chatId])]);
        const duplicate = await tx.query(`SELECT 1 FROM cloud_v2_chats c JOIN cloud_v2_workspaces other ON other.id=c.workspace_id
          JOIN cloud_v2_workspaces target ON target.id=$1 AND target.org_id=other.org_id
          WHERE c.chat_id=$2 AND other.creator_user_id=$3 AND other.id<>$1 AND other.state<>'deleted'
            AND c.deleted_at IS NULL LIMIT 1`, [id, payload.chatId, userId]);
        if (duplicate.rowCount) throw new HttpError(409, "session_conflict", "This session id is already in use");
      }
      if (authority && (authority.id !== userId || (authority.authentication && !await securityStreamAuthority(tx, authority))))
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      const previous = workspace.previous;
      if (options?.device && (!authority || authority.id !== userId))
        throw new HttpError(401, "unauthorized", "A signed-in desktop session is required");
      if (previous) {
        if (options?.device) await this.localDevices.verify(tx, authority!, options.device);
        if (previous.creator_user_id !== userId || previous.payload_hash !== hash) throw conflict();
        return { receipt: previous.receipt, replay: true, createdBySessionId: previous.created_by_session_id };
      }
      if (workspace.state === "failed") throw new HttpError(409, "workspace_unavailable", "This cloud workspace is unavailable");
      const chat = await this.chat(tx, id, payload.chatId);
      // Bound retained bytes as well as pending bytes. Terminal prompt bodies
      // duplicate the transcript and may be compacted; their receipts may not.
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET payload=NULL,payload_bytes=0
        WHERE workspace_id=$1 AND payload IS NOT NULL AND terminal_at < clock_timestamp() - interval '7 days'`, [id]);
      const usage = (await tx.query<{ total: number; pending: number; bytes: number; retained: number }>(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE state IN ${PENDING})::int AS pending,
        coalesce(sum(payload_bytes) FILTER (WHERE state IN ${PENDING}),0)::int AS bytes,
        coalesce(sum(payload_bytes),0)::int AS retained
        FROM cloud_v2_prompt_outbox WHERE workspace_id=$1`, [id])).rows[0]!;
      if (usage.total >= this.limits.receipts || usage.pending >= this.limits.pending || usage.bytes + bytes > this.limits.bytes)
        throw new HttpError(429, "prompt_outbox_full", "The saved message queue is full. Wait for messages to finish or delete old chats");
      if (usage.retained + bytes > this.limits.bytes * 2) await tx.query(`UPDATE cloud_v2_prompt_outbox SET payload=NULL,payload_bytes=0
        WHERE workspace_id=$1 AND terminal_at IS NOT NULL AND payload IS NOT NULL`, [id]);
      const sequence = (BigInt(chat.next_sequence) + 1n).toString();
      const receipt: CloudV2PromptReceipt = { workspaceId: id, chatId: payload.chatId, userMessageId: payload.userMessageId,
        sequence, epoch: chat.epoch, acceptedAt: new Date().toISOString(), workspaceState: workspace.state };
      // A new chat must be discoverable after app exit, even before its VM has
      // booted. Keep prompt bubbles in the outbox until the worker records them:
      // pre-inserting transcript rows would reorder a queued follow-up ahead of
      // the preceding turn's later tools/assistant rows.
      const chatRow = JSON.stringify({ id: payload.chatId, folder: `/home/user/${workspace.repository}`,
          agentId: payload.agentId, agentName: { codex: "Codex", claude: "Claude", cursor: "Cursor" }[payload.agentId],
          title: named.data ?? "", model: payload.model ?? null, effort: payload.effort ?? "", createdAt: payload.startedAt, updatedAt: payload.startedAt });
      if (options?.device) await this.localDevices.connectMessage(tx, authority!, id, options.device);
      if (workspace.execution_mode === "active" && options?.device) {
        await tx.query(`INSERT INTO cloud_v2_chat_sender_bindings(workspace_id,chat_id,user_id,device_id,registration_id,generation,access_epoch)
          VALUES($1,$2,$3,$4,$5,1,$6) ON CONFLICT(workspace_id,chat_id,user_id) DO UPDATE SET
          device_id=EXCLUDED.device_id,registration_id=EXCLUDED.registration_id,access_epoch=EXCLUDED.access_epoch,retired=false,
          generation=CASE WHEN cloud_v2_chat_sender_bindings.device_id=EXCLUDED.device_id
            AND cloud_v2_chat_sender_bindings.registration_id=EXCLUDED.registration_id AND cloud_v2_chat_sender_bindings.access_epoch=EXCLUDED.access_epoch
            AND NOT cloud_v2_chat_sender_bindings.retired THEN cloud_v2_chat_sender_bindings.generation ELSE cloud_v2_chat_sender_bindings.generation+1 END`,
        [id, payload.chatId, userId, options.device.deviceId, options.device.registrationId, workspace.access_epoch]);
      }
      // One explicit wake belongs to this committed send, not to its retries.
      // A send racing stopping remains pending until the stop has completed.
      // Chat Stop cancels a turn, not its Mac. Inheritance still respects the
      // person's identity, access epoch and explicit binding-retirement fence.
      await tx.query(`WITH sender AS (
        SELECT CASE WHEN $22 THEN b.device_id ELSE coalesce($16::uuid,p.sender_device_id) END AS device_id,
          CASE WHEN $22 THEN b.registration_id ELSE coalesce($17::uuid,p.sender_registration_id) END AS registration_id,
          CASE WHEN $22 THEN b.generation WHEN $16::uuid IS NOT NULL THEN c.local_command_generation ELSE p.sender_binding_generation END AS generation
        FROM cloud_v2_prompt_chats c LEFT JOIN cloud_v2_prompt_outbox p
          ON p.workspace_id=c.workspace_id AND p.chat_id=c.chat_id AND p.sequence=c.next_sequence
            AND p.creator_user_id=$4 AND p.access_epoch=$7 AND p.sender_binding_generation=c.local_command_generation
        LEFT JOIN cloud_v2_chat_sender_bindings b ON $22 AND b.workspace_id=c.workspace_id AND b.chat_id=c.chat_id AND b.user_id=$4
          AND b.access_epoch=$7 AND NOT b.retired
        WHERE c.workspace_id=$1 AND c.chat_id=$3),
      inserted AS (
        INSERT INTO cloud_v2_prompt_outbox(workspace_id,user_message_id,chat_id,creator_user_id,sequence,epoch,access_epoch,payload_hash,payload,payload_bytes,receipt,wake_after_stop,session_name,created_by_session_id,
          sender_device_id,sender_registration_id,sender_binding_generation,sender_provider_session_id,sender_credential_kind,sender_credential_id,sender_context_id,execution_authority)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          CASE WHEN NOT EXISTS (SELECT 1 FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id=$3) THEN $14 ELSE NULL END, $15,
          device_id,registration_id,generation,$18,$19,$20,$21,$23 FROM sender RETURNING workspace_id),
      advanced AS (UPDATE cloud_v2_prompt_chats SET next_sequence=$5 WHERE workspace_id=$1 AND chat_id=$3
        AND EXISTS (SELECT 1 FROM inserted) RETURNING workspace_id),
      discovered AS (INSERT INTO cloud_v2_chats(workspace_id,chat_id,row,created_by_session_id)
        SELECT $1,$3,$13,$15 FROM advanced ON CONFLICT DO NOTHING),
      woke AS (UPDATE cloud_v2_workspaces SET state=CASE WHEN state='stopped' THEN 'starting' ELSE state END,
        worker_token_hash=CASE WHEN state='stopped' THEN NULL ELSE worker_token_hash END,
        worker_boot_id=CASE WHEN state='stopped' THEN NULL ELSE worker_boot_id END,
        execution_initiator_user_id=CASE WHEN state='stopped' AND execution_mode='active' THEN $4 ELSE execution_initiator_user_id END,
        execution_intent_id=CASE WHEN state='stopped' AND execution_mode='active' THEN gen_random_uuid() ELSE execution_intent_id END,
        execution_intent_authority=CASE WHEN state='stopped' AND execution_mode='active' THEN $23::jsonb ELSE execution_intent_authority END,
        archived_at=NULL, active_at=clock_timestamp(),
        attempts=CASE WHEN state='stopped' THEN 0 ELSE attempts END,
        next_attempt_at=CASE WHEN state='stopped' THEN NULL ELSE next_attempt_at END,
        updated_at=CASE WHEN state='stopped' THEN clock_timestamp() ELSE updated_at END WHERE id=$1
        AND EXISTS (SELECT 1 FROM advanced) RETURNING id)
      SELECT pg_notify('zeros_cloud_v2_prompts', id::text) FROM woke`,
      [id, payload.userMessageId, payload.chatId, userId, sequence, chat.epoch, workspace.access_epoch, hash, encoded, bytes,
        JSON.stringify(receipt), workspace.state === "stopping", chatRow, named.data ?? null, options?.createdBySessionId ?? null,
        options?.device?.deviceId ?? null, options?.device?.registrationId ?? null,
        authority?.authentication?.sessionId ?? null, options?.senderCredential?.kind ?? null, options?.senderCredential?.credentialId ?? null,
        options?.senderCredential?.contextId ?? null, workspace.execution_mode === "active", executionAdmission ? executionIntentAuthority(executionAdmission) : null]);
      if (executionAdmission) await this.execution!.assertPrompt(tx, executionAdmission, payload);
      await options?.authorize?.(tx);
      return { receipt, replay: false, createdBySessionId: options?.createdBySessionId ?? null };
    };
    return options?.tx ? write(options.tx) : withSystemTx(this.pool, write);
  }

  async retireLocalSender(id: string, userId: string, accessEpoch: string, sessionId: string | null): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      const workspace = await this.owned(tx, id, userId, true);
      if (workspace.access_epoch !== accessEpoch || !["creating","starting","running"].includes(workspace.state) || workspace.archived_at)
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      if (sessionId && !(await tx.query(`SELECT 1 FROM auth_sessions WHERE provider='workos' AND provider_session_id=$1 AND user_id=$2
        AND status='active' AND revoked_at IS NULL AND (provider_session_expires_at IS NULL OR provider_session_expires_at>clock_timestamp())`, [sessionId, userId])).rowCount)
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      // Legacy frames identify a native execution, whose chat mapping lives
      // only on the worker. Retiring every binding fails closed across replicas.
      await tx.query("UPDATE cloud_v2_prompt_chats SET local_command_generation=local_command_generation+1 WHERE workspace_id=$1", [id]);
    });
  }

  async list(id: string, userId: string, chatId: string, after = "0", limit = 100, includePayload = true): Promise<{ epoch: string; items: CloudV2PromptStatus[]; nextAfter: string | null }> {
    return withSystemTx(this.pool, async tx => {
      await this.owned(tx, id, userId, false);
      return this.readStatuses(tx,id,chatId,after,limit,includePayload);
    }, { consistentRead: true });
  }

  async listForViewer(id: string, chatId: string, after: string, limit: number, includePayload: boolean, authorize: (tx: Tx) => Promise<void>) {
    return withSystemTx(this.pool,async tx => {
      await authorize(tx);
      const result = await this.readStatuses(tx,id,chatId,after,limit,includePayload);
      await authorize(tx);
      return result;
    });
  }

  private async readStatuses(tx: Tx, id: string, chatId: string, after: string, limit: number, includePayload: boolean) {
      const chat = (await tx.query<{ epoch: string; next_sequence: string }>("SELECT epoch::text,next_sequence::text FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND chat_id=$2", [id, chatId])).rows[0];
      const { rows } = await tx.query<Row>(`WITH candidates AS (
        SELECT user_message_id,sequence,CASE WHEN $6::boolean THEN payload_bytes ELSE 0 END AS payload_bytes FROM cloud_v2_prompt_outbox
        WHERE workspace_id=$1 AND chat_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4),
        bounded AS (SELECT user_message_id,sum(payload_bytes) OVER (ORDER BY sequence) AS bytes FROM candidates)
        SELECT p.receipt,p.state,p.cancel_requested,p.sequence,CASE WHEN $6::boolean THEN p.payload ELSE NULL END AS payload
        FROM cloud_v2_prompt_outbox p JOIN bounded b USING(user_message_id)
        WHERE p.workspace_id=$1 AND b.bytes<=$5 ORDER BY p.sequence`, [id, chatId, after, limit, this.limits.readBytes, includePayload]);
      const last = rows.at(-1)?.sequence;
      return { epoch: chat?.epoch ?? "0", items: rows.map(status), nextAfter: last && BigInt(last) < BigInt(chat?.next_sequence ?? "0") ? last : null };
  }

  async stop(id: string, userId: string, chatId: string, throughEpoch: string, authority?: AuthedUser): Promise<{ chatId: string; epoch: string }> {
    return withSystemTx(this.pool, async tx => {
      await this.owned(tx, id, userId, true);
      if (authority?.authentication && !await securityStreamAuthority(tx, authority))
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
      return this.stopChat(tx, id, chatId, throughEpoch);
    });
  }

  async stopWorker(token: string, bootId: string, input: { chatId: string; throughEpoch: string }): Promise<{ chatId: string; epoch: string }> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId);
      return this.stopChat(tx, workspace.id, input.chatId, input.throughEpoch);
    });
  }

  private async stopChat(tx: Tx, id: string, chatId: string, throughEpoch: string): Promise<{ chatId: string; epoch: string }> {
      const chat = await this.chat(tx, id, chatId);
      if (BigInt(throughEpoch) > BigInt(chat.epoch)) throw new HttpError(409, "prompt_epoch_changed", "Conversation delivery changed");
      if (throughEpoch !== chat.epoch) return { chatId, epoch: chat.epoch };
      const epoch = (BigInt(chat.epoch) + 1n).toString();
      await tx.query("UPDATE cloud_v2_prompt_chats SET epoch=$3 WHERE workspace_id=$1 AND chat_id=$2", [id, chatId, epoch]);
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET cancel_requested=true,
        state=CASE WHEN state IN ('queued','inboxed') THEN 'cancelled' ELSE state END,
        terminal_at=CASE WHEN state IN ('queued','inboxed') THEN clock_timestamp() ELSE terminal_at END,
        updated_at=clock_timestamp() WHERE workspace_id=$1 AND chat_id=$2 AND state IN ${PENDING}`, [id, chatId]);
      await this.execution?.ended(tx, id, chatId);
      await notify(tx, id);
      return { chatId, epoch };
  }

  async pull(token: string, bootId: string, held?: string[], options?: { chatEdits: "new" | "due" }): Promise<CloudV2PromptPullReply> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId), id = workspace.id;
      if (workspace.state !== "running") return { prompts: [], stops: [] };
      if (workspace.handoff || workspace.recoveryHeld) return { prompts: [], stops: [] };
      // The old process might have passed a request to its provider. Only an
      // explicit new send can recover it: a new boot is never a replay permit.
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'interrupted' END,
        terminal_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND state IN ('dispatching','accepted') AND worker_boot_id IS DISTINCT FROM $2`, [id, bootId]);
      const result = await tx.query<CloudV2PromptPullReply>(`WITH candidates AS (
        SELECT p.user_message_id,p.payload_bytes,p.created_at,p.chat_id,p.sequence FROM cloud_v2_prompt_outbox p
        JOIN cloud_v2_prompt_chats c USING(workspace_id,chat_id)
        WHERE p.workspace_id=$1 AND p.state IN ('queued','inboxed') AND p.epoch=c.epoch AND p.access_epoch=$2
          AND NOT p.cancel_requested AND p.payload IS NOT NULL
          AND ($5::text[] IS NOT NULL AND NOT p.user_message_id=ANY($5::text[]) OR $5::text[] IS NULL
            AND (p.worker_boot_id IS DISTINCT FROM $3 OR p.lease_until IS NULL OR p.lease_until<=clock_timestamp()))
          AND NOT EXISTS (SELECT 1 FROM cloud_v2_prompt_outbox older WHERE older.workspace_id=p.workspace_id
            AND older.chat_id=p.chat_id AND older.sequence<p.sequence AND older.state IN ${PENDING}
            AND (p.payload->>'mode' IS DISTINCT FROM 'steer' OR older.state IN ('queued','inboxed')
              OR $7 AND older.creator_user_id<>p.creator_user_id))
        ORDER BY p.created_at,p.chat_id,p.sequence LIMIT 16),
        bounded AS (SELECT user_message_id,sum(payload_bytes) OVER (ORDER BY created_at,chat_id,sequence) AS bytes FROM candidates),
        delivered AS (UPDATE cloud_v2_prompt_outbox p SET
          delivery_id=CASE WHEN p.worker_boot_id=$3 AND p.delivery_id IS NOT NULL THEN p.delivery_id ELSE gen_random_uuid() END,
          worker_boot_id=$3,lease_until=clock_timestamp()+make_interval(secs=>$6::double precision/1000),updated_at=clock_timestamp()
          FROM bounded b WHERE p.workspace_id=$1 AND p.user_message_id=b.user_message_id AND b.bytes<=$4
          RETURNING p.receipt,p.payload,p.delivery_id,p.created_at,p.chat_id,p.sequence,p.session_name,p.creator_user_id)
        SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('receipt',receipt,'payload',payload,'deliveryId',delivery_id)
          || CASE WHEN session_name IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sessionName',session_name) END
          || CASE WHEN $7 THEN jsonb_build_object('senderUserId',creator_user_id) ELSE '{}'::jsonb END
          ORDER BY created_at,chat_id,sequence) FROM delivered),'[]'::jsonb) AS prompts,
          coalesce((SELECT jsonb_agg(jsonb_build_object('chatId',chat_id,'epoch',epoch) ORDER BY chat_id)
            FROM (SELECT chat_id,epoch::text FROM cloud_v2_prompt_chats
              WHERE workspace_id=$1 AND stop_acked_epoch<epoch ORDER BY chat_id LIMIT 128) pending_stops),'[]'::jsonb) AS stops`,
        [id, workspace.access_epoch, bootId, this.limits.readBytes, held ?? null, this.limits.leaseMs, workspace.execution_mode === "active"]);
      const reply = result.rows[0]!;
      const mode = options?.chatEdits === "due" || reply.prompts.length || reply.stops.length ? "due" : "new";
      return { ...reply, ...(options ? { chatEdits: await offerCloudChatEdits(tx, id, bootId, mode) } : {}) };
    });
  }

  private row(workspace: WorkerSnapshot): Row {
    const row = workspace.prompt;
    if (!row) throw new HttpError(404, "prompt_not_found", "Saved message not found");
    return row;
  }

  async ack(token: string, bootId: string, input: { userMessageId: string; deliveryId: string }): Promise<{ state: CloudV2PromptState }> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId, input.userMessageId), row = this.row(workspace);
      if (terminal(row.state)) return { state: row.state };
      if (row.worker_boot_id !== bootId || row.delivery_id !== input.deliveryId) throw conflict();
      if (row.state === "queued") await tx.query(`UPDATE cloud_v2_prompt_outbox SET state='inboxed',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND user_message_id=$2`, [workspace.id, input.userMessageId]);
      return { state: row.state === "queued" ? "inboxed" : row.state };
    });
  }

  async begin(token: string, bootId: string, input: { userMessageId: string; deliveryId: string; dispatchId: string }): Promise<{ dispatch: boolean; state: CloudV2PromptState }> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId, input.userMessageId), row = this.row(workspace);
      assertRecoveryTurnReady(workspace.recoveryHeld);
      if (terminal(row.state)) return { dispatch: false, state: row.state };
      if (workspace.chatDeleted) throw new HttpError(409, "conversation_deleted", "This conversation was deleted");
      const chat = workspace.chatEpoch === null ? await this.chat(tx, workspace.id, row.chat_id) : { epoch: workspace.chatEpoch };
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

  async outcome(token: string, bootId: string, input: { userMessageId: string; dispatchId?: string | undefined; deliveryId?: string | undefined; state: "accepted" | "completed" | "failed" | "cancelled" | "interrupted" }): Promise<{ state: CloudV2PromptState }> {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, token, bootId, input.userMessageId), row = this.row(workspace);
      // The current process may repair a saved terminal result from its old
      // boot. That is evidence from disk, never permission to call a provider.
      if (row.dispatch_id) {
        if (row.dispatch_id !== input.dispatchId) throw conflict();
        if (input.state === "accepted" && (row.worker_boot_id !== bootId || row.state === "interrupted")) throw conflict();
      } else if (row.worker_boot_id !== bootId || row.delivery_id !== input.deliveryId || input.state === "accepted") throw conflict();
      if (terminal(row.state) && row.state !== "interrupted") return { state: row.state };
      await tx.query(`UPDATE cloud_v2_prompt_outbox SET state=$3,updated_at=clock_timestamp(),
        terminal_at=CASE WHEN $3='accepted' THEN NULL ELSE clock_timestamp() END
        WHERE workspace_id=$1 AND user_message_id=$2`, [workspace.id, input.userMessageId, input.state]);
      if (input.state !== "accepted") await this.execution?.ended(tx, workspace.id, row.chat_id, row.user_message_id);
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
        worker_token_hash=NULL,worker_boot_id=NULL,archived_at=NULL,updated_at=clock_timestamp(),
        execution_initiator_user_id=CASE WHEN execution_mode='active' THEN (SELECT p.creator_user_id FROM cloud_v2_prompt_outbox p
          WHERE p.workspace_id=w.id AND p.wake_after_stop AND p.state IN ('queued','inboxed') AND p.access_epoch=w.access_epoch AND NOT p.cancel_requested ORDER BY p.created_at,p.user_message_id LIMIT 1) ELSE execution_initiator_user_id END,
        execution_intent_id=CASE WHEN execution_mode='active' THEN gen_random_uuid() ELSE execution_intent_id END,
        execution_intent_authority=CASE WHEN execution_mode='active' THEN (SELECT p.execution_authority FROM cloud_v2_prompt_outbox p
          WHERE p.workspace_id=w.id AND p.wake_after_stop AND p.state IN ('queued','inboxed') AND p.access_epoch=w.access_epoch AND NOT p.cancel_requested
          ORDER BY p.created_at,p.user_message_id LIMIT 1) ELSE execution_intent_authority END
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
