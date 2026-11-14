import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { CloudV2HistoryStateSchema, type CloudV2HistoryState, type CloudV2MessageRow } from "./contract.js";
import { isUserMessage, mirrorMessageSenders, mirrorTurnOpening, type MessageSenders } from "./history.js";

export type IndexedMessage = CloudV2MessageRow & { index: number };
export type HistoryRange = { revision: number; messageCount: number; fromIndex: number; toIndex: number;
  rows: IndexedMessage[]; historyState?: CloudV2HistoryState; turnOpening?: CloudV2MessageRow; senders?: MessageSenders };
export type HistoryDelta = { resync: true; revision: number; messageCount: number }
  | { resync: false; fromRevision: number; revision: number; messageCount: number; rows: IndexedMessage[]; historyState?: CloudV2HistoryState; senders?: MessageSenders };
type Message = { ord: string; msg_id: string; kind: string; payload: string; created_at_ms: string };
const indexed = (row: Message, index: number): IndexedMessage => ({ index, msgId: row.msg_id, kind: row.kind, payload: row.payload, createdAt: Number(row.created_at_ms) });

export function cacheCounter(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new HttpError(503, "history_unavailable", "History is temporarily unavailable");
  return number;
}

async function snapshot(tx: Tx, workspaceId: string, chatId: string) {
  const row = (await tx.query<{ revision: string; resync_revision: string; message_count: string; history_state: unknown }>(`
    SELECT coalesce(s.revision,0)::text AS revision,coalesce(s.resync_revision,0)::text AS resync_revision,
      coalesce(s.message_count,(SELECT count(*) FROM cloud_v2_messages m WHERE m.workspace_id=h.workspace_id AND m.chat_id=h.chat_id))::text AS message_count,
      h.row->'historyState' AS history_state
    FROM cloud_v2_chats h LEFT JOIN cloud_v2_history_cache s USING(workspace_id,chat_id)
    WHERE h.workspace_id=$1 AND h.chat_id=$2 AND h.deleted_at IS NULL`, [workspaceId, chatId])).rows[0];
  if (!row) throw new HttpError(404, "chat_not_found", "Conversation not found");
  const state = CloudV2HistoryStateSchema.safeParse(row.history_state);
  return { revision: cacheCounter(row.revision), resyncRevision: cacheCounter(row.resync_revision),
    messageCount: cacheCounter(row.message_count), ...(state.success ? { historyState: state.data } : {}) };
}

export async function mirrorMessageRange(tx: Tx, workspaceId: string, chatId: string, from: number, to: number, includeSenders = false): Promise<HistoryRange> {
  const { revision, messageCount, historyState } = await snapshot(tx, workspaceId, chatId);
  const fromIndex = Math.min(from, messageCount), toIndex = Math.min(to, messageCount);
  const { rows } = await tx.query<Message>(`SELECT ord,msg_id,kind,payload,created_at_ms FROM cloud_v2_messages
    WHERE workspace_id=$1 AND chat_id=$2 ORDER BY ord,msg_id OFFSET $3 LIMIT $4`, [workspaceId, chatId, fromIndex, toIndex - fromIndex]);
  const first = rows[0], opening = first && !isUserMessage(first) ? await mirrorTurnOpening(tx, workspaceId, chatId, first.ord) : undefined;
  const messages = rows.map((row, index) => indexed(row, fromIndex + index));
  const ids = [...messages, ...(opening ? [opening] : [])].filter(row => isUserMessage(row)).map(row => row.msgId);
  return { revision, messageCount, fromIndex, toIndex, rows: messages,
    ...(historyState ? { historyState } : {}), ...(opening ? { turnOpening: opening } : {}),
    ...(includeSenders ? { senders: await mirrorMessageSenders(tx, workspaceId, chatId, ids) } : {}) };
}

export async function mirrorMessageDelta(tx: Tx, workspaceId: string, chatId: string, fromRevision: number, includeSenders = false): Promise<HistoryDelta> {
  const { revision, messageCount, resyncRevision, historyState } = await snapshot(tx, workspaceId, chatId);
  const resync = { resync: true as const, revision, messageCount };
  if (fromRevision > revision || fromRevision < resyncRevision) return resync;
  const changes = (await tx.query<{ msg_id: string }>(`SELECT msg_id FROM cloud_v2_history_changes
    WHERE workspace_id=$1 AND chat_id=$2 AND revision>$3 LIMIT 501`, [workspaceId, chatId, fromRevision])).rows;
  if (changes.length > 500) return resync;
  // Compute positions from IDs alone. A delta need not load every unchanged
  // native payload in a long conversation to locate its changed rows.
  const rows = changes.length ? (await tx.query<Message & { index: string }>(`
    WITH positions AS (
      SELECT msg_id,row_number() OVER (ORDER BY ord,msg_id)-1 AS index FROM cloud_v2_messages WHERE workspace_id=$1 AND chat_id=$2
    ) SELECT m.ord,m.msg_id,m.kind,m.payload,m.created_at_ms,p.index
      FROM positions p JOIN cloud_v2_messages m ON m.workspace_id=$1 AND m.chat_id=$2 AND m.msg_id=p.msg_id
      WHERE p.msg_id=ANY($3::text[]) ORDER BY p.index`, [workspaceId, chatId, changes.map(row => row.msg_id)])).rows : [];
  const messages = rows.map(row => indexed(row, cacheCounter(row.index)));
  return { resync: false, fromRevision, revision, messageCount, rows: messages,
    ...(historyState ? { historyState } : {}),
    ...(includeSenders ? { senders: await mirrorMessageSenders(tx, workspaceId, chatId, messages.filter(row => isUserMessage(row)).map(row => row.msgId)) } : {}) };
}
