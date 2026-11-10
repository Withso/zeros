// Workspace number floor — numbering that outlives a lost database
//
// zeros.db holds each owner's workspace sequence (migration 46). Recovery can
// rebuild a lost database from worktree seeds, but a seed only remembers its
// own workspace: numbers of workspaces deleted before the loss would come back.
// This small file beside the database keeps every owner's highest number, so a
// database recreated next to it continues where the old one stopped. Losing
// both is losing all Local data, and numbering starts again at 1.
//
// Best-effort by contract: a missing, unreadable or malformed floor never
// blocks opening the database or creating a workspace.

import type Database from "better-sqlite3";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const FLOOR_FILE = "workspace-number-floor.json";
const MAX_FLOOR_BYTES = 64 * 1024;
const MAX_NUMBER = 2_147_483_647;
const MAX_OWNER_CHARS = 200;

type Floor = Map<string, number>;

/** The floor beside a database file, or null for an in-memory database. */
export function workspaceNumberFloorPath(dbFile: string): string | null {
  return dbFile === ":memory:" ? null : path.join(path.dirname(dbFile), FLOOR_FILE);
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_NUMBER;
}

function readFloor(file: string): { floor: Floor; raw: string | null } {
  const floor: Floor = new Map();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { floor, raw: null };
  }
  if (raw.length > MAX_FLOOR_BYTES) return { floor, raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { floor, raw };
  }
  const owners = (parsed as { version?: unknown; owners?: unknown } | null)?.owners;
  if ((parsed as { version?: unknown } | null)?.version !== 1 || !owners || typeof owners !== "object" || Array.isArray(owners))
    return { floor, raw };
  for (const [owner, number] of Object.entries(owners as Record<string, unknown>)) {
    if (owner.length <= MAX_OWNER_CHARS && validNumber(number)) floor.set(owner, number);
  }
  return { floor, raw };
}

function readSequences(db: Database.Database): Floor {
  const rows = db
    .prepare("SELECT owner, last_number FROM workspace_number_sequences")
    .all() as { owner: string; last_number: number }[];
  return new Map(rows.map((row) => [row.owner, row.last_number]));
}

/** Raise each owner's sequence to the floor's value. */
export function restoreWorkspaceNumberFloor(db: Database.Database, dbFile: string): void {
  const file = workspaceNumberFloorPath(dbFile);
  if (!file) return;
  try {
    const { floor } = readFloor(file);
    if (floor.size === 0) return;
    const raise = db.prepare(
      `INSERT INTO workspace_number_sequences (owner, last_number) VALUES (?, ?)
       ON CONFLICT(owner) DO UPDATE SET last_number = excluded.last_number
       WHERE excluded.last_number > workspace_number_sequences.last_number`,
    );
    db.transaction(() => {
      for (const [owner, number] of floor) raise.run(owner, number);
    })();
  } catch (error) {
    console.warn(`[zeros-db] workspace number floor not restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Record every owner's current sequence, never lowering a recorded floor. */
export function persistWorkspaceNumberFloor(db: Database.Database, dbFile: string): void {
  const file = workspaceNumberFloorPath(dbFile);
  if (!file) return;
  try {
    const { floor, raw } = readFloor(file);
    for (const [owner, number] of readSequences(db)) {
      if (number > (floor.get(owner) ?? -1)) floor.set(owner, number);
    }
    const owners = Object.fromEntries([...floor].sort(([a], [b]) => a.localeCompare(b)));
    const body = `${JSON.stringify({ version: 1, owners }, null, 2)}\n`;
    if (raw === body) return;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  } catch (error) {
    console.warn(`[zeros-db] workspace number floor not saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}
