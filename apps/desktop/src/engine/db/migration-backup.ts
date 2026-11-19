// Local migrations are forward-only; this recovery copy is best effort and must not block launch.

import type Database from "better-sqlite3";
import { chmodSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const KEEP = 2;

function appliedVersion(db: Database.Database): number {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!table) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

const backupName = (file: string) => new RegExp(`^${path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.pre-migration-v[0-9]+-[0-9TZ]+\\.bak$`);

/** Oldest first so retention removes the oldest copies. */
export function migrationBackups(file: string): string[] {
  const pattern = backupName(file), dir = path.dirname(file);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const stamp = (name: string) => name.slice(name.lastIndexOf("-") + 1);
  return names.filter(name => pattern.test(name)).sort((a, b) => stamp(a).localeCompare(stamp(b))).map(name => path.join(dir, name));
}

export function backupBeforeMigrations(db: Database.Database, file: string, latest: number, now = () => new Date()): string | null {
  if (file === ":memory:") return null;
  try {
    const applied = appliedVersion(db);
    if (applied === 0 || applied >= latest) return null;
    const stamp = now().toISOString().replace(/[-:.]/g, "");
    const target = `${file}.pre-migration-v${applied}-${stamp}.bak`;
    // VACUUM INTO writes a consistent single-file copy, WAL contents included.
    db.prepare("VACUUM INTO ?").run(target);
    chmodSync(target, 0o600);
    for (const old of migrationBackups(file).slice(0, -KEEP)) rmSync(old, { force: true });
    return target;
  } catch (error) {
    console.warn(`[zeros-db] copy before migrations skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
