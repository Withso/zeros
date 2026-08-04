// ──────────────────────────────────────────────────────────
// Chat transcripts — chat_messages in the unified Zeros DB (Phase 2b)
// ──────────────────────────────────────────────────────────
//
// The engine persists agent messages here AS IT STREAMS them (the persist hook
// in src/engine/index.ts folds chunks with the shared applyUpdate coalescer and
// upserts the changed messages). It's the source — works even when no client is
// attached (a cloud agent after the laptop closes). The renderer reads them over
// the bridge (messages.window) on web.
//
// Wire shape = PersistedMessage (mirrors the renderer's PersistedMessageWire:
// msgId / kind / payload=JSON(AgentMessage) / createdAt). Storage/ordering mirror
// electron/db.ts agent_messages exactly (upsert by (chat_id, msg_id); `ord` =
// MAX+1 on first insert; window newest-by-ord then reversed to chronological).
// ──────────────────────────────────────────────────────────

import { openZerosDb } from "./index";
import { nextRev, recordTombstone } from "./sync";

export interface PersistedMessage {
  msgId: string;
  kind: string;
  payload: string;
  createdAt: number;
}

interface MsgDbRow {
  msg_id: string;
  ord: number;
  kind: string;
  payload: string;
  created_at: number;
}

interface TurnOwnerDbRow {
  turn_id: string;
  started_at: number;
  ended_at: number | null;
  opening_ord: number;
}

/** Older builds persisted steered user bubbles but did not identify the
 * provider turn that owned them. Infer that relationship at the read boundary
 * from the durable turn interval and opening-message order. This is an
 * in-memory compatibility annotation: it does not rewrite history or bump
 * sync revisions. */
function annotateLegacySteers(
  chatId: string,
  rows: MsgDbRow[],
): MsgDbRow[] {
  if (rows.length === 0) return rows;
  const turns = openZerosDb()
    .prepare(
      `SELECT t.turn_id, t.started_at, t.ended_at, opening.ord AS opening_ord
       FROM turns t
       JOIN chat_messages opening
         ON opening.chat_id = t.chat_id AND opening.msg_id = t.turn_id
       WHERE t.chat_id = ?
       ORDER BY opening.ord ASC`,
    )
    .all(chatId) as TurnOwnerDbRow[];
  if (turns.length === 0) return rows;
  const openingIds = new Set(turns.map((turn) => turn.turn_id));

  return rows.map((row) => {
    if (row.kind !== "text" || openingIds.has(row.msg_id)) return row;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return row;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return row;
    }
    if (payload.role !== "user" || typeof payload.steeredTurnId === "string") {
      return row;
    }

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const owner = turns[index];
      if (
        row.ord > owner.opening_ord &&
        row.created_at >= owner.started_at &&
        (owner.ended_at == null || row.created_at <= owner.ended_at)
      ) {
        return {
          ...row,
          payload: JSON.stringify({
            ...payload,
            steeredTurnId: owner.turn_id,
          }),
        };
      }
    }
    return row;
  });
}

/** The searchable text for a message (Phase 3 FTS): a text message's `text`,
 *  else a tool's `title`, else "". Kept in the `content` column + FTS index. */
function extractContent(payload: string): string {
  try {
    const o = JSON.parse(payload) as { text?: unknown; title?: unknown };
    if (typeof o.text === "string") return o.text;
    if (typeof o.title === "string") return o.title;
    return "";
  } catch {
    return "";
  }
}

/** Upsert one message by (chat_id, msg_id). New messages append at MAX(ord)+1;
 *  a streaming message's later chunks update the same row (ord preserved). The
 *  `content` column (+ FTS index via triggers) tracks the searchable text.
 *
 *  `rev` is stamped from the global nextRev() on BOTH insert and update (NOT the
 *  old per-row `rev = rev + 1` counter, which was meaningless across rows), so
 *  listChatMessagesSince(since) can return exactly the messages a client missed
 *  — the message half of delta sync, mirroring chats. */
export function upsertChatMessage(chatId: string, m: PersistedMessage): void {
  if (!chatId || !m?.msgId) return;
  const db = openZerosDb();
  const content = extractContent(m.payload);
  const existing = db
    .prepare("SELECT ord FROM chat_messages WHERE chat_id = ? AND msg_id = ? LIMIT 1")
    .get(chatId, m.msgId) as { ord: number } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE chat_messages SET kind = ?, payload = ?, created_at = ?, content = ?, rev = ? WHERE chat_id = ? AND msg_id = ?",
    ).run(m.kind, m.payload, m.createdAt, content, nextRev(), chatId, m.msgId);
    return;
  }
  const maxRow = db
    .prepare("SELECT MAX(ord) AS max FROM chat_messages WHERE chat_id = ?")
    .get(chatId) as { max: number | null };
  const nextOrd = (maxRow?.max ?? 0) + 1;
  db.prepare(
    "INSERT INTO chat_messages (chat_id, msg_id, ord, kind, payload, created_at, content, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(chatId, m.msgId, nextOrd, m.kind, m.payload, m.createdAt, content, nextRev());
}

/** Bulk upsert in one transaction (the persist hook batches a turn's changed messages). */
export function upsertChatMessagesBulk(chatId: string, messages: PersistedMessage[]): void {
  if (!chatId || messages.length === 0) return;
  const db = openZerosDb();
  const tx = db.transaction((items: PersistedMessage[]) => {
    for (const m of items) upsertChatMessage(chatId, m);
  });
  tx(messages);
}

/** Ceiling on the rows one window read may return, so `windowChatMessages`
 *  cannot materialize a whole transcript into memory even when it extends a
 *  window back to a turn boundary (below). `messages.window` clamps its
 *  caller-supplied limit to the same number, and it is also the renderer's
 *  in-memory cap per chat (MAX_MESSAGES_PER_CHAT) — a window bigger than that
 *  would only be trimmed back off the front on the next streamed message. */
export const WINDOW_MAX_ROWS = 1000;

/** The `ord` of the newest TURN-OPENING user prompt in an `ord` range — i.e. the
 *  row that opened the turn the range's top belongs to. A mid-turn steer is also
 *  a user row (persisted with `steeredTurnId` by persistSteeredUserPrompt) but it
 *  opened no turn, so it is excluded: snapping to one would start the window on
 *  an interjection presented as though it were the reader's prompt, with the
 *  owning turn's opening still off-window. TURN_START_ORD_ANY_USER_SQL is the
 *  fallback when the real opening is out of budget.
 *
 *  `ORDER BY ord DESC LIMIT 1` rather than `MAX(ord)`: both get the same
 *  idx_chat_messages_chat_ord range search, but LIMIT 1 makes the early exit
 *  part of the query's meaning, so the walk provably stops at the first user row
 *  instead of depending on whether SQLite applies its min/max optimization
 *  through the json_extract term. Bounded at BOTH ends, so the reverse walk
 *  costs at most the rows the caller was already willing to read.
 *
 *  Exported as text only so db.test.ts can EXPLAIN the query that ships: it runs
 *  on every chat open, and the difference between a bounded index search and a
 *  scan of the chat is invisible in the rows returned. */
export const TURN_START_ORD_SQL = `SELECT ord FROM chat_messages
        WHERE chat_id = ? AND ord >= ? AND ord <= ?
          AND kind = 'text' AND json_extract(payload, '$.role') = 'user'
          AND json_extract(payload, '$.steeredTurnId') IS NULL
        ORDER BY ord DESC LIMIT 1`;

/** Fallback for TURN_START_ORD_SQL: the newest user row of ANY kind, steers
 *  included. A mid-turn steer is a user row that did NOT open a turn, so the
 *  durable opening is the right anchor and the query above skips steers to find
 *  it — but when that opening sits past the row budget, snapping to a steer
 *  still lands the window on a boundary the renderer splits turns on, which
 *  beats handing back a headless turn. Steers persisted by older builds carry no
 *  `steeredTurnId` (they are inferred at the read boundary, after the window),
 *  so for those this query and the one above agree — best-effort by design. */
export const TURN_START_ORD_ANY_USER_SQL = `SELECT ord FROM chat_messages
        WHERE chat_id = ? AND ord >= ? AND ord <= ?
          AND kind = 'text' AND json_extract(payload, '$.role') = 'user'
        ORDER BY ord DESC LIMIT 1`;

const WINDOW_COLUMNS =
  "SELECT msg_id, ord, kind, payload, created_at FROM chat_messages";

/** Newest-first, so the window can be extended from its older end before the
 *  caller-facing reverse. */
function newestRows(chatId: string, limit: number, before?: number): MsgDbRow[] {
  const db = openZerosDb();
  return (
    before
      ? db
          .prepare(
            `${WINDOW_COLUMNS} WHERE chat_id = ? AND ord < ? ORDER BY ord DESC LIMIT ?`,
          )
          .all(chatId, before, limit)
      : db
          .prepare(
            `${WINDOW_COLUMNS} WHERE chat_id = ? ORDER BY ord DESC LIMIT ?`,
          )
          .all(chatId, limit)
  ) as MsgDbRow[];
}

function isUserTextRow(row: MsgDbRow): boolean {
  if (row.kind !== "text") return false;
  try {
    return (JSON.parse(row.payload) as { role?: unknown }).role === "user";
  } catch {
    return false;
  }
}

/** A tail window must not begin mid-turn. `ORDER BY ord DESC LIMIT n` cuts at
 *  an arbitrary row, and one turn is easily hundreds of rows — every tool call
 *  and every reasoning block is its own row — so a tool-heavy turn pushes its
 *  own opening prompt out of the window. The renderer derives turns by
 *  splitting on user rows (turn-grouping.ts), so a window starting mid-turn
 *  renders that turn with no prompt bubble, no footer and no checkpoint, and
 *  nothing marks the cut: scrolling up looks like the top of the chat, and the
 *  reader concludes their message was lost (field report 2026-08-03, a 193-tool
 *  turn against the 200-row hydrate window).
 *
 *  The extension is CONTIGUOUS with the window it grows, so it never leaves a
 *  hole: the renderer's older-page cursor is `messages[0]`, and everything
 *  before that is still reachable by scroll-up paging.
 *
 *  Capped at WINDOW_MAX_ROWS in total, so a pathological turn degrades to the
 *  unsnapped window rather than an unbounded read — which also means a caller
 *  already asking for the ceiling gets no extension, keeping that clamp's
 *  guarantee exact. */
function snapToTurnStart(chatId: string, rows: MsgDbRow[]): MsgDbRow[] {
  const oldest = rows[rows.length - 1];
  if (!oldest || isUserTextRow(oldest)) return rows;
  const budget = WINDOW_MAX_ROWS - rows.length;
  if (budget <= 0) return rows;
  // `ord` is assigned MAX+1 per chat, so ord-distance is row-distance and this
  // floor caps the lookup's reverse walk at the rows we could actually add. A
  // prompt further back than the budget is deliberately not found: it could not
  // be reached contiguously anyway. Deletes (truncateChatMessagesFrom) leave ord
  // gaps, which only makes the floor more conservative — never unbounded.
  const floor = oldest.ord - budget;
  const db = openZerosDb();
  const start = (db.prepare(TURN_START_ORD_SQL).get(chatId, floor, oldest.ord) ??
    db
      .prepare(TURN_START_ORD_ANY_USER_SQL)
      .get(chatId, floor, oldest.ord)) as { ord: number } | undefined;
  if (!start) return rows;
  const fill = db
    .prepare(
      `${WINDOW_COLUMNS} WHERE chat_id = ? AND ord >= ? AND ord < ? ORDER BY ord DESC LIMIT ?`,
    )
    .all(chatId, start.ord, oldest.ord, budget) as MsgDbRow[];
  return rows.concat(fill);
}

/** Last `limit` messages for a chat, oldest-first — extended back to the prompt
 *  that opened the turn the window landed in (see snapToTurnStart), so a tail
 *  read never hands the renderer a headless turn. `before` (an ord) paginates
 *  older history and is returned unsnapped: a page walking backwards is already
 *  anchored to rows the caller holds. Mirrors electron/db.ts windowMessages. */
export function windowChatMessages(
  chatId: string,
  limit: number,
  before?: number,
): PersistedMessage[] {
  const rows = newestRows(chatId, limit, before);
  const windowed = before ? rows : snapToTurnStart(chatId, rows);
  return annotateLegacySteers(chatId, windowed.reverse()).map((r) => ({
    msgId: r.msg_id,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

/** A page of older messages before a known message id (renderer scroll-up). */
export function windowOlderChatMessages(
  chatId: string,
  limit: number,
  beforeMsgId: string,
): PersistedMessage[] {
  const db = openZerosDb();
  const cursor = db
    .prepare("SELECT ord FROM chat_messages WHERE chat_id = ? AND msg_id = ? LIMIT 1")
    .get(chatId, beforeMsgId) as { ord: number } | undefined;
  if (!cursor) return [];
  return windowChatMessages(chatId, limit, cursor.ord);
}

/** Delete a chat's entire transcript (reset). The FTS triggers keep the index
 *  in sync. Returns the number of rows removed. */
export function clearChatMessages(chatId: string): number {
  if (!chatId) return 0;
  const db = openZerosDb();
  let changes = 0;
  const tx = db.transaction(() => {
    changes = db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId).changes;
    // A reset removes rows, leaving no `rev > since` trace — a delta puller would
    // keep showing the cleared transcript. Tombstone the chat so a pull tells the
    // client to re-window it (drop the removed messages).
    if (changes > 0) recordTombstone("msgreset", chatId);
  });
  tx();
  return changes;
}

/** Delete a message and every later one in the chat (click-to-edit). Keyed by
 *  ord so it's stable regardless of msg_id ordering. Returns rows removed. */
export function truncateChatMessagesFrom(chatId: string, fromMsgId: string): number {
  if (!chatId || !fromMsgId) return 0;
  const db = openZerosDb();
  const cursor = db
    .prepare("SELECT ord FROM chat_messages WHERE chat_id = ? AND msg_id = ? LIMIT 1")
    .get(chatId, fromMsgId) as { ord: number } | undefined;
  if (!cursor) return 0;
  let changes = 0;
  const tx = db.transaction(() => {
    changes = db
      .prepare("DELETE FROM chat_messages WHERE chat_id = ? AND ord >= ?")
      .run(chatId, cursor.ord).changes;
    // Tombstone so a delta puller re-windows this chat and drops the truncated
    // tail (click-to-edit on one device reflects on the others).
    if (changes > 0) recordTombstone("msgreset", chatId);
  });
  tx();
  return changes;
}

/** A persisted message WITH its `ord` — for the reset-undo capture, which must
 *  re-insert rows at their EXACT original positions. */
export interface PersistedMessageRow extends PersistedMessage {
  ord: number;
}

/** The rows truncateChatMessagesFrom WOULD delete (ord ≥ the cut), oldest-first,
 *  plus the cut ord — captured just before a reset so undo can re-insert them.
 *  null when the cut message id isn't present. */
export function getChatMessagesFrom(
  chatId: string,
  fromMsgId: string,
): { cutOrd: number; rows: PersistedMessageRow[] } | null {
  if (!chatId || !fromMsgId) return null;
  const db = openZerosDb();
  const cursor = db
    .prepare("SELECT ord FROM chat_messages WHERE chat_id = ? AND msg_id = ? LIMIT 1")
    .get(chatId, fromMsgId) as { ord: number } | undefined;
  if (!cursor) return null;
  const rows = db
    .prepare(
      "SELECT msg_id, ord, kind, payload, created_at FROM chat_messages WHERE chat_id = ? AND ord >= ? ORDER BY ord ASC",
    )
    .all(chatId, cursor.ord) as (MsgDbRow & { ord: number })[];
  return {
    cutOrd: cursor.ord,
    rows: rows.map((r) => ({
      msgId: r.msg_id,
      ord: r.ord,
      kind: r.kind,
      payload: r.payload,
      createdAt: r.created_at,
    })),
  };
}

/** The highest `ord` in a chat (0 when empty) — the reset-undo guard reads this
 *  to confirm the truncated tail is still free before re-inserting at exact ords. */
export function maxChatMessageOrd(chatId: string): number {
  if (!chatId) return 0;
  const row = openZerosDb()
    .prepare("SELECT MAX(ord) AS max FROM chat_messages WHERE chat_id = ?")
    .get(chatId) as { max: number | null };
  return row?.max ?? 0;
}

/** Re-insert captured messages at their ORIGINAL ords (reset undo). Bumps `rev`
 *  from the global counter so the re-add out-revs the truncate's tombstone and a
 *  delta puller re-windows the restored tail rather than re-dropping it. Caller
 *  must have verified the ord range is free (maxChatMessageOrd < cutOrd). */
export function reinsertChatMessages(
  chatId: string,
  rows: PersistedMessageRow[],
): void {
  if (!chatId || rows.length === 0) return;
  const db = openZerosDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO chat_messages (chat_id, msg_id, ord, kind, payload, created_at, content, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const tx = db.transaction((items: PersistedMessageRow[]) => {
    for (const m of items) {
      stmt.run(
        chatId,
        m.msgId,
        m.ord,
        m.kind,
        m.payload,
        m.createdAt,
        extractContent(m.payload),
        nextRev(),
      );
    }
  });
  tx(rows);
}

export interface MessageSearchHit {
  chatId: string;
  msgId: string;
  payload: string;
  createdAt: number;
}

/** Phase 3 — full-text search over transcripts (FTS5). Each whitespace token is
 *  quoted (so `relay-core` etc. are literal, not FTS operators) and AND-ed;
 *  results are relevance-ranked.
 *
 *  H10: `scope` restricts the search to a single chat (`chatId`) or workspace
 *  folder (`folder`). The relay handler REQUIRES a scope for remote callers and
 *  passes it here — previously the scope was checked-then-discarded, so a remote
 *  client got an UNFILTERED match across every chat on the host. */
export function searchMessages(
  query: string,
  limit = 50,
  scope?: { chatId?: string; folder?: string },
): MessageSearchHit[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (tokens.length === 0) return [];
  const match = tokens.join(" ");
  const db = openZerosDb();
  const params: unknown[] = [match];
  const byFolder = !scope?.chatId && !!scope?.folder;
  let sql =
    `SELECT m.chat_id AS chatId, m.msg_id AS msgId, m.payload AS payload, m.created_at AS createdAt
       FROM chat_messages_fts f
       JOIN chat_messages m ON m.rowid = f.rowid` +
    (byFolder ? ` JOIN chats c ON c.id = m.chat_id` : ``) +
    ` WHERE chat_messages_fts MATCH ?`;
  if (scope?.chatId) {
    sql += ` AND m.chat_id = ?`;
    params.push(scope.chatId);
  } else if (byFolder) {
    sql += ` AND c.folder = ?`;
    params.push(scope!.folder);
  }
  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as MessageSearchHit[];
}

// ── Delta sync (Phase 3) ────────────────────────────────────

/** A transcript row changed since a pull cursor — carries its owning `chatId`
 *  (and `ord`) so the puller can route + order it, plus its `rev` so a capped
 *  pull can resume from the last delivered row (H11). The message-table parallel
 *  to listChatsSince. */
export interface ChatMessageDelta extends PersistedMessage {
  chatId: string;
  ord: number;
  rev: number;
}

/** Hard cap on the rows one db.pull returns for the message half — so a single
 *  pull can't stream an unbounded transcript over the relay. When a pull hits
 *  this cap the caller MUST advance its cursor only to the last delivered rev
 *  (not the global head), or the rows past the cap are skipped forever (H11). */
export const CHAT_MESSAGE_DELTA_CAP = 2000;

/** Messages with `rev > since` across ALL chats, oldest-change first. The message
 *  half of db.pull — paired with tombstonesSince('msgreset', since) for clears/
 *  truncations. Bounded (`limit`) so one pull can't stream an unbounded transcript
 *  over the relay; a caller that hits the cap pulls again from the last row's rev. */
export function listChatMessagesSince(
  since: number,
  limit = CHAT_MESSAGE_DELTA_CAP,
): ChatMessageDelta[] {
  const rows = openZerosDb()
    .prepare(
      `SELECT chat_id, msg_id, ord, kind, payload, created_at, rev
       FROM chat_messages WHERE rev > ? ORDER BY rev LIMIT ?`,
    )
    .all(since, limit) as {
    chat_id: string;
    msg_id: string;
    ord: number;
    kind: string;
    payload: string;
    created_at: number;
    rev: number;
  }[];
  return rows.map((r) => ({
    chatId: r.chat_id,
    msgId: r.msg_id,
    ord: r.ord,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at,
    rev: r.rev,
  }));
}

/** One-time backfill: stamp a fresh global rev onto every message still at the
 *  default `rev = 0` (rows written before message-rev stamping landed), so message
 *  revs become meaningful for delta sync. Ordered by (chat_id, ord) for stable,
 *  chronological-within-chat revs. Idempotent — no rev=0 rows remain after the
 *  first pass — and cheap (skipped entirely when nothing is at rev=0). Returns the
 *  number of rows stamped. */
export function backfillChatMessageRevs(): number {
  const db = openZerosDb();
  const rows = db
    .prepare("SELECT chat_id, msg_id FROM chat_messages WHERE rev = 0 ORDER BY chat_id, ord")
    .all() as { chat_id: string; msg_id: string }[];
  if (rows.length === 0) return 0;
  const upd = db.prepare("UPDATE chat_messages SET rev = ? WHERE chat_id = ? AND msg_id = ?");
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(nextRev(), r.chat_id, r.msg_id);
  });
  tx();
  return rows.length;
}
