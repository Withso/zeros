// ──────────────────────────────────────────────────────────
// janitor_state — durable cursors for the boot janitors (v34)
// ──────────────────────────────────────────────────────────
//
// A boot repair that walks an immutable history has to remember how far it got.
// The rows it decides to leave alone are precisely the rows it does not write
// to, so the history itself can never carry that mark — without a cursor the
// repair re-reads the same backlog on every launch, forever, and pays for a
// backlog that only grows.
//
// Engine-local and machine-local: a cursor describes one process's progress
// through its own copy of the history, so these rows are deliberately not
// rev-stamped and not part of the delta-sync set. Losing the table costs a
// repeated pass, never correctness — every janitor that reads a cursor must
// still be safe to run from zero.
// ──────────────────────────────────────────────────────────

import { openZerosDb } from "./index";

/** How far the finished-turn file-attribution repair has walked, as a `turns`
 *  `rev`. See git/turn-recovery.ts. */
export const TURN_ATTRIBUTION_REPAIR_CURSOR = "turn-attribution-repair-rev";

/** The cursor for `key`, or 0 when this janitor has never run. Never throws:
 *  a janitor that cannot read its cursor restarts from the beginning, which is
 *  slower but always correct. */
export function readJanitorCursor(key: string): number {
  try {
    const row = openZerosDb()
      .prepare("SELECT value FROM janitor_state WHERE key = ? LIMIT 1")
      .get(key) as { value: string } | undefined;
    const parsed = Number(row?.value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Advance `key` to `cursor`. Monotonic by construction — a lower value is
 *  ignored so an interrupted pass can never rewind a completed one. */
export function writeJanitorCursor(key: string, cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor <= 0) return;
  try {
    openZerosDb()
      .prepare(
        `INSERT INTO janitor_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(excluded.value AS INTEGER) > CAST(janitor_state.value AS INTEGER)`,
      )
      .run(key, String(cursor));
  } catch {
    // A failed cursor write only costs a repeated pass next boot.
  }
}
