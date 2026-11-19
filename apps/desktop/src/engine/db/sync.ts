
import { openZerosDb } from "./index";

/** Persisted kinds: msgreset stores the chat ID so pullers re-window a cleared or truncated transcript. */
export type TombstoneKind = "chat" | "msgreset";

/** Keep the increment and returned revision in one statement so concurrent writers cannot receive the same revision. */
export function nextRev(): number {
  const db = openZerosDb();
  const row = db
    .prepare(
      "UPDATE sync_meta SET next_rev = next_rev + 1 WHERE id = 0 RETURNING next_rev - 1 AS rev",
    )
    .get() as { rev: number };
  return row.rev;
}

/** The highest rev handed out so far — a client's pull cursor after a full load. */
export function headRev(): number {
  const db = openZerosDb();
  const row = db
    .prepare("SELECT next_rev - 1 AS rev FROM sync_meta WHERE id = 0")
    .get() as { rev: number } | undefined;
  return row?.rev ?? 0;
}

/** Record the tombstone in the deletion transaction so a pull cannot lose the delete. */
export function recordTombstone(kind: TombstoneKind, id: string): number {
  const db = openZerosDb();
  const rev = nextRev();
  db.prepare(
    "INSERT INTO sync_tombstones (kind, id, rev) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET rev = excluded.rev",
  ).run(kind, id, rev);
  return rev;
}

/** Clear on recreation so a stale tombstone cannot delete the restored row on pull. */
export function clearTombstone(kind: TombstoneKind, id: string): void {
  openZerosDb()
    .prepare("DELETE FROM sync_tombstones WHERE kind = ? AND id = ?")
    .run(kind, id);
}

export function tombstonesSince(kind: TombstoneKind, since: number): string[] {
  const rows = openZerosDb()
    .prepare(
      "SELECT id FROM sync_tombstones WHERE kind = ? AND rev > ? ORDER BY rev",
    )
    .all(kind, since) as { id: string }[];
  return rows.map((r) => r.id);
}
