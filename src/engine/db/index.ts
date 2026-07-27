// ──────────────────────────────────────────────────────────
// Zeros DB — the one engine-owned SQLite database (source of truth)
// ──────────────────────────────────────────────────────────
//
// The single source of truth for Zeros app state (repos, workspaces, chats,
// chat_messages, settings, …). The ENGINE owns it and is the ONLY writer; every
// surface reaches it through the bridge — so desktop and optional cloud clients
// see the same engine-owned state.
//
// Open + migrate the unified DB here. Architecture notes:
// docs/workspace-state-and-performance.md
// ──────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openSqlite } from "./sqlite";
import { zerosDbPath } from "./paths";
import { runMigrations } from "./migrations";

let db: Database.Database | null = null;
let pathOverride: string | null = null;

/** Test seam — point the DB at a tmpdir file (or ":memory:") without booting
 *  the engine. Production callers never set this. Closes any open handle so the
 *  next openZerosDb() re-opens at the new path. */
export function setZerosDbPathForTesting(p: string | null): void {
  pathOverride = p;
  if (db) {
    try {
      db.close();
    } catch {
      /* best effort */
    }
    db = null;
  }
}

/** Open (once) the unified Zeros DB, applying pending migrations. Singleton. */
export function openZerosDb(): Database.Database {
  if (db) return db;
  const file = pathOverride ?? zerosDbPath();
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const handle = openSqlite(file);
  // WAL so the engine (single writer) and many readers coexist; NORMAL trades a
  // tiny crash window for big write speedups; busy_timeout absorbs brief
  // contention; foreign_keys for referential integrity.
  handle.pragma("journal_mode = WAL");
  handle.pragma("synchronous = NORMAL");
  handle.pragma("foreign_keys = ON");
  handle.pragma("busy_timeout = 5000");
  runMigrations(handle);
  db = handle;
  return handle;
}

/** Close on engine shutdown. Best-effort. */
export function closeZerosDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* best effort */
    }
    db = null;
  }
}

export { zerosDataDir, zerosDbPath, zerosWorkspacesRoot } from "./paths";
export { latestSchemaVersion } from "./migrations";
