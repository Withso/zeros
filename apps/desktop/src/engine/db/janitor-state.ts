// Boot repair cursors stay local because examined rows may not change. Restarting from zero must be safe.

import { openZerosDb } from "./index";

/** Persisted high-water mark in turns.rev, including examined rows left unchanged. */
export const TURN_ATTRIBUTION_REPAIR_CURSOR = "turn-attribution-repair-rev";

/** An unreadable cursor restarts the repair from zero. */
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
