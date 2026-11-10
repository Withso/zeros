// Workspace numbers — `w-<n>`, permanent within each owner
//
// Each owner (an organization id, '' for Local) has one sequence in zeros.db
// (migration 46). Numbers only move forward: deleting, archiving or failing to
// create a workspace never returns its number. Creation announces `w-<n>`
// before the row exists (prepare names the branch and folder from it), so the
// number is reserved first and the row consumes that reservation when it is
// inserted. Rows written without a number are numbered by the database.

import type Database from "better-sqlite3";
import { openZerosDb, zerosDbFile } from "./database";
import { persistWorkspaceNumberFloor } from "./workspace-number-floor";

/** An abandoned prepare stops holding its number after this; the number
 * itself is never handed out again. */
export const WORKSPACE_NUMBER_RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The sequence a workspace is numbered in: its organization, '' for Local. */
export function workspaceNumberOwner(organizationId: string | null | undefined): string {
  return organizationId?.trim() || "";
}

function nextNumber(db: Database.Database, owner: string): number {
  db.prepare("INSERT OR IGNORE INTO workspace_number_sequences (owner, last_number) VALUES (?, 0)").run(owner);
  db.prepare("UPDATE workspace_number_sequences SET last_number = last_number + 1 WHERE owner = ?").run(owner);
  return (
    db.prepare("SELECT last_number FROM workspace_number_sequences WHERE owner = ?").get(owner) as {
      last_number: number;
    }
  ).last_number;
}

/** Hold the next number for a workspace about to be created. Idempotent for
 * the same workspace and owner, so a retried prepare keeps its number. */
export function reserveWorkspaceNumber(
  workspaceId: string,
  organizationId: string | null | undefined,
  now = Date.now(),
): number {
  const db = openZerosDb();
  const owner = workspaceNumberOwner(organizationId);
  const number = db.transaction(() => {
    const held = db
      .prepare("SELECT owner, number FROM workspace_number_reservations WHERE workspace_id = ?")
      .get(workspaceId) as { owner: string; number: number } | undefined;
    if (held?.owner === owner) return held.number;
    db.prepare("DELETE FROM workspace_number_reservations WHERE workspace_id = ? OR reserved_at < ?").run(
      workspaceId,
      now - WORKSPACE_NUMBER_RESERVATION_TTL_MS,
    );
    const reserved = nextNumber(db, owner);
    db.prepare(
      "INSERT INTO workspace_number_reservations (workspace_id, owner, number, reserved_at) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, owner, reserved, now);
    return reserved;
  })();
  persistWorkspaceNumberFloor(db, zerosDbFile());
  return number;
}

/** The number reserved for this workspace in this owner, if any. */
export function heldWorkspaceNumber(
  db: Database.Database,
  workspaceId: string,
  organizationId: string | null | undefined,
): number | null {
  const held = db
    .prepare("SELECT number FROM workspace_number_reservations WHERE workspace_id = ? AND owner = ?")
    .get(workspaceId, workspaceNumberOwner(organizationId)) as { number: number } | undefined;
  return held?.number ?? null;
}

/** Is this number already a workspace's in this owner? */
export function workspaceNumberTaken(
  db: Database.Database,
  organizationId: string | null | undefined,
  number: number,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM workspaces WHERE coalesce(organization_id, '') = ? AND number = ?")
    .get(workspaceNumberOwner(organizationId), number);
}

/** Give each row the next numbers of its (new) owner, in their prior order.
 * Owner repair moves rows between sequences; a number belongs to one owner. */
export function renumberWorkspaces(db: Database.Database, ids: readonly string[], organizationId: string | null): void {
  const owner = workspaceNumberOwner(organizationId);
  const assign = db.prepare("UPDATE workspaces SET number = ? WHERE id = ?");
  for (const id of ids) assign.run(nextNumber(db, owner), id);
}

export function saveWorkspaceNumberFloor(): void {
  persistWorkspaceNumberFloor(openZerosDb(), zerosDbFile());
}
