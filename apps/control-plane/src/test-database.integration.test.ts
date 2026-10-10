// The reusable migrated database is only safe if a restore is observably the
// same as the drop-and-replay it replaces. These tests pin that equivalence on
// the real ladder, and fail if a future migration makes the schema something a
// row-level restore cannot reproduce (every reset would silently rebuild).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import {
  rebuildMigratedTestDatabase,
  resetMigratedTestDatabase,
} from "./test-database.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const TIMESTAMP = /"\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)"/g;

d("reusable migrated test database", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });

  /** Every public row and sequence position, in a stable order. Wall-clock
   *  times record when a database was migrated, not what migrating produced. */
  const snapshot = async () => {
    const { rows: relations } = await pool.query<{
      name: string;
      kind: string;
    }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name, c.relkind AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')
        ORDER BY c.relname`,
    );
    const state: Record<string, unknown> = {};
    for (const { name, kind } of relations) {
      if (kind === "S") {
        state[name] = (
          await pool.query(`SELECT last_value, is_called FROM ${name}`)
        ).rows[0];
        continue;
      }
      const { rows } = await pool.query<{ row: string }>(
        `SELECT to_json(t)::text AS row FROM ONLY ${name} t`,
      );
      state[name] = rows
        .map(({ row }) => row.replace(TIMESTAMP, '"<time>"'))
        .sort();
    }
    return state;
  };

  it("restores every migrated row and sequence without replaying the ladder", async () => {
    // Load the run's shared baseline first, so the restore below replays what
    // the global setup captured rather than what this replay produces.
    await resetMigratedTestDatabase(pool);
    const rebuilt = await rebuildMigratedTestDatabase(pool);
    // The fingerprint names objects instead of using OIDs, so a replay matches
    // the shared baseline and later files keep restoring instead of replaying.
    expect(rebuilt.schemaFingerprint).toBe(
      inject("migratedTestDatabaseBaseline")?.schemaFingerprint,
    );
    const migrated = await snapshot();
    expect(migrated["public.schema_migrations"]).not.toEqual([]);

    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query(
      "UPDATE managed_compute_provider_requirements SET require_credit = NOT require_credit",
    );
    // Append-only, owner-only evidence with a RESTRICT reference to users:
    // neither its guard trigger nor the foreign key may block the restore.
    await pool.query(
      `INSERT INTO staff_role_changes (subject_user_id, actor_user_id, next_role,
         account_revision, deployment_channel, target_fingerprint,
         database_principal, reason)
       VALUES ($1, $1, 'developer', 1, 'development', '0123456789abcdef',
         current_user, 'Reusable fixture regression')`,
      [fixture.userId],
    );
    await expect(
      pool.query("DELETE FROM staff_role_changes"),
    ).rejects.toThrow(/append-only/);
    expect(await snapshot()).not.toEqual(migrated);

    await expect(resetMigratedTestDatabase(pool)).resolves.toBe("restored");
    expect(await snapshot()).toEqual(migrated);
    await expect(resetMigratedTestDatabase(pool)).resolves.toBe("restored");
  }, 30_000);

  it("replays the ladder after any schema, privilege or trigger change", async () => {
    const changes = [
      "CREATE TABLE public.test_database_probe (id integer)",
      "GRANT SELECT ON users TO PUBLIC",
      "ALTER TABLE staff_role_changes DISABLE TRIGGER staff_role_changes_append_only",
      "CREATE FUNCTION public.test_database_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      "ALTER TABLE users ALTER COLUMN display_name SET DEFAULT 'probe'",
      "CREATE OPERATOR public.=== (LEFTARG = integer, RIGHTARG = integer, FUNCTION = int4eq)",
    ];
    for (const change of changes) {
      await expect(resetMigratedTestDatabase(pool)).resolves.toBe("restored");
      await pool.query(change);
      await expect(resetMigratedTestDatabase(pool), change).resolves.toBe(
        "rebuilt",
      );
    }
    const probe = await pool.query<{ table: string | null }>(
      "SELECT to_regclass('public.test_database_probe')::text AS table",
    );
    expect(probe.rows[0]!.table).toBeNull();
    // Each change deliberately pays for one full ladder replay.
  }, 60_000);

  it("verifies, rather than rebuilds, after data-only catalog churn", async () => {
    await expect(resetMigratedTestDatabase(pool)).resolves.toBe("restored");
    // TRUNCATE and temporary tables rewrite catalog rows without changing
    // the migrated schema, so only the cheap signature changes.
    await pool.query("TRUNCATE cloud_codex_refresh_fingerprints");
    await pool.query(
      `CREATE TEMP TABLE test_database_scratch AS SELECT ${pg.escapeLiteral(randomUUID())} AS id`,
    );
    await expect(resetMigratedTestDatabase(pool)).resolves.toBe("restored");
  });
});
