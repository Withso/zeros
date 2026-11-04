import { createRequire } from "node:module";
import type { Tx } from "../db.js";
import { boundMessageSearchHits, messageSearchInput, messageSearchLimitError, MessageSearchIndex, MESSAGE_SEARCH_DEADLINE_MS, type MessageSearchDatabase, type MessageSearchHit } from "./message-search.js";

const require = createRequire(import.meta.url);

export type SearchOptions = { query: unknown; limit?: unknown; chatId?: string | undefined; folder?: string | undefined };
type Payload = { ord: string; chat_id: string; msg_id: string; payload: string; created_at_ms: string };

export async function mirrorMessageSearch(tx: Tx, workspaceId: string, options: SearchOptions, deadline = Date.now() + MESSAGE_SEARCH_DEADLINE_MS): Promise<{ hits: MessageSearchHit[] }> {
  const input = messageSearchInput(options.query, options.limit);
  if (!input.match || !input.limit) return { hits: [] };
  if (Date.now() >= deadline) throw messageSearchLimitError();
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => MessageSearchDatabase };
  const index = new MessageSearchIndex<string>(new DatabaseSync(":memory:"), Date.now, deadline);
  const budget = async () => {
    await tx.query("SELECT set_config('statement_timeout',$1,true)", [String(index.remaining())]);
    index.remaining();
  };
  const payloads = async (ordinals: string[]): Promise<Payload[]> => {
    await budget();
    const { rows } = await tx.query<Payload>(`SELECT ord,chat_id,msg_id,payload,created_at_ms FROM cloud_v2_messages
      WHERE workspace_id=$1 AND ord=ANY($2::bigint[]) ORDER BY ord`, [workspaceId, ordinals]);
    index.remaining();
    return rows;
  };
  try {
    let cursor = "0";
    for (;;) {
      await budget();
      // Check the byte budget before fetching payloads; a batch can contain large legacy rows.
      const { rows } = await tx.query<{ ord: string; bytes: number }>(`SELECT m.ord,octet_length(m.payload) AS bytes
        FROM cloud_v2_messages m JOIN cloud_v2_chats c ON c.workspace_id=m.workspace_id AND c.chat_id=m.chat_id
        WHERE m.workspace_id=$1 AND m.ord>$2 AND c.deleted_at IS NULL
          AND ($3::text IS NULL OR m.chat_id=$3) AND ($3::text IS NOT NULL OR $4::text IS NULL OR c.row->>'folder'=$4)
        ORDER BY m.ord LIMIT 256`, [workspaceId, cursor, options.chatId ?? null, options.folder ?? null]);
      if (!rows.length) break;
      index.checkBatch(rows.length, rows.reduce((bytes, row) => bytes + row.bytes, 0));
      for (const row of await payloads(rows.map(row => row.ord))) index.add(row.ord, row.payload);
      cursor = rows[rows.length - 1]!.ord;
    }
    const matches = index.search(input);
    if (!matches.length) return { hits: [] };
    const rows = new Map((await payloads(matches)).map(row => [row.ord, row]));
    const hits = boundMessageSearchHits(matches.map(ord => {
      const row = rows.get(ord)!;
      return { chatId: row.chat_id, msgId: row.msg_id, payload: row.payload, createdAt: Number(row.created_at_ms) };
    }));
    index.remaining();
    return { hits };
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "57014") throw messageSearchLimitError();
    throw error;
  } finally { index.close(); }
}
