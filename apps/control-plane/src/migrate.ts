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

const CONTROLLED_DOWNTIME_MARKER = "-- zeros:requires-controlled-downtime";

/**
 * The cloud-workspace branch originally numbered its migrations 0018–0050.
 * Main independently released 0018 and 0019 before the branches merged, so
 * the cloud files moved to 0020–0052. A database that ran the branch already
 * has the same DDL under the old names; recognize those durable ledger entries
 * instead of attempting the renamed files a second time.
 *
 * Keep the range closed. Future migrations must never acquire aliases merely
 * because they share the cloud_workspace prefix.
 */
function preMergeCloudMigrationName(file: string): string | null {
  const match = /^(\d{4})(_cloud_workspace_.+\.sql)$/.exec(file);
  if (!match) return null;
  const sequence = Number(match[1]);
  if (sequence < 20 || sequence > 52) return null;
  return `${String(sequence - 2).padStart(4, "0")}${match[2]}`;
}

async function reconcileRenamedCloudMigrations(
  pool: pg.Pool,
  files: readonly string[],
  applied: Set<string>,
): Promise<void> {
  for (const file of files) {
    if (applied.has(file)) continue;
    const legacyFile = preMergeCloudMigrationName(file);
    if (!legacyFile || !applied.has(legacyFile)) continue;
    await pool.query(
      `INSERT INTO schema_migrations (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [file],
    );
    applied.add(file);
    console.log(
      `[migrate] recognized renamed migration ${legacyFile} as ${file}`,
    );
  }
}

/**
 * A marked migration is incompatible with the currently running server schema.
 * In a production-mode container it must be named explicitly before the runner
 * can execute it. This is a backstop against a Git push turning an ordinary
 * Railway rolling deployment into an unplanned production migration.
 */
export function assertMigrationApproved(
  file: string,
  sql: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env.NODE_ENV !== "production" ||
    !sql.split("\n").slice(0, 12).includes(CONTROLLED_DOWNTIME_MARKER)
  ) {
    return;
  }
  const approvals = new Set(
    (env.CONTROL_PLANE_MIGRATION_APPROVALS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!approvals.has(file)) {
    throw new Error(
      `Migration ${file} requires controlled downtime and is not approved. ` +
        `Stop the old deployment, take a database backup, then set ` +
        `CONTROL_PLANE_MIGRATION_APPROVALS=${file} for the one-time rollout.`,
    );
  }
}

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
  await reconcileRenamedCloudMigrations(pool, files, applied);
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    assertMigrationApproved(file, sql);
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
        ran.length
          ? `[migrate] done (${ran.length} applied)`
          : "[migrate] up to date",
      );
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
