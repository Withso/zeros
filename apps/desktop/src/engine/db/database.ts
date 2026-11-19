// The engine owns this database; other surfaces reach its state through the bridge.

import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openSqlite } from "./sqlite";
import { zerosDbPath } from "./paths";
import { latestSchemaVersion, runMigrations } from "./migrations";
import { backupBeforeMigrations } from "./migration-backup";
import { restoreWorkspaceNumberFloor } from "./workspace-number-floor";

let db: Database.Database | null = null;
let pathOverride: string | null = null;
let runtimeHandoffSealed = false;

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

export function openZerosDb(): Database.Database {
  if (runtimeHandoffSealed) throw new Error("SQLite is sealed for runtime handoff");
  if (db) return db;
  const file = pathOverride ?? zerosDbPath();
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const handle = openSqlite(file);
  // WAL lets readers coexist with the writer; NORMAL can lose recent commits on a power loss.
  handle.pragma("journal_mode = WAL");
  handle.pragma("synchronous = NORMAL");
  handle.pragma("foreign_keys = ON");
  handle.pragma("busy_timeout = 5000");
  backupBeforeMigrations(handle, file, latestSchemaVersion());
  runMigrations(handle);
  // A database recreated beside a surviving floor resumes its numbering.
  restoreWorkspaceNumberFloor(handle, file);
  db = handle;
  return handle;
}

export function zerosDbFile(): string {
  return pathOverride ?? zerosDbPath();
}

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

/** Call after draining work and flushing durable state. A failed close is not proof that the old engine released the writer. */
export function sealZerosDbForRuntimeHandoff(): void {
  if (runtimeHandoffSealed) return;
  if (db?.inTransaction) throw new Error("SQLite transaction blocks runtime handoff");
  db?.close();
  db = null;
  runtimeHandoffSealed = true;
}

/** Cancel only before the source fence is consumed. Reopen before restoring admission; retain the seal on failure. */
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
