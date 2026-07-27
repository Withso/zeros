// ──────────────────────────────────────────────────────────
// reset_undo — full-fidelity "undo reset" capture (v14)
// ──────────────────────────────────────────────────────────
//
// "Reset to this point" reverts files AND truncates the transcript
// (chat_messages + turns rows). To make the undo restore the CONVERSATION too —
// the user messages, every tool call with its inputs/outputs, and the final
// answer — we stash the exact rows about to be deleted here, just before
// deleting them, keyed by a generated reset_id. Undo (service: turns.undoReset)
// restores files from `snapshot` then re-inserts these rows verbatim.
//
// Engine-local: NOT part of the delta-sync set (the re-inserted messages/turns
// carry their own bumped revs, which is what other devices pull). Pruned to the
// last few per chat — older undo windows are gone (their pre-reset snapshot ref
// is capped in lock-step by pruneResetSnapshots).
// ──────────────────────────────────────────────────────────

import { openZerosDb } from "./index";
import type { PersistedMessageRow } from "./messages";
import type { TurnDbRow } from "./turns";

export interface ResetUndoRecord {
  resetId: string;
  chatId: string;
  /** Agent cwd — where to restore files (null for a non-git chat). */
  folder: string | null;
  /** Pre-reset git snapshot OID to restore files from (null = nothing to undo). */
  snapshot: string | null;
  /** Post-reset snapshot OID — undo's 3-way merge base, so edits made after the
   *  reset are merged around instead of overwritten (null = legacy record /
   *  snapshot-less reset → blind restore). */
  postSnapshot: string | null;
  /** The authored paths the reset reverted (restored from `snapshot`). */
  resetPaths: string[];
  /** The truncate cut ord — undo only re-inserts when this range is still free
   *  (the chat wasn't continued past the reset), keeping ords exact. */
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

/** Stash a reset's deleted rows so it can be undone. Idempotent on reset_id. */
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

/** Keep only the newest `keep` undo records per chat (older windows are gone —
 *  their pre-reset snapshot ref is capped in lock-step by pruneResetSnapshots). */
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
