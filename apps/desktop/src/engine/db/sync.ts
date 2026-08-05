// ──────────────────────────────────────────────────────────
// Sync primitives — global revision sequence and delete tombstones
// ──────────────────────────────────────────────────────────
//
// The lower half of incremental delta sync: a single monotonic `rev` sequence
// (sync_meta) that writers stamp onto rows, so a client can pull exactly the rows
// with `rev > cursor`; and tombstones (sync_tombstones) so deletes — which leave
// no row to pull — still propagate. `nextRev` hands out the sequence with a
// single atomic UPDATE … RETURNING so correctness no longer rests on the
// single-writer-per-file assumption: if a second engine ever opens the same
// zeros.db, two UPDATE+separate-SELECT pairs could both read the same rev.
// ──────────────────────────────────────────────────────────

import { openZerosDb } from "./index";

/** Entities that leave tombstones on delete. Extend as more tables join sync.
 *  "msgreset" = a chat whose transcript was cleared/truncated (the id is the
 *  chatId); a puller re-windows that chat to drop the removed tail. */
export type TombstoneKind = "chat" | "msgreset";

/** Hand out the next global rev. A writer stamps the row's `rev` with this.
 *  Single statement (UPDATE … RETURNING) so the increment + read are atomic even
 *  if two writers race — no interleave between a separate UPDATE and SELECT. */
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

/** Record (or bump) a delete tombstone so the delete propagates on the next pull.
 *  Call inside the same transaction that removes the row. */
export function recordTombstone(kind: TombstoneKind, id: string): number {
  const db = openZerosDb();
  const rev = nextRev();
  db.prepare(
    "INSERT INTO sync_tombstones (kind, id, rev) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET rev = excluded.rev",
  ).run(kind, id, rev);
  return rev;
}

/** Drop a tombstone — call when a row of this id is (re)created, so a resurrected
 *  entity isn't deleted again by a stale tombstone on the next pull. */
export function clearTombstone(kind: TombstoneKind, id: string): void {
  openZerosDb()
    .prepare("DELETE FROM sync_tombstones WHERE kind = ? AND id = ?")
    .run(kind, id);
}

/** Tombstoned ids of a kind with rev > since (the deletes a client must apply). */
export function tombstonesSince(kind: TombstoneKind, since: number): string[] {
  const rows = openZerosDb()
    .prepare(
      "SELECT id FROM sync_tombstones WHERE kind = ? AND rev > ? ORDER BY rev",
    )
    .all(kind, since) as { id: string }[];
  return rows.map((r) => r.id);
}
