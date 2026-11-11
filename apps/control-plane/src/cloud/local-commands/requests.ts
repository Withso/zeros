import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import type { CloudAgentCredentialKeys } from "../../agent-credentials/agent-credential-envelope.js";
import { hashCloudV2Token } from "../tokens.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { RUNTIME_HANDOFF_SESSION } from "../runtime-handoff-store.js";
import { cloudChatSender } from "../prompt-sender.js";
import { LocalCommandIdSchema, LocalCommandInputSchema, LocalMacResultSchema, type LocalCommandInput, type LocalCommandNotice,
  type LocalCommandOutcome, type LocalCommandReceipt, type LocalCommandResult, type LocalDeviceBinding } from "./contract.js";
import { CloudLocalDevices, limited, localUserAuthority, notFound } from "./devices.js";
import { openLocalInput, openLocalResult, sealLocalInput, sealLocalResult } from "./envelope.js";

export const NewLocalCommandSchema = z.object({ requestId: z.string().uuid(), chatId: LocalCommandIdSchema,
  executionId: LocalCommandIdSchema, input: LocalCommandInputSchema }).strict();
export type NewLocalCommand = z.infer<typeof NewLocalCommandSchema>;
type MacResult = z.infer<typeof LocalMacResultSchema>;
export const LOCAL_REQUEST_LIMITS = { chatRate: 10, deviceRate: 30, chatPending: 2, devicePending: 4,
  notices: 128, receipts: 10_000, deviceBytes: 32*1024*1024, workspaceBytes: 64*1024*1024 };
const OUTPUT_RESERVATION = 2*1024*1024;
const conflict = () => new HttpError(409, "local_command_conflict", "This request id was already used with different input or output");
const notPending = () => new HttpError(409, "local_command_not_pending", "This local command can no longer accept that decision");
export const localUnavailable = () => new HttpError(503, "local_commands_unavailable", "Local commands are temporarily unavailable");
const unauthorized = () => new HttpError(401, "worker_unauthorized", "Worker authorization is no longer current");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest();
const summary = (result: LocalCommandResult): LocalCommandResult => ({ outcome: result.outcome,
  ...(result.outcome === "failed" && result.error !== undefined ? { error: result.error } : {}),
  ...(result.mac === undefined ? {} : { mac: result.mac }), ...(result.connectedMacs === undefined ? {} : { connectedMacs: result.connectedMacs }) });
type Worker = { id: string; org_id: string; access_epoch: string; stop_generation: string; state: string;
  archived_at: Date | null; local_commands_allowed: boolean };
export type LocalRequestRow = {
  workspace_id: string; request_id: string; chat_id: string; sender_user_id: string | null; target_device_id: string | null;
  target_registration_id: string | null; target_instance_id: string | null; target_name: string | null; default_mac_name: string | null;
  is_default_target: boolean; worker_boot_id: string; execution_id: string; input_hash: Buffer; input_envelope: unknown;
  result_hash: Buffer | null; result_envelope: unknown; result_summary: LocalCommandResult | null;
  phase: "pending" | "claimed" | "terminal"; outcome: LocalCommandOutcome | null; timeout_ms: number;
  created_at: Date; delivery_deadline: Date; approval_deadline: Date; run_deadline: Date | null; delivered_at: Date | null;
  terminal_at: Date | null; device_ack_at: Date | null; output_ack_at: Date | null; updated_at: Date;
  checked_at: Date; fences_valid: boolean; enabled: boolean; reachable: boolean; instance_changed: boolean;
  workspace_name: string; workspace_title: string | null; chat_title: string; default_device_id: string | null;
};

// The projection is shared by passive reads and locked mutations. Triggers
// bound N-1 writers, but this current snapshot is the execution authority.
const snapshot = `SELECT r.*,clock_timestamp() AS checked_at,o.local_commands_allowed AS enabled,
  w.name AS workspace_name,w.title AS workspace_title,coalesce(h.row->>'title','') AS chat_title,p.sender_device_id AS default_device_id,
  coalesce(d.reachable_until>clock_timestamp(),false) AS reachable,
  d.instance_id IS DISTINCT FROM r.target_instance_id AS instance_changed,
  coalesce(w.state='running' AND w.archived_at IS NULL AND w.access_epoch=r.access_epoch AND w.stop_generation=r.stop_generation
    AND w.worker_boot_id=r.worker_boot_id AND ${CLOUD_V2_LIVE_ACCESS}
    AND c.next_sequence=r.message_sequence AND c.epoch=r.chat_epoch AND c.local_command_generation=r.binding_generation
    AND p.user_message_id=r.message_id AND p.creator_user_id=r.sender_user_id AND p.sender_device_id IS NOT NULL
    AND p.sender_binding_generation=c.local_command_generation AND NOT p.cancel_requested AND h.deleted_at IS NULL
    AND d.registration_id=r.target_registration_id AND d.instance_id=r.target_instance_id AND d.revoked_at IS NULL
    AND s.status='active' AND s.revoked_at IS NULL AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())
    AND EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=d.user_id AND i.provider='workos' AND i.provider_sub=s.provider_sub AND i.status='active')
    AND u.auth_status='active' AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=w.org_id AND m.user_id=r.sender_user_id)
    AND cm.registration_id=r.target_registration_id AND cm.disconnected_at IS NULL
    AND (cm.is_latest_sender OR greatest(cm.connected_at,cm.last_used_at)>clock_timestamp()-interval '12 hours'),false) AS fences_valid
  FROM local_command_requests r JOIN cloud_v2_workspaces w ON w.id=r.workspace_id JOIN organizations o ON o.id=w.org_id
  LEFT JOIN cloud_v2_prompt_chats c ON c.workspace_id=r.workspace_id AND c.chat_id=r.chat_id
  LEFT JOIN cloud_v2_prompt_outbox p ON p.workspace_id=r.workspace_id AND p.user_message_id=r.message_id
  LEFT JOIN cloud_v2_chats h ON h.workspace_id=r.workspace_id AND h.chat_id=r.chat_id
  LEFT JOIN local_command_devices d ON d.user_id=r.sender_user_id AND d.device_id=r.target_device_id
  LEFT JOIN auth_sessions s ON s.provider='workos' AND s.provider_session_id=d.provider_session_id AND s.user_id=d.user_id
  LEFT JOIN users u ON u.id=r.sender_user_id
  LEFT JOIN cloud_v2_connected_macs cm ON cm.workspace_id=r.workspace_id AND cm.user_id=r.sender_user_id AND cm.device_id=r.target_device_id`;

function terminalOutcome(row: LocalRequestRow): LocalCommandOutcome | null {
  if (row.phase === "terminal") return row.outcome;
  if (!row.enabled) return "disabled";
  if (row.phase === "claimed" && row.instance_changed) return "interrupted";
  if (!row.fences_valid) return "cancelled";
  if (row.phase === "claimed") return row.run_deadline! <= row.checked_at ? "command_timed_out" : null;
  if (!row.delivered_at && row.delivery_deadline <= row.checked_at) return "mac_not_connected";
  return row.approval_deadline <= row.checked_at ? "approval_timed_out" : null;
}

export class CloudLocalCommands {
  constructor(readonly pool: pg.Pool, private readonly keys: CloudAgentCredentialKeys, readonly devices: CloudLocalDevices,
    private readonly limits = LOCAL_REQUEST_LIMITS) {}

  setting(user: AuthedUser, organizationId: string, enabled?: boolean) {
    return withSystemTx(this.pool, async tx => {
      if (enabled !== undefined) await tx.query(`SELECT id FROM organizations o WHERE id=$1 AND NOT is_personal AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=o.id AND m.user_id=$2) FOR UPDATE OF o`,[organizationId,user.id]);
      await localUserAuthority(tx,user);
      const row = (await tx.query<{ role: string; local_commands_allowed: boolean }>(`SELECT m.role,o.local_commands_allowed
        FROM organizations o JOIN organization_members m ON m.org_id=o.id AND m.user_id=$2
        WHERE o.id=$1 AND NOT o.is_personal AND o.deleted_at IS NULL`,[organizationId,user.id])).rows[0];
      if (!row) throw notFound();
      if (enabled === undefined) return { localCommandsEnabled: row.local_commands_allowed };
      if (row.role !== "owner" && row.role !== "admin") throw new HttpError(403,"forbidden","An organization owner or admin must change this setting");
      await tx.query("UPDATE organizations SET local_commands_allowed=$2 WHERE id=$1 AND local_commands_allowed IS DISTINCT FROM $2",[organizationId,enabled]);
      return { localCommandsEnabled: enabled };
    },{ consistentRead: enabled === undefined });
  }

  enabled(workspaceId: string): Promise<boolean> {
    return withSystemTx(this.pool, async tx => Boolean((await tx.query(`SELECT 1 FROM cloud_v2_workspaces w
      JOIN organizations o ON o.id=w.org_id WHERE w.id=$1 AND o.local_commands_allowed AND w.archived_at IS NULL
        AND w.state IN ('creating','starting','running') AND ${CLOUD_V2_LIVE_ACCESS}`,[workspaceId])).rowCount),{ consistentRead: true });
  }

  async advertise(token: string, bootId: string, supported: boolean, handoff?: string): Promise<boolean> {
    // Preserve the private candidate if a current-boot hello finishes later;
    // only the promoted boot can use the worker request routes.
    const result = await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_v2_workspaces w SET local_command_boot_ids=ARRAY(
      SELECT DISTINCT id FROM unnest(local_command_boot_ids || CASE WHEN $5 THEN ARRAY[$2::uuid] ELSE '{}'::uuid[] END) AS boots(id)
      WHERE (id=w.worker_boot_id OR id=$2::uuid OR ($3::uuid IS NULL AND id=(
        SELECT CASE WHEN h.state='rolling_back' THEN h.rollback_boot_id ELSE h.next_boot_id END
        FROM cloud_worker_runtime_handoffs h WHERE h.workspace_id=w.id AND h.old_boot_id=w.worker_boot_id
          AND h.token_hash=w.worker_token_hash AND h.state IN ('activating','rolling_back'))))
        AND (id<>$2::uuid OR $5))
      WHERE worker_token_hash=$1 AND state IN ('creating','starting','running') AND ${CLOUD_V2_LIVE_ACCESS}
        AND (($3::uuid IS NULL AND worker_boot_id=$2) OR ($3::uuid IS NOT NULL AND ${RUNTIME_HANDOFF_SESSION}))`,
    [hashCloudV2Token(token),bootId,handoff ?? null,null,supported]));
    return Boolean(result.rowCount);
  }

  private async worker(tx: Tx, token: string, bootId: string, lock = false): Promise<Worker> {
    const sql = `SELECT w.id,w.org_id,w.access_epoch::text,w.stop_generation::text,w.state,w.archived_at,o.local_commands_allowed
      FROM cloud_v2_workspaces w JOIN organizations o ON o.id=w.org_id WHERE w.worker_token_hash=$1 AND w.worker_boot_id=$2
        AND $2::uuid=ANY(w.local_command_boot_ids) AND w.state IN ('starting','running','stopping') AND ${CLOUD_V2_LIVE_ACCESS}`;
    const params = [hashCloudV2Token(token), bootId];
    if (lock && !(await tx.query(`${sql} FOR UPDATE OF w`, params)).rowCount) throw unauthorized();
    const row = (await tx.query<Worker>(sql, params)).rows[0];
    if (!row) throw unauthorized();
    return row;
  }

  private async row(tx: Tx, workspaceId: string, requestId: string, lock = false): Promise<LocalRequestRow> {
    const row = (await tx.query<LocalRequestRow>(`${snapshot} WHERE r.workspace_id=$1 AND r.request_id=$2 ${lock ? "FOR UPDATE OF r" : ""}`, [workspaceId, requestId])).rows[0];
    if (!row) throw notFound();
    return row;
  }

  private async hints(tx: Tx, userId: string | null, workspaceId: string, defaultId: string | null) {
    if (!userId || !(await tx.query(`SELECT 1 FROM cloud_v2_workspaces w JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=$2
      JOIN users u ON u.id=m.user_id AND u.auth_status='active' AND u.deleted_at IS NULL WHERE w.id=$1 AND ${CLOUD_V2_LIVE_ACCESS}`, [workspaceId,userId])).rowCount) return [];
    return (await this.devices.macs(tx,userId,workspaceId)).filter(mac => mac.connected && mac.reachable)
      .map(mac => ({ name: mac.name, isDefault: mac.deviceId === defaultId }));
  }

  private async projectedResult(tx: Tx, row: LocalRequestRow, outcome: LocalCommandOutcome): Promise<LocalCommandResult> {
    return { outcome, ...(row.target_name === null ? {} : { mac: row.target_name }),
      ...(outcome === "no_target" || outcome === "mac_not_connected" ? { connectedMacs: await this.hints(tx,row.sender_user_id,row.workspace_id,row.default_device_id) } : {}) };
  }

  private async receipt(tx: Tx, row: LocalRequestRow): Promise<LocalCommandReceipt> {
    const outcome = terminalOutcome(row);
    const available = row.phase === "terminal" && row.result_envelope !== null && row.output_ack_at === null
      && row.terminal_at!.getTime()+24*60*60_000 > row.checked_at.getTime();
    let result: LocalCommandResult | null = null;
    if (outcome) {
      try { result = available ? openLocalResult(row.result_envelope,row,this.keys)
        : row.phase === "terminal" ? row.result_summary ?? await this.projectedResult(tx,row,outcome) : await this.projectedResult(tx,row,outcome); }
      catch { throw localUnavailable(); }
    }
    return { requestId: row.request_id, state: outcome ? "terminal" : row.phase, approvalDeadline: row.approval_deadline.toISOString(),
      runDeadline: row.run_deadline?.toISOString() ?? null, mac: row.target_name, result, outputAvailable: available };
  }

  private notice(row: LocalRequestRow): LocalCommandNotice {
    const outcome = terminalOutcome(row);
    if (outcome) return { requestId: row.request_id, state: "terminal", outcome };
    let input: LocalCommandInput;
    try { input = openLocalInput(row.input_envelope,row,this.keys); } catch { throw localUnavailable(); }
    return { requestId: row.request_id, state: row.phase as "pending" | "claimed", workspace: { id: row.workspace_id,
      name: row.workspace_name.slice(0,120), title: row.workspace_title?.slice(0,120) ?? null }, chat: { id: row.chat_id, title: row.chat_title.slice(0,4096) },
      input, mac: row.target_name!, defaultMac: row.default_mac_name, isDefaultTarget: row.is_default_target,
      createdAt: row.created_at.toISOString(), approvalDeadline: row.approval_deadline.toISOString(), runDeadline: row.run_deadline?.toISOString() ?? null };
  }

  private async finish(tx: Tx, row: LocalRequestRow, result: LocalCommandResult, macResult?: MacResult): Promise<LocalRequestRow> {
    if (row.phase === "terminal") return row;
    let envelope;
    try { envelope = macResult ? sealLocalResult(result,row,this.keys) : null; }
    catch { throw localUnavailable(); }
    await tx.query(`UPDATE local_command_requests SET phase='terminal',outcome=$3,terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
      result_summary=$4,result_hash=$5,result_envelope=$6,output_bytes=$7,reserved_output_bytes=0
      WHERE workspace_id=$1 AND request_id=$2 AND phase<>'terminal'`, [row.workspace_id,row.request_id,result.outcome,JSON.stringify(summary(result)),
      macResult ? digest(macResult) : null, envelope ? JSON.stringify(envelope) : null, Buffer.byteLength(result.stdout ?? "")+Buffer.byteLength(result.stderr ?? "")]);
    return this.row(tx,row.workspace_id,row.request_id);
  }
  private async settle(tx: Tx, row: LocalRequestRow): Promise<LocalRequestRow> {
    const outcome = terminalOutcome(row);
    return outcome && row.phase !== "terminal" ? this.finish(tx,row,await this.projectedResult(tx,row,outcome)) : row;
  }

  async create(token: string, bootId: string, input: NewLocalCommand): Promise<{ receipt: LocalCommandReceipt; replay: boolean }> {
    try { return await withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx,token,bootId,true), hash = digest([input.chatId,input.executionId,input.input]);
      const existing = (await tx.query("SELECT input_hash FROM local_command_requests WHERE workspace_id=$1 AND request_id=$2", [workspace.id,input.requestId])).rows[0];
      if (existing) {
        if (!existing.input_hash.equals(hash)) throw conflict();
        return { receipt: await this.receipt(tx,await this.row(tx,workspace.id,input.requestId)), replay: true };
      }
      if (workspace.state !== "running" || workspace.archived_at) throw unauthorized();
      const sender = await cloudChatSender(tx,workspace,input.chatId);
      const userId = sender?.creator_user_id ?? null, defaultId = sender?.valid ? sender.sender_device_id : null;
      let outcome: LocalCommandOutcome | null = !workspace.local_commands_allowed ? "disabled" : !sender?.valid ? "no_target" : null;
      let target: { device_id: string; registration_id: string; instance_id: string; name: string } | undefined;
      if (!outcome && userId) {
        const macs = (await this.devices.macs(tx,userId,workspace.id)).filter(mac => mac.connected && mac.reachable);
        const matches = macs.filter(mac => input.input.mac === undefined ? mac.deviceId === defaultId : mac.name === input.input.mac);
        if (matches.length === 1) target = (await tx.query(`SELECT d.device_id,d.registration_id,d.instance_id,d.name FROM local_command_devices d
          WHERE user_id=$1 AND device_id=$2 FOR UPDATE`, [userId,matches[0]!.deviceId])).rows[0];
        if (target) {
          const live = (await this.devices.macs(tx,userId,workspace.id)).find(mac => mac.deviceId === target!.device_id && mac.connected && mac.reachable);
          if (!live || (input.input.mac === undefined && target.registration_id !== sender!.sender_registration_id)) target = undefined;
        }
        if (!target) outcome = "mac_not_connected";
      }
      // Workspace and target-device locks serialize budgets across API replicas
      // and across different workspaces addressing the same Mac.
      const usage = (await tx.query(`SELECT count(*)::int AS receipts,
        count(*) FILTER(WHERE chat_id=$2 AND sender_user_id IS NOT DISTINCT FROM $3::uuid AND created_at>clock_timestamp()-interval '1 minute')::int AS rate,
        count(*) FILTER(WHERE chat_id=$2 AND phase IN ('pending','claimed'))::int AS pending,
        coalesce(sum(output_bytes+reserved_output_bytes),0)::bigint AS bytes FROM local_command_requests WHERE workspace_id=$1`, [workspace.id,input.chatId,userId])).rows[0];
      if (usage.receipts >= this.limits.receipts || usage.rate >= this.limits.chatRate || (!outcome && (usage.pending >= this.limits.chatPending || Number(usage.bytes)+OUTPUT_RESERVATION > this.limits.workspaceBytes))) throw limited();
      if (target) {
        const usage = (await tx.query(`SELECT count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 minute')::int AS rate,
          count(*) FILTER(WHERE phase IN ('pending','claimed'))::int AS pending,
          count(*) FILTER(WHERE device_ack_at IS NULL AND target_registration_id=$3)::int AS notices,coalesce(sum(output_bytes+reserved_output_bytes),0)::bigint AS bytes
          FROM local_command_requests WHERE sender_user_id=$1 AND target_device_id=$2`, [userId,target.device_id,target.registration_id])).rows[0];
        if (usage.rate >= this.limits.deviceRate || usage.pending >= this.limits.devicePending || usage.notices >= this.limits.notices || Number(usage.bytes)+OUTPUT_RESERVATION > this.limits.deviceBytes) throw limited();
      }
      await this.worker(tx,token,bootId);
      const binding = { workspace_id: workspace.id,request_id: input.requestId,sender_user_id: userId };
      const terminal = outcome ? { outcome, ...(outcome === "no_target" || outcome === "mac_not_connected"
        ? { connectedMacs: await this.hints(tx,userId,workspace.id,defaultId) } : {}) } : null;
      let envelope;
      try { envelope = outcome ? null : sealLocalInput(input.input,binding,this.keys); }
      catch { throw localUnavailable(); }
      await tx.query(`WITH clock AS (SELECT clock_timestamp() AS at) INSERT INTO local_command_requests(
        workspace_id,request_id,chat_id,sender_user_id,target_device_id,target_registration_id,target_instance_id,target_name,default_mac_name,is_default_target,
        message_id,message_sequence,chat_epoch,binding_generation,access_epoch,stop_generation,worker_boot_id,execution_id,input_hash,input_envelope,input_bytes,
        phase,outcome,timeout_ms,result_summary,reserved_output_bytes,created_at,delivery_deadline,approval_deadline,terminal_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
          CASE WHEN $23::text IS NULL THEN 2097152 ELSE 0 END,at,at+interval '10 seconds',at+interval '120 seconds',CASE WHEN $23::text IS NOT NULL THEN at END FROM clock`,
      [workspace.id,input.requestId,input.chatId,userId,target?.device_id ?? null,target?.registration_id ?? null,target?.instance_id ?? null,target?.name ?? null,
        defaultId ? sender?.name ?? null : null,input.input.mac === undefined && target?.device_id === defaultId,sender?.user_message_id ?? null,sender?.sequence ?? null,
        sender?.epoch ?? null,sender?.local_command_generation ?? null,workspace.access_epoch,workspace.stop_generation,bootId,input.executionId,hash,
        envelope ? JSON.stringify(envelope) : null,envelope ? Buffer.byteLength(JSON.stringify(input.input)) : 0,outcome ? "terminal" : "pending",outcome,input.input.timeoutMs ?? 60_000,
        terminal ? JSON.stringify(terminal) : null]);
      if (!outcome) await tx.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp() WHERE id=$1", [workspace.id]);
      return { receipt: await this.receipt(tx,await this.row(tx,workspace.id,input.requestId)), replay: false };
    }); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") throw conflict();
      throw error;
    }
  }

  read(token: string, bootId: string, requestId: string) {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx,token,bootId);
      const row = await this.row(tx,workspace.id,requestId);
      return { workspaceId: workspace.id, receipt: await this.receipt(tx,row), wakeAt: (row.phase === "claimed"
        ? row.run_deadline! : row.delivered_at ? row.approval_deadline : row.delivery_deadline).getTime() };
    }, { consistentRead: true });
  }
  cancel(token: string, bootId: string, requestId: string) {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx,token,bootId,true);
      const row = await this.settle(tx,await this.row(tx,workspace.id,requestId,true));
      return this.receipt(tx,await this.finish(tx,row,{ outcome: "cancelled", ...(row.target_name ? { mac: row.target_name } : {}) }));
    });
  }
  ack(token: string, bootId: string, requestId: string) {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx,token,bootId,true);
      const row = await this.settle(tx,await this.row(tx,workspace.id,requestId,true));
      if (row.phase !== "terminal") throw notPending();
      await tx.query(`UPDATE local_command_requests SET input_envelope=NULL,input_bytes=0,result_envelope=NULL,output_bytes=0,
        output_ack_at=coalesce(output_ack_at,clock_timestamp()),updated_at=clock_timestamp() WHERE workspace_id=$1 AND request_id=$2
          AND (input_envelope IS NOT NULL OR result_envelope IS NOT NULL OR output_ack_at IS NULL)`, [workspace.id,requestId]);
    });
  }
  retireSender(token: string, bootId: string, chatId: string) {
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx,token,bootId,true);
      await tx.query("UPDATE cloud_v2_prompt_chats SET local_command_generation=local_command_generation+1 WHERE workspace_id=$1 AND chat_id=$2", [workspace.id,chatId]);
    });
  }

  private async deviceRow(tx: Tx, user: AuthedUser, binding: LocalDeviceBinding, requestId: string, lock: boolean) {
    const identity = (await tx.query<{ workspace_id: string }>(`SELECT workspace_id FROM local_command_requests WHERE sender_user_id=$1
      AND request_id=$2 AND target_device_id=$3 AND target_registration_id=$4`, [user.id,requestId,binding.deviceId,binding.registrationId])).rows[0];
    if (!identity) throw notFound();
    if (lock) await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [identity.workspace_id]);
    await this.devices.verify(tx,user,binding,lock);
    const row = await this.row(tx,identity.workspace_id,requestId,lock);
    if (row.sender_user_id !== user.id || row.target_device_id !== binding.deviceId || row.target_registration_id !== binding.registrationId) throw notFound();
    return row;
  }
  deviceRead(user: AuthedUser, binding: LocalDeviceBinding, requestId: string) {
    return withSystemTx(this.pool, async tx => this.notice(await this.deviceRow(tx,user,binding,requestId,false)), { consistentRead: true });
  }
  notices(user: AuthedUser, binding: LocalDeviceBinding) {
    return withSystemTx(this.pool, async tx => {
      await this.devices.verify(tx,user,binding);
      const { rows } = await tx.query<LocalRequestRow>(`${snapshot} WHERE r.sender_user_id=$1 AND r.target_device_id=$2
        AND r.target_registration_id=$3 AND r.device_ack_at IS NULL ORDER BY r.created_at,r.request_id LIMIT 128`, [user.id,binding.deviceId,binding.registrationId]);
      return rows.map(row => this.notice(row));
    }, { consistentRead: true });
  }
  received(user: AuthedUser, binding: LocalDeviceBinding, requestId: string) {
    return withSystemTx(this.pool, async tx => {
      let row = await this.settle(tx,await this.deviceRow(tx,user,binding,requestId,true));
      if (row.phase === "pending" && !row.delivered_at) {
        await tx.query("UPDATE local_command_requests SET delivered_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND request_id=$2", [row.workspace_id,requestId]);
        row = await this.row(tx,row.workspace_id,requestId);
      }
      return this.notice(row);
    });
  }
  async claim(user: AuthedUser, binding: LocalDeviceBinding, requestId: string, decision: "approve" | "deny") {
    const result = await withSystemTx(this.pool, async tx => {
      const row = await this.settle(tx,await this.deviceRow(tx,user,binding,requestId,true));
      if (row.phase !== "pending" || !row.reachable || row.target_instance_id !== binding.instanceId) return null;
      if (decision === "deny") return this.notice(await this.finish(tx,row,{ outcome: "denied", denied: true, mac: row.target_name! }));
      await tx.query(`UPDATE local_command_requests SET phase='claimed',delivered_at=coalesce(delivered_at,clock_timestamp()),claimed_at=clock_timestamp(),
        run_deadline=least(clock_timestamp()+timeout_ms*interval '1 millisecond',approval_deadline+timeout_ms*interval '1 millisecond'),updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND request_id=$2`, [row.workspace_id,requestId]);
      await tx.query("UPDATE cloud_v2_connected_macs SET last_used_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3", [row.workspace_id,user.id,binding.deviceId]);
      return this.notice(await this.row(tx,row.workspace_id,requestId));
    });
    if (!result) throw notPending();
    return result;
  }
  result(user: AuthedUser, binding: LocalDeviceBinding, requestId: string, value: MacResult) {
    return withSystemTx(this.pool, async tx => {
      let row = await this.settle(tx,await this.deviceRow(tx,user,binding,requestId,true));
      if (row.phase === "terminal") {
        if (row.result_hash && !row.result_hash.equals(digest(value))) throw conflict();
        return { outcome: row.outcome! };
      }
      if (row.target_instance_id !== binding.instanceId || (row.phase === "pending" && !["denied","approval_timed_out","interrupted"].includes(value.outcome))) throw notPending();
      row = await this.finish(tx,row,{ ...value, mac: row.target_name! },value);
      return { outcome: row.outcome! };
    });
  }
  async deviceAck(user: AuthedUser, binding: LocalDeviceBinding, requestId: string) {
    const completed = await withSystemTx(this.pool, async tx => {
      const row = await this.settle(tx,await this.deviceRow(tx,user,binding,requestId,true));
      if (row.phase !== "terminal") return false;
      await tx.query("UPDATE local_command_requests SET device_ack_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND request_id=$2 AND device_ack_at IS NULL", [row.workspace_id,requestId]);
      return true;
    });
    if (!completed) throw notPending();
  }

  async sweep(): Promise<number> {
    return withSystemTx(this.pool, async tx => {
      const expired = await tx.query<LocalRequestRow>(`${snapshot} WHERE r.phase IN ('pending','claimed') AND
        CASE WHEN r.phase='claimed' THEN r.run_deadline WHEN r.delivered_at IS NULL THEN r.delivery_deadline ELSE r.approval_deadline END <= clock_timestamp()
        ORDER BY CASE WHEN r.phase='claimed' THEN r.run_deadline WHEN r.delivered_at IS NULL THEN r.delivery_deadline ELSE r.approval_deadline END
        LIMIT 128 FOR UPDATE OF r SKIP LOCKED`);
      for (const row of expired.rows) await this.settle(tx,row);
      const erased = await tx.query(`WITH due AS MATERIALIZED (SELECT workspace_id,request_id FROM local_command_requests
        WHERE terminal_at<=clock_timestamp()-interval '24 hours' AND (input_envelope IS NOT NULL OR result_envelope IS NOT NULL)
        ORDER BY terminal_at LIMIT 128 FOR UPDATE SKIP LOCKED)
        UPDATE local_command_requests r SET input_envelope=NULL,input_bytes=0,result_envelope=NULL,output_bytes=0,updated_at=clock_timestamp()
        FROM due WHERE r.workspace_id=due.workspace_id AND r.request_id=due.request_id`);
      return expired.rows.length+(erased.rowCount ?? 0);
    });
  }
  nextDue(): Promise<number | null> {
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query(`SELECT extract(epoch FROM (min(at)-clock_timestamp()))*1000 AS delay FROM (
        (SELECT CASE WHEN phase='claimed' THEN run_deadline WHEN delivered_at IS NULL THEN delivery_deadline ELSE approval_deadline END AS at
          FROM local_command_requests WHERE phase IN ('pending','claimed') ORDER BY at LIMIT 1)
        UNION ALL (SELECT terminal_at+interval '24 hours' FROM local_command_requests WHERE input_envelope IS NOT NULL OR result_envelope IS NOT NULL
          ORDER BY terminal_at LIMIT 1)) due`)).rows[0];
      return row.delay === null ? null : Number(row.delay);
    }, { consistentRead: true });
  }
}
