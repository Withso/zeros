// ──────────────────────────────────────────────────────────
// Zeros DB — the one engine-owned SQLite database (source of truth)
// ──────────────────────────────────────────────────────────
//
// The single source of truth for Zeros app state (repos, workspaces, chats,
// chat_messages, settings, …). The ENGINE owns it and is the ONLY writer; every
// surface reaches it through the bridge — so desktop and optional cloud clients
// see the same engine-owned state.
//
// This module owns opening and migrating that unified database.
// ──────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openSqlite } from "./sqlite";
import { zerosDbPath } from "./paths";
import { runMigrations } from "./migrations";

let db: Database.Database | null = null;
let pathOverride: string | null = null;
let runtimeHandoffSealed = false;

/** Test seam — point the DB at a tmpdir file (or ":memory:") without booting
 *  the engine. Production callers never set this. Closes any open handle so the
 *  next openZerosDb() re-opens at the new path. */
export function setZerosDbPathForTesting(p: string | null): void {
  pathOverride = p;
  runtimeHandoffSealed = false;
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
  if (runtimeHandoffSealed) throw new Error("SQLite is sealed for runtime handoff");
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

/** Only the admitted cloud handoff path calls this after draining engine work
 * and flushing the durable record. Unlike ordinary teardown, a failed close
 * cannot be treated as proof that the old engine no longer owns a writer. */
export function sealZerosDbForRuntimeHandoff(): void {
  if (runtimeHandoffSealed) return;
  if (db?.inTransaction) throw new Error("SQLite transaction blocks runtime handoff");
  db?.close();
  db = null;
  runtimeHandoffSealed = true;
}

/** Cancellation may resume only before root consumes the exact source fence.
 * Open successfully before admission is restored; retain the seal on failure. */
export function resumeZerosDbAfterRuntimeHandoff(): void {
  if (!runtimeHandoffSealed) return;
  runtimeHandoffSealed = false;
  try { openZerosDb(); }
  catch { runtimeHandoffSealed = true; throw new Error("SQLite runtime handoff could not resume"); }
}

export {
  zerosDataDir,
  zerosDbPath,
  zerosDesignWorkspacesRoot,
  zerosWorkspacesRoot,
} from "./paths";
export { latestSchemaVersion } from "./migrations";
