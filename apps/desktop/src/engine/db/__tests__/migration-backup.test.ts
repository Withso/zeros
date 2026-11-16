import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqlite } from "../sqlite";
import { backupBeforeMigrations, migrationBackups } from "../migration-backup";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function database(applied: number | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-migration-backup-"));
  dirs.push(dir);
  const file = path.join(dir, "zeros.db");
  const db = openSqlite(file);
  db.pragma("journal_mode = WAL");
  if (applied !== null) {
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    db.exec("CREATE TABLE chats (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO chats (id) VALUES (?)").run("chat-1");
    for (let v = 1; v <= applied; v++) db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(v, `m${v}`);
  }
  return { dir, file, db };
}

describe("local database copy before migrations", () => {
  it("copies an existing database, including WAL contents, before it is migrated", () => {
    const { dir, file, db } = database(3);
    const copy = backupBeforeMigrations(db, file, 5, () => new Date("2026-11-16T09:00:00.000Z"));
    db.close();
    expect(copy).toBe(path.join(dir, "zeros.db.pre-migration-v3-20261116T090000000Z.bak"));
    expect(fs.statSync(copy!).mode & 0o777).toBe(0o600);
    const restored = openSqlite(copy!, { readonly: true });
    expect(restored.prepare("SELECT id FROM chats").all()).toEqual([{ id: "chat-1" }]);
    expect(restored.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 3 });
    restored.close();
  });

  it("does nothing for a new or already current database", () => {
    const fresh = database(null), current = database(5);
    expect(backupBeforeMigrations(fresh.db, fresh.file, 5)).toBeNull();
    expect(backupBeforeMigrations(current.db, current.file, 5)).toBeNull();
    expect(migrationBackups(fresh.file)).toEqual([]);
    expect(migrationBackups(current.file)).toEqual([]);
    fresh.db.close(); current.db.close();
  });

  it("keeps only the two newest copies", () => {
    const { file, db } = database(1);
    const stamps = ["2026-11-14", "2026-11-15", "2026-11-16"].map(day => new Date(`${day}T00:00:00.000Z`));
    for (const stamp of stamps) backupBeforeMigrations(db, file, 5, () => stamp);
    db.close();
    expect(migrationBackups(file).map(p => path.basename(p))).toEqual([
      "zeros.db.pre-migration-v1-20261115T000000000Z.bak",
      "zeros.db.pre-migration-v1-20261116T000000000Z.bak",
    ]);
  });

  it("never blocks migration when the copy cannot be written", () => {
    const { file, db } = database(1);
    const now = () => new Date("2026-11-16T09:00:00.000Z");
    // VACUUM INTO refuses a non-empty target, standing in for a full or read-only disk.
    fs.writeFileSync(`${file}.pre-migration-v1-20261116T090000000Z.bak`, "occupied");
    expect(backupBeforeMigrations(db, file, 5, now)).toBeNull();
    db.close();
  });
});
