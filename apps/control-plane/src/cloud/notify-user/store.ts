import { createHash } from "node:crypto";
import type pg from "pg";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { CloudLocalDevices } from "../local-commands/devices.js";
import type { LocalDeviceBinding } from "../local-commands/contract.js";
import { cloudChatSender } from "../prompt-sender.js";
import { hashCloudV2Token } from "../tokens.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { NotifyUserEventSchema, type NotifyUserEvent, type NotifyUserWorkerRequest } from "./contract.js";
import type { CloudExecutionContexts } from "../execution/store.js";
import { actorChanged } from "../execution/errors.js";

export const CLOUD_NOTIFICATION_LIMITS = { hourly: 30, receipts: 10_000 };
export type NotificationHint = { workspaceId: string; notificationId: string };
export type NotificationAuthority = { token: string; bootId: string; workspaceId: string; accessEpoch: string };
type Worker = { id: string; org_id: string; access_epoch: string; stop_generation: string; name: string; title: string | null; execution_mode: string };
const unauthorized = () => new HttpError(401,"worker_unauthorized","Worker authorization is no longer current");
const conflict = () => new HttpError(409,"notification_conflict","This notification id was already used with different input");
export class NotificationRateLimit extends HttpError {
  constructor(readonly retryAfter: number) { super(429,"rate_limited","Too many workspace notifications"); }
}

/** Receipts have no claim/result workflow. The workspace lock orders the
 * shared budget, turn uniqueness, Stop and authority changes across replicas. */
export class CloudNotifyUser {
  execution?: CloudExecutionContexts;
  constructor(readonly pool: pg.Pool, private readonly devices: CloudLocalDevices, private readonly limits = CLOUD_NOTIFICATION_LIMITS) {}

  private async worker(tx: Tx, auth: NotificationAuthority): Promise<Worker> {
    const sql = `SELECT w.id,w.org_id,w.access_epoch::text,w.stop_generation::text,w.name,w.title,w.execution_mode FROM cloud_v2_workspaces w
      WHERE w.id=$1 AND w.worker_token_hash=$2 AND w.worker_boot_id=$3 AND w.access_epoch=$4
        AND w.state='running' AND w.archived_at IS NULL AND ${CLOUD_V2_LIVE_ACCESS}`;
    const params = [auth.workspaceId,hashCloudV2Token(auth.token),auth.bootId,auth.accessEpoch];
    if (!(await tx.query(`${sql} FOR UPDATE OF w`,params)).rowCount) throw unauthorized();
    // A membership subquery may have been evaluated before the lock wait.
    const row = (await tx.query<Worker>(sql,params)).rows[0];
    if (!row) throw unauthorized();
    return row;
  }

  async accept(auth: NotificationAuthority, input: NotifyUserWorkerRequest): Promise<void> {
    const replay = input.contextId && this.execution ? await withSystemTx(this.pool, async tx => Boolean((await tx.query(
      "SELECT 1 FROM cloud_v2_notifications WHERE workspace_id=$1 AND notification_id=$2", [auth.workspaceId,input.notificationId])).rowCount)) : false;
    const authority = input.contextId && this.execution && !replay ? await this.execution.authorizedContext(auth,input.contextId,["turn"]) : undefined;
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx,auth);
      const hash = createHash("sha256").update(JSON.stringify([input.chatId,input.userMessageId,input.executionId,input.kind,input.title,input.message,...(input.contextId ? [input.contextId] : [])])).digest();
      const previous = (await tx.query<{ request_hash: Buffer }>(`SELECT request_hash FROM cloud_v2_notifications
        WHERE workspace_id=$1 AND notification_id=$2`,[workspace.id,input.notificationId])).rows[0];
      if (previous) { if (!previous.request_hash.equals(hash)) throw conflict(); return; }
      if (workspace.execution_mode === "active") {
        if (!authority || authority.context.chat_id !== input.chatId || authority.context.user_message_id !== input.userMessageId || authority.context.workspace_id !== workspace.id) throw actorChanged();
        await authority.check(tx);
      } else if (input.contextId) throw actorChanged();
      const chat = (await tx.query<{ title: string }>(`SELECT coalesce(row->>'title','') AS title FROM cloud_v2_chats
        WHERE workspace_id=$1 AND chat_id=$2 AND deleted_at IS NULL`,[workspace.id,input.chatId])).rows[0];
      if (!chat) throw new HttpError(404,"not_found","Cloud conversation not found");
      if ((await tx.query(`SELECT 1 FROM cloud_v2_notifications WHERE workspace_id=$1 AND chat_id=$2 AND user_message_id=$3`,
        [workspace.id,input.chatId,input.userMessageId])).rowCount) throw new HttpError(409,"already_notified","This turn already notified the user");
      const rate = (await tx.query<{ count: number; retry: number; at: Date; times: Date[] }>(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
        SELECT clock.at,count(point.at)::int AS count,coalesce(array_agg(point.at) FILTER(WHERE point.at IS NOT NULL),'{}'::timestamptz[]) AS times,
          greatest(1,ceil(extract(epoch FROM (min(point.at)+interval '1 hour'-clock.at))))::int AS retry
        FROM cloud_v2_workspaces w CROSS JOIN clock LEFT JOIN LATERAL unnest(w.notification_times) AS point(at)
          ON point.at>clock.at-interval '1 hour' WHERE w.id=$1 GROUP BY clock.at`,[workspace.id])).rows[0]!;
      if (rate.count >= this.limits.hourly) throw new NotificationRateLimit(rate.retry);
      const retained = (await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM
        (SELECT 1 FROM cloud_v2_notifications WHERE workspace_id=$1 LIMIT $2) bounded`,[workspace.id,this.limits.receipts])).rows[0]!;
      if (retained.count >= this.limits.receipts) throw new HttpError(429,"notifications_full","Delete old conversations before sending more notifications");
      const sender = await cloudChatSender(tx,workspace,input.chatId,input.contextId);
      const userId = sender?.valid ? sender.creator_user_id : null;
      const now = rate.at;
      const event: NotifyUserEvent | null = userId ? { notificationId: input.notificationId,
        workspace: { id: workspace.id,name: workspace.name.slice(0,120),title: workspace.title?.slice(0,120) ?? null },
        chat: { id: input.chatId,title: chat.title.slice(0,4096) },kind: input.kind,title: input.title,message: input.message,createdAt: now.toISOString() } : null;
      await tx.query("UPDATE cloud_v2_workspaces SET notification_times=$2::timestamptz[] WHERE id=$1",[workspace.id,[...rate.times,now]]);
      await tx.query(`INSERT INTO cloud_v2_notifications(workspace_id,notification_id,chat_id,user_message_id,request_hash,
        access_epoch,stop_generation,sender_user_id,sender_message_id,created_at,event,context_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [workspace.id,input.notificationId,input.chatId,input.userMessageId,hash,workspace.access_epoch,workspace.stop_generation,
        userId,userId ? sender!.user_message_id : null,now,event ? JSON.stringify(event) : null,input.contextId ?? null]);
      if (userId) await this.devices.notifyUser(tx,userId,workspace.id,input.notificationId);
      await authority?.check(tx);
    });
  }

  read(user: AuthedUser, device: LocalDeviceBinding, hints: readonly NotificationHint[], since: string): Promise<NotifyUserEvent[]> {
    if (!hints.length) return Promise.resolve([]);
    return withSystemTx(this.pool, async tx => {
      await this.devices.verify(tx,user,device);
      const { rows } = await tx.query<{ event: string }>(`SELECT n.event FROM cloud_v2_notifications n
        JOIN jsonb_to_recordset($3::jsonb) AS hint("workspaceId" uuid,"notificationId" uuid)
          ON n.workspace_id=hint."workspaceId" AND n.notification_id=hint."notificationId"
        JOIN cloud_v2_workspaces w ON w.id=n.workspace_id
        JOIN cloud_v2_chats h ON h.workspace_id=n.workspace_id AND h.chat_id=n.chat_id
        JOIN cloud_v2_prompt_chats c ON c.workspace_id=n.workspace_id AND c.chat_id=n.chat_id
        JOIN cloud_v2_prompt_outbox p ON p.workspace_id=n.workspace_id AND p.user_message_id=n.sender_message_id
        LEFT JOIN cloud_v2_execution_contexts x ON x.id=n.context_id AND x.workspace_id=n.workspace_id
        WHERE n.sender_user_id=$1 AND n.event IS NOT NULL AND n.created_at>$2 AND n.created_at>clock_timestamp()-interval '10 minutes'
          AND w.state='running' AND w.archived_at IS NULL AND w.access_epoch=n.access_epoch AND w.stop_generation=n.stop_generation
          AND ${CLOUD_V2_LIVE_ACCESS} AND h.deleted_at IS NULL
          AND p.creator_user_id=$1 AND ((n.context_id IS NULL AND p.sequence=c.next_sequence AND p.sender_binding_generation=c.local_command_generation)
            OR (n.context_id IS NOT NULL AND x.user_id=$1 AND x.user_message_id=p.user_message_id AND coalesce(x.reason,'completed')='completed'))
          AND p.epoch=c.epoch AND p.access_epoch=w.access_epoch
          AND p.sender_device_id IS NOT NULL AND p.sender_registration_id IS NOT NULL AND NOT p.cancel_requested
          ORDER BY n.created_at,n.notification_id`,[user.id,since,JSON.stringify(hints)]);
      return rows.map(row => NotifyUserEventSchema.parse(JSON.parse(row.event)));
    },{ consistentRead: true });
  }

  sweep(): Promise<number> {
    return withSystemTx(this.pool, async tx => {
      const result = await tx.query(`WITH expired AS MATERIALIZED (SELECT workspace_id,notification_id FROM cloud_v2_notifications
        WHERE event IS NOT NULL AND created_at<=clock_timestamp()-interval '10 minutes' ORDER BY created_at LIMIT 128 FOR UPDATE SKIP LOCKED)
        UPDATE cloud_v2_notifications n SET event=NULL FROM expired e WHERE n.workspace_id=e.workspace_id AND n.notification_id=e.notification_id`);
      return result.rowCount ?? 0;
    });
  }

  nextDue(): Promise<number | null> {
    return withSystemTx(this.pool, async tx => {
      const row = (await tx.query<{ delay: string }>(`SELECT extract(epoch FROM (created_at+interval '10 minutes'-clock_timestamp()))*1000 AS delay
        FROM cloud_v2_notifications WHERE event IS NOT NULL ORDER BY created_at LIMIT 1`)).rows[0];
      return row ? Number(row.delay) : null;
    },{ consistentRead: true });
  }
}
