// ──────────────────────────────────────────────────────────
// Turns — agent request→response cycles in the unified Zeros DB (v13)
// ──────────────────────────────────────────────────────────
//
// A turn = one `prompt()` call: a user message, the agent's work (tools,
// thinking, narration) and a concluding answer, plus the set of files the agent
// itself edited. The renderer always GROUPED messages into turns at display time
// (turn-container.ts); this records the turn as a durable row so we can show a
// per-turn footer (duration + file pills), filter the Changes tab to a turn, and
// "reset to this point".
//
// `turnId` = the opening user message's msg_id — stable, unique, and already the
// key truncateChatMessagesFrom() truncates from (the transcript half of reset).
// `pre_snapshot`/`post_snapshot` are hidden snapshot-commit OIDs (see
// git/turns-git.ts); null when the chat folder isn't a git work tree. `files` is
// the AUTHORED change set from this turn's own edit/write/delete tool calls,
// NOT a whole-tree diff, so a concurrent chat's edits never leak into this turn.
// ──────────────────────────────────────────────────────────

import { openZerosDb } from "./index";
import { nextRev } from "./sync";

export type TurnFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface TurnFile {
  path: string;
  oldPath?: string;
  status: TurnFileStatus;
  additions: number;
  deletions: number;
}

export type TurnStatus = "running" | "completed" | "failed" | "cancelled";

/** One model's share of a turn's bill (the usage popover rows). */
export interface TurnModelUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** Per-turn token/cost usage, persisted as JSON on the turn row so
 *  the footer's usage popover survives reloads. Mirrors core TurnUsage
 *  (reasoningTokens deliberately never rendered — 2026-07-13 decision). */
export interface TurnUsageJson {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalCostUsd?: number;
  perModel?: TurnModelUsage[];
}

export interface TurnRow {
  chatId: string;
  turnId: string;
  /** Owning workspace (matches chats.workspace_id — the Changes-tab key). null
   *  for a chat in a plain/non-git folder. */
  workspaceId: string | null;
  /** The agent cwd this turn ran in (chats.folder). */
  folder: string | null;
  agentId: string | null;
  ord: number;
  summary: string | null;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  status: TurnStatus;
  preSnapshot: string | null;
  postSnapshot: string | null;
  files: TurnFile[];
  /** Tokens/cost for this turn (null when the agent reported none). */
  usage: TurnUsageJson | null;
}

export interface TurnDbRow {
  chat_id: string;
  turn_id: string;
  workspace_id: string | null;
  folder: string | null;
  agent_id: string | null;
  ord: number;
  summary: string | null;
  started_at: number;
  ended_at: number | null;
  stop_reason: string | null;
  status: string;
  pre_snapshot: string | null;
  post_snapshot: string | null;
  files: string | null;
  usage: string | null;
  rev: number;
}

function parseFiles(raw: string | null): TurnFile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TurnFile[]) : [];
  } catch {
    return [];
  }
}

function parseUsage(raw: string | null): TurnUsageJson | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as TurnUsageJson)
      : null;
  } catch {
    return null;
  }
}

function toTurnRow(r: TurnDbRow): TurnRow {
  return {
    chatId: r.chat_id,
    turnId: r.turn_id,
    workspaceId: r.workspace_id,
    folder: r.folder,
    agentId: r.agent_id,
    ord: r.ord,
    summary: r.summary,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    stopReason: r.stop_reason,
    status: (r.status as TurnStatus) ?? "completed",
    preSnapshot: r.pre_snapshot,
    postSnapshot: r.post_snapshot,
    files: parseFiles(r.files),
    usage: parseUsage(r.usage),
  };
}

const SELECT_COLS = `chat_id, turn_id, workspace_id, folder, agent_id, ord, summary,
  started_at, ended_at, stop_reason, status, pre_snapshot, post_snapshot, files, usage, rev`;

/** Record a turn as it STARTS (status='running'), before the agent runs. `ord`
 *  is MAX+1 within the chat so turns sort chronologically even across sessions.
 *  Idempotent on (chat_id, turn_id): a retried start updates the running row
 *  rather than duplicating it. */
export function startTurn(input: {
  chatId: string;
  turnId: string;
  workspaceId: string | null;
  folder: string | null;
  agentId: string | null;
  summary: string | null;
  startedAt: number;
  preSnapshot: string | null;
}): void {
  if (!input.chatId || !input.turnId) return;
  const db = openZerosDb();
  const existing = db
    .prepare("SELECT ord FROM turns WHERE chat_id = ? AND turn_id = ? LIMIT 1")
    .get(input.chatId, input.turnId) as { ord: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE turns SET workspace_id = ?, folder = ?, agent_id = ?, summary = ?,
        started_at = ?, status = 'running', pre_snapshot = ?, rev = ?
       WHERE chat_id = ? AND turn_id = ?`,
    ).run(
      input.workspaceId,
      input.folder,
      input.agentId,
      input.summary,
      input.startedAt,
      input.preSnapshot,
      nextRev(),
      input.chatId,
      input.turnId,
    );
    return;
  }
  const maxRow = db
    .prepare("SELECT MAX(ord) AS max FROM turns WHERE chat_id = ?")
    .get(input.chatId) as { max: number | null };
  const nextOrd = (maxRow?.max ?? 0) + 1;
  db.prepare(
    `INSERT INTO turns (chat_id, turn_id, workspace_id, folder, agent_id, ord, summary,
      started_at, status, pre_snapshot, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    input.chatId,
    input.turnId,
    input.workspaceId,
    input.folder,
    input.agentId,
    nextOrd,
    input.summary,
    input.startedAt,
    input.preSnapshot,
    nextRev(),
  );
}

/** Turn rows still marked `running` — at engine boot these are necessarily
 *  crash orphans (no prompt can be in flight yet). The boot janitor walks them
 *  to finish attribution (post snapshot + authored files from the persisted
 *  transcript) before settling them `failed`, so a crashed turn's file changes
 *  stay visible to "Reset to this point" instead of silently escaping it. */
export function listRunningTurns(): TurnRow[] {
  const rows = openZerosDb()
    .prepare(`SELECT ${SELECT_COLS} FROM turns WHERE status = 'running'`)
    .all() as TurnDbRow[];
  return rows.map(toTurnRow);
}

/** Finalize a turn when the agent's `prompt()` resolves (or fails). Sets the end
 *  time, stop reason, status, post-snapshot, and the authored file set. A no-op
 *  if the start row never landed (defensive). */
export function finishTurn(
  chatId: string,
  turnId: string,
  patch: {
    endedAt: number;
    stopReason: string | null;
    status: TurnStatus;
    postSnapshot: string | null;
    files: TurnFile[];
    /** Tokens/cost this turn billed; omitted/null when the agent
     *  reported none (the popover button then simply doesn't render). */
    usage?: TurnUsageJson | null;
  },
): void {
  if (!chatId || !turnId) return;
  const db = openZerosDb();
  db.prepare(
    `UPDATE turns SET ended_at = ?, stop_reason = ?, status = ?, post_snapshot = ?,
       files = ?, usage = ?, rev = ?
     WHERE chat_id = ? AND turn_id = ?`,
  ).run(
    patch.endedAt,
    patch.stopReason,
    patch.status,
    patch.postSnapshot,
    JSON.stringify(patch.files ?? []),
    patch.usage ? JSON.stringify(patch.usage) : null,
    nextRev(),
    chatId,
    turnId,
  );
}

export function getTurn(chatId: string, turnId: string): TurnRow | null {
  const r = openZerosDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM turns WHERE chat_id = ? AND turn_id = ? LIMIT 1`,
    )
    .get(chatId, turnId) as TurnDbRow | undefined;
  return r ? toTurnRow(r) : null;
}

/** File-changing turns for a workspace, NEWEST first (the Changes dropdown).
 *  No-op/conversational/denied turns remain in the per-chat timeline so reset
 *  can still truncate the transcript correctly, but they are not change
 *  filters and must never appear as misleading "0 files" entries here. Ordered
 *  by wall-clock start — `ord` is per-CHAT (MAX+1 within a chat) so it can't order
 *  ACROSS the chats that share a workspace; `started_at` is the cross-chat
 *  signal, with the globally-monotonic `rev` as a stable tiebreaker. */
export function listTurnsForWorkspace(
  workspaceId: string,
  limit = 200,
): TurnRow[] {
  if (!workspaceId) return [];
  const rows = openZerosDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM turns
       WHERE workspace_id = ? AND files IS NOT NULL AND files <> '[]'
       ORDER BY started_at DESC, rev DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as TurnDbRow[];
  return rows.map(toTurnRow).filter((turn) => turn.files.length > 0);
}

/** All turns for a single chat, OLDEST first (ord asc) — reset walks these. */
export function listTurnsForChat(chatId: string): TurnRow[] {
  if (!chatId) return [];
  const rows = openZerosDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM turns WHERE chat_id = ? ORDER BY ord ASC`,
    )
    .all(chatId) as TurnDbRow[];
  return rows.map(toTurnRow);
}

/** Delete a turn and every LATER turn of the same chat (ord >= the target's).
 *  This is the turns-table half of "reset to this point" — paired with
 *  truncateChatMessagesFrom for the transcript. Returns the deleted turn ids so
 *  the caller can drop their snapshot refs. */
export function deleteTurnsFrom(
  chatId: string,
  turnId: string,
): { turnIds: string[] } {
  if (!chatId || !turnId) return { turnIds: [] };
  const db = openZerosDb();
  const cursor = db
    .prepare("SELECT ord FROM turns WHERE chat_id = ? AND turn_id = ? LIMIT 1")
    .get(chatId, turnId) as { ord: number } | undefined;
  if (!cursor) return { turnIds: [] };
  const ids = db
    .prepare("SELECT turn_id FROM turns WHERE chat_id = ? AND ord >= ?")
    .all(chatId, cursor.ord) as { turn_id: string }[];
  db.prepare("DELETE FROM turns WHERE chat_id = ? AND ord >= ?").run(
    chatId,
    cursor.ord,
  );
  return { turnIds: ids.map((r) => r.turn_id) };
}

/** Delete every turn row for a chat — the turns table has no FK to chats, so a
 *  chat deletion doesn't cascade here. The chat's hidden snapshot refs are
 *  cleaned separately (git/turns-git.deleteAllChatSnapshotRefs). */
export function deleteTurnsForChat(chatId: string): void {
  if (!chatId) return;
  openZerosDb().prepare("DELETE FROM turns WHERE chat_id = ?").run(chatId);
}

/** Turn ids of this chat OUTSIDE the newest `keep`, that still carry a snapshot
 *  ref — i.e. the ones whose snapshots the retention cap should prune. Caller
 *  deletes the refs (deleteSnapshotRefs) then calls clearTurnSnapshots so the
 *  row stays (dropdown/footer still list it) but stops pointing at gc-able
 *  commits. */
export function turnsWithSnapshotsBeyond(
  chatId: string,
  keep: number,
): string[] {
  if (!chatId) return [];
  const rows = openZerosDb()
    .prepare(
      `SELECT turn_id FROM turns
       WHERE chat_id = ?
         AND (pre_snapshot IS NOT NULL OR post_snapshot IS NOT NULL)
         AND turn_id NOT IN (
           SELECT turn_id FROM turns
           WHERE chat_id = ?
             AND (pre_snapshot IS NOT NULL OR post_snapshot IS NOT NULL)
           ORDER BY ord DESC LIMIT ?
         )`,
    )
    .all(chatId, chatId, keep) as { turn_id: string }[];
  return rows.map((r) => r.turn_id);
}

/** Null the snapshot OIDs of turns whose refs were pruned, so the row remains
 *  for the dropdown/footer but no longer references commits that can be gc'd. */
export function clearTurnSnapshots(chatId: string, turnIds: string[]): void {
  if (!chatId || turnIds.length === 0) return;
  const db = openZerosDb();
  const stmt = db.prepare(
    `UPDATE turns SET pre_snapshot = NULL, post_snapshot = NULL, rev = ?
     WHERE chat_id = ? AND turn_id = ?`,
  );
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(nextRev(), chatId, id);
  });
  tx(turnIds);
}

/** Raw turn rows from `turnId` onward (ord ≥ its ord), oldest-first — the
 *  reset-undo capture (stashed before deleteTurnsFrom so undo can re-insert). */
export function getRawTurnsFrom(chatId: string, turnId: string): TurnDbRow[] {
  if (!chatId || !turnId) return [];
  const db = openZerosDb();
  const cursor = db
    .prepare("SELECT ord FROM turns WHERE chat_id = ? AND turn_id = ? LIMIT 1")
    .get(chatId, turnId) as { ord: number } | undefined;
  if (!cursor) return [];
  return db
    .prepare(
      `SELECT ${SELECT_COLS} FROM turns WHERE chat_id = ? AND ord >= ? ORDER BY ord ASC`,
    )
    .all(chatId, cursor.ord) as TurnDbRow[];
}

/** Re-insert captured raw turn rows verbatim at their original ords (reset undo),
 *  bumping `rev`. INSERT OR REPLACE so a partial overlap is harmless. */
export function reinsertTurns(rows: TurnDbRow[]): void {
  if (rows.length === 0) return;
  const db = openZerosDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO turns
       (chat_id, turn_id, workspace_id, folder, agent_id, ord, summary,
        started_at, ended_at, stop_reason, status, pre_snapshot, post_snapshot,
        files, usage, rev)
     VALUES
       (@chat_id, @turn_id, @workspace_id, @folder, @agent_id, @ord, @summary,
        @started_at, @ended_at, @stop_reason, @status, @pre_snapshot,
        @post_snapshot, @files, @usage, @rev)`,
  );
  const tx = db.transaction((items: TurnDbRow[]) => {
    // Default `usage` explicitly — a reset-undo record captured BEFORE
    // migration v20 has no `usage` key, and better-sqlite3 throws on a
    // missing named parameter.
    for (const r of items) {
      stmt.run({ ...r, usage: r.usage ?? null, rev: nextRev() });
    }
  });
  tx(rows);
}
