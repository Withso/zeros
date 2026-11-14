// Native-ID mirror reads. Keep the window rules in parity with the worker's
// sessions/chat-history.ts; the CP deploys without that package at runtime.
import { z } from "zod";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { CloudV2HistoryStateSchema, type CloudV2HistoryState, type CloudV2MessageRow } from "./contract.js";
import type { CloudV2Store } from "./store.js";
import { MessageSearchError } from "./message-search.js";

export type MessageSenders = Record<string, { userId: string } | null>;
export type MessageWindow = { messages: CloudV2MessageRow[]; turnOpening?: CloudV2MessageRow; historyState?: CloudV2HistoryState; senders?: MessageSenders };
export type WindowOptions = { limit?: number; before?: number; beforeMsgId?: string; includeSenders?: boolean };
type Row = { ord: string; msg_id: string; kind: string; payload: string; created_at_ms: string };
const columns = "ord, msg_id, kind, payload, created_at_ms";
const persisted = (row: Row): CloudV2MessageRow => ({ msgId: row.msg_id, kind: row.kind, payload: row.payload, createdAt: Number(row.created_at_ms) });
export const isUserMessage = (row: Pick<Row, "kind" | "payload">, openingOnly = false): boolean => {
  if (row.kind !== "text") return false;
  try { const value = JSON.parse(row.payload); return value?.role === "user" && (!openingOnly || value.steeredTurnId == null); }
  catch { return false; }
};

export async function mirrorMessageWindow(tx: Tx, workspaceId: string, chatId: string, options: WindowOptions): Promise<MessageWindow> {
  const saved = await tx.query<{ state: unknown }>("SELECT row->'historyState' AS state FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id=$2 AND deleted_at IS NULL", [workspaceId, chatId]);
  const parsed = CloudV2HistoryStateSchema.safeParse(saved.rows[0]?.state);
  const state = parsed.success ? { historyState: parsed.data } : {};
  const result = { ...await mirrorMessageRows(tx, workspaceId, chatId, options), ...state };
  if (!options.includeSenders) return result;
  const ids = [...result.messages, ...(result.turnOpening ? [result.turnOpening] : [])].filter(row => isUserMessage(row)).map(row => row.msgId);
  return { ...result, senders: await mirrorMessageSenders(tx, workspaceId, chatId, ids) };
}

export async function mirrorMessageSenders(tx: Tx, workspaceId: string, chatId: string, ids: string[]): Promise<MessageSenders> {
  // Receipts precede worker mirroring and outlive prompt payload compaction.
  // No receipt means unknown; payloads and the current Creator cannot fill it.
  const keys = [...new Set(ids)];
  const readable = chatId.includes("\0") ? [] : keys.filter(id => !id.includes("\0"));
  const rows = readable.length ? (await tx.query<{ user_message_id: string; creator_user_id: string }>(
    `SELECT user_message_id,creator_user_id FROM cloud_v2_prompt_outbox
     WHERE workspace_id=$1 AND chat_id=$2 AND user_message_id=ANY($3::text[])`, [workspaceId, chatId, readable])).rows : [];
  const senders = new Map(rows.map(row => [row.user_message_id, { userId: row.creator_user_id }]));
  return Object.fromEntries(keys.map(id => [id, senders.get(id) ?? null]));
}

async function mirrorMessageRows(tx: Tx, workspaceId: string, chatId: string, options: WindowOptions): Promise<MessageWindow> {
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
  if (!paged && oldest && !isUserMessage(oldest) && rows.length < 1000) {
    const extra = await newest(1000 - rows.length, oldest.ord);
    let opening = extra.findIndex(row => isUserMessage(row, true));
    if (opening < 0) opening = extra.findIndex(row => isUserMessage(row));
    if (opening >= 0) rows.push(...extra.slice(0, opening + 1));
    oldest = rows.at(-1);
  }
  const result: MessageWindow = { messages: rows.map(persisted).reverse() };
  if (!paged && oldest && !isUserMessage(oldest)) {
    // A turn larger than the 1,000-row budget keeps a separate opening.
    const opening = await mirrorTurnOpening(tx, workspaceId, chatId, oldest.ord);
    if (opening) result.turnOpening = opening;
  }
  return result;
}

export async function mirrorTurnOpening(tx: Tx, workspaceId: string, chatId: string, before: string): Promise<CloudV2MessageRow | undefined> {
  for (const openingOnly of [true, false]) {
    let cursor = before;
    for (;;) {
      // Native JSON can exceed jsonb's Unicode or numeric domain. Keep those
      // candidates opaque and classify them with the worker's parser.
      const { rows: [anchor] } = await tx.query<Row>(
        `SELECT ${columns} FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2 AND ord<$3 AND kind='text'
         AND CASE WHEN pg_input_is_valid(payload,'jsonb') THEN
           payload::jsonb->>'role'='user' ${openingOnly ? "AND payload::jsonb->>'steeredTurnId' IS NULL" : ""}
         ELSE payload IS JSON OBJECT END
         ORDER BY ord DESC LIMIT 1`, [workspaceId, chatId, cursor]);
      if (!anchor) break;
      if (isUserMessage(anchor, openingOnly)) return persisted(anchor);
      cursor = anchor.ord;
    }
  }
}

export const HISTORY_OPS = ["chats.list", "messages.window", "messages.windowOlder", "messages.search", "messages.range", "messages.since"] as const;
const HistorySchema = z.object({ op: z.enum(HISTORY_OPS), params: z.record(z.string(), z.unknown()).default({}) }).strict();
const SharingHistorySchema = HistorySchema.extend({ op: z.enum([...HISTORY_OPS, "messages.senders"]) });
const id = z.string().min(1).max(256);
const cacheId = id.refine(value => !value.includes("\0"));
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const RangeSchema = z.object({ chatId: cacheId, fromIndex: counter, toIndex: counter }).strict()
  .refine(value => value.fromIndex <= value.toIndex && value.toIndex - value.fromIndex <= 500);
const SinceSchema = z.object({ chatId: cacheId, revision: counter }).strict();
const SendersSchema = z.object({ chatId: id, userMessageIds: z.array(id).min(1).max(200) }).strict();
export type HistoryStore = Pick<CloudV2Store, "listChats" | "messageWindow" | "searchMessages" | "messageRange" | "messageSince">;
export async function readCloudV2SharingHistory(store: HistoryStore & Pick<CloudV2Store, "messageSenders">,
  workspaceId: string, request: unknown): Promise<unknown> {
  const parsed = SharingHistorySchema.safeParse(request);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Unsupported history read");
  const { op, params } = parsed.data;
  if (op === "messages.senders") {
    const lookup = SendersSchema.safeParse(params);
    if (!lookup.success) throw new HttpError(400, "invalid_request", "Invalid sender lookup");
    return { senders: await store.messageSenders(workspaceId, lookup.data.chatId, lookup.data.userMessageIds) };
  }
  return readCloudV2History(store, workspaceId, parsed.data, { includeSenders: true });
}

export async function readCloudV2History(store: HistoryStore,
  workspaceId: string, request: unknown, options: { includeSenders?: boolean } = {}): Promise<unknown> {
  const parsed = HistorySchema.safeParse(request);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Unsupported history read");
  const { op, params } = parsed.data;
  if (op === "messages.search") {
    const scope = z.object({ chatId: id.optional(), folder: z.string().min(1).max(4096).optional() }).safeParse(params);
    if (!scope.success) throw new HttpError(400, "invalid_request", "Invalid search scope");
    try { return await store.searchMessages(workspaceId, { query: params.query, limit: params.limit, ...scope.data }); }
    catch (error) {
      if (error instanceof MessageSearchError) throw new HttpError(error.code === "SEARCH_LIMIT" ? 413 : 400, error.code, error.message);
      throw error;
    }
  }
  if (op === "chats.list") return store.listChats(workspaceId, !!options.includeSenders, true);
  if (op === "messages.range") {
    const range = RangeSchema.safeParse(params);
    if (!range.success) throw new HttpError(400, "invalid_request", "Invalid message range");
    return store.messageRange(workspaceId, range.data.chatId, range.data.fromIndex, range.data.toIndex, !!options.includeSenders);
  }
  if (op === "messages.since") {
    const since = SinceSchema.safeParse(params);
    if (!since.success) throw new HttpError(400, "invalid_request", "Invalid history revision");
    return store.messageSince(workspaceId, since.data.chatId, since.data.revision, !!options.includeSenders);
  }
  const chatId = id.safeParse(params.chatId);
  if (!chatId.success) throw new HttpError(400, "invalid_request", "chatId is required");
  const limit = z.number().finite().catch(200).parse(params.limit);
  if (op === "messages.windowOlder") {
    const beforeMsgId = id.safeParse(params.beforeMsgId);
    if (!beforeMsgId.success) throw new HttpError(400, "invalid_request", "beforeMsgId is required");
    return store.messageWindow(workspaceId, chatId.data, { limit, beforeMsgId: beforeMsgId.data, ...options });
  }
  const before = z.number().finite().catch(0).parse(params.before);
  return store.messageWindow(workspaceId, chatId.data, { limit, before, ...options });
}
