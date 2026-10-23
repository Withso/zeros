// Native-ID mirror reads. Keep the window rules in parity with the worker's
// sessions/chat-history.ts; the CP deploys without that package at runtime.
import { z } from "zod";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import type { CloudV2MessageRow } from "./contract.js";
import type { CloudV2Store } from "./store.js";

export type MessageWindow = { messages: CloudV2MessageRow[]; turnOpening?: CloudV2MessageRow };
export type WindowOptions = { limit?: number; before?: number; beforeMsgId?: string };
type Row = { ord: string; msg_id: string; kind: string; payload: string; created_at_ms: string };
const columns = "ord, msg_id, kind, payload, created_at_ms";
const persisted = (row: Row): CloudV2MessageRow => ({ msgId: row.msg_id, kind: row.kind, payload: row.payload, createdAt: Number(row.created_at_ms) });
const user = (row: Row, openingOnly = false): boolean => {
  if (row.kind !== "text") return false;
  try { const value = JSON.parse(row.payload); return value?.role === "user" && (!openingOnly || value.steeredTurnId == null); }
  catch { return false; }
};

export async function mirrorMessageWindow(tx: Tx, workspaceId: string, chatId: string, options: WindowOptions): Promise<MessageWindow> {
  const limit = options.limit ?? 200;
  const cap = Number.isFinite(limit) ? limit < 0 ? 1000 : Math.min(1000, Math.floor(limit)) : 200;
  if (!cap) return { messages: [] };
  let before: string | undefined;
  const paged = options.beforeMsgId !== undefined || Boolean(options.before);
  if (options.beforeMsgId !== undefined) {
    before = (await tx.query<{ ord: string }>(
      "SELECT ord FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2 AND msg_id=$3",
      [workspaceId, chatId, options.beforeMsgId])).rows[0]?.ord;
    if (!before) return { messages: [] };
  } else if (options.before) {
    if (options.before <= 1) return { messages: [] };
    // Worker ordinals are per-chat positions, not the mirror's global identity
    // sequence (which also has gaps after upserts).
    before = (await tx.query<{ ord: string }>(
      "SELECT ord FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2 ORDER BY ord OFFSET $3 LIMIT 1",
      [workspaceId, chatId, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(options.before) - 1)])).rows[0]?.ord;
  }
  const newest = async (count: number, cursor?: string) => (await tx.query<Row>(
    `SELECT ${columns} FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2
     ${cursor ? "AND ord<$4" : ""} ORDER BY ord DESC LIMIT $3`, [workspaceId, chatId, count, ...(cursor ? [cursor] : [])])).rows;
  const rows = await newest(cap, before);
  let oldest = rows.at(-1);
  if (!paged && oldest && !user(oldest) && rows.length < 1000) {
    const extra = await newest(1000 - rows.length, oldest.ord);
    let opening = extra.findIndex(row => user(row, true));
    if (opening < 0) opening = extra.findIndex(row => user(row));
    if (opening >= 0) rows.push(...extra.slice(0, opening + 1));
    oldest = rows.at(-1);
  }
  const result: MessageWindow = { messages: rows.map(persisted).reverse() };
  if (!paged && oldest && !user(oldest)) {
    // A turn larger than the 1,000-row budget keeps a separate opening. Only
    // that row crosses the DB boundary; malformed legacy payloads are inert.
    for (const openingOnly of [true, false]) {
      const { rows: anchors } = await tx.query<Row>(
        `SELECT ${columns} FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2 AND ord<$3 AND kind='text'
         AND (CASE WHEN payload IS JSON OBJECT THEN payload::jsonb END)->>'role'='user'
         ${openingOnly ? "AND (CASE WHEN payload IS JSON OBJECT THEN payload::jsonb END)->>'steeredTurnId' IS NULL" : ""}
         ORDER BY ord DESC LIMIT 1`, [workspaceId, chatId, oldest.ord]);
      if (anchors[0]) { result.turnOpening = persisted(anchors[0]); break; }
    }
  }
  return result;
}

export const HISTORY_OPS = ["chats.list", "messages.window", "messages.windowOlder", "messages.search"] as const;
const HistorySchema = z.object({ op: z.enum(HISTORY_OPS), params: z.record(z.string(), z.unknown()).default({}) }).strict();
const id = z.string().min(1).max(256);
export async function readCloudV2History(store: Pick<CloudV2Store, "listChats" | "messageWindow">, workspaceId: string, request: unknown): Promise<unknown> {
  const parsed = HistorySchema.safeParse(request);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Unsupported history read");
  const { op, params } = parsed.data;
  if (op === "messages.search") throw new HttpError(409, "CLOUD_V2_UNSUPPORTED", "Search is not available in cloud workspaces");
  if (op === "chats.list") return store.listChats(workspaceId);
  const chatId = id.safeParse(params.chatId);
  if (!chatId.success) throw new HttpError(400, "invalid_request", "chatId is required");
  const limit = z.number().finite().catch(200).parse(params.limit);
  if (op === "messages.windowOlder") {
    const beforeMsgId = id.safeParse(params.beforeMsgId);
    if (!beforeMsgId.success) throw new HttpError(400, "invalid_request", "beforeMsgId is required");
    return store.messageWindow(workspaceId, chatId.data, { limit, beforeMsgId: beforeMsgId.data });
  }
  const before = z.number().finite().catch(0).parse(params.before);
  return store.messageWindow(workspaceId, chatId.data, { limit, before });
}
