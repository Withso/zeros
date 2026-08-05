// ──────────────────────────────────────────────────────────
// Migrations runner — plain numbered .sql files, forward-only,
// each applied in its own transaction, recorded in schema_migrations.
// No ORM, no framework: `pg_dump` portability is a design goal.
//
// Usage:  DATABASE_URL=… pnpm migrate     (also runs at service boot)
// ──────────────────────────────────────────────────────────

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "./config.js";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await client.query("COMMIT");
      ran.push(file);
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(
        `Migration ${file} failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      client.release();
    }
  }
  return ran;
}

// CLI entrypoint: `pnpm migrate`
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  runMigrations(pool)
    .then((ran) => {
      console.log(
        ran.length ? `[migrate] done (${ran.length} applied)` : "[migrate] up to date",
      );
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
