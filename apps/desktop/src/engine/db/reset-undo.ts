// Undo records are local; restored messages and turns sync through their own revisions.

import { openZerosDb } from "./index";
import type { PersistedMessageRow } from "./messages";
import type { TurnDbRow } from "./turns";

export interface ResetUndoRecord {
  resetId: string;
  chatId: string;
  folder: string | null;
  snapshot: string | null;
  /** Use the post-reset tree as the merge base to preserve later edits; older records without it use blind restore. */
  postSnapshot: string | null;
  resetPaths: string[];
  /** Restore original message ords only while the truncated range is still free. */
  cutOrd: number | null;
  messages: PersistedMessageRow[];
  turns: TurnDbRow[];
  createdAt: number;
}

interface ResetUndoDbRow {
  reset_id: string;
  chat_id: string;
  folder: string | null;
  snapshot: string | null;
  post_snapshot: string | null;
  reset_paths: string | null;
  cut_ord: number | null;
  messages: string;
  turns: string;
  created_at: number;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRecord(r: ResetUndoDbRow): ResetUndoRecord {
  return {
    resetId: r.reset_id,
    chatId: r.chat_id,
    folder: r.folder,
    snapshot: r.snapshot,
    postSnapshot: r.post_snapshot,
    resetPaths: parse<string[]>(r.reset_paths, []),
    cutOrd: r.cut_ord,
    messages: parse<PersistedMessageRow[]>(r.messages, []),
    turns: parse<TurnDbRow[]>(r.turns, []),
    createdAt: r.created_at,
  };
}

export function saveResetUndo(rec: ResetUndoRecord): void {
  if (!rec.resetId || !rec.chatId) return;
  openZerosDb()
    .prepare(
      `INSERT OR REPLACE INTO reset_undo
         (reset_id, chat_id, folder, snapshot, post_snapshot, reset_paths, cut_ord, messages, turns, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.resetId,
      rec.chatId,
      rec.folder,
      rec.snapshot,
      rec.postSnapshot,
      JSON.stringify(rec.resetPaths ?? []),
      rec.cutOrd,
      JSON.stringify(rec.messages ?? []),
      JSON.stringify(rec.turns ?? []),
      rec.createdAt,
    );
}

export function getResetUndo(resetId: string): ResetUndoRecord | null {
  if (!resetId) return null;
  const r = openZerosDb()
    .prepare("SELECT * FROM reset_undo WHERE reset_id = ? LIMIT 1")
    .get(resetId) as ResetUndoDbRow | undefined;
  return r ? toRecord(r) : null;
}

export function deleteResetUndo(resetId: string): void {
  if (!resetId) return;
  openZerosDb()
    .prepare("DELETE FROM reset_undo WHERE reset_id = ?")
    .run(resetId);
}

/** Keep only the newest undo records per chat; reset snapshot refs are pruned separately. */
export function pruneResetUndo(chatId: string, keep: number): void {
  if (!chatId) return;
  openZerosDb()
    .prepare(
      `DELETE FROM reset_undo WHERE chat_id = ?
         AND reset_id NOT IN (
           SELECT reset_id FROM reset_undo WHERE chat_id = ?
           ORDER BY created_at DESC, reset_id DESC LIMIT ?
         )`,
    )
    .run(chatId, chatId, keep);
}
