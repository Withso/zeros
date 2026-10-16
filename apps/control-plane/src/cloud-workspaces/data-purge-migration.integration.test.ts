import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { planMigrations, runMigrations } from "../migrate.js";
import { confirmWorkspaceDeletion, seedWorkspaceDeletionGraph } from "./deletion-test-fixtures.js";
import * as computerWorkspaceSource from "./computer-workspace-source.js";
import { loadPrePurgeComputerWorkspaceSource } from "./data-purge-legacy-source.test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const migration = "0142_cloud_workspace_data_purge.sql";
const directory = new URL("../../migrations/", import.meta.url);

suite("data-purge expansion on the populated previous schema", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });

  it("preserves old rows and writers and migrates in production without a controlled or drain approval", async () => {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());`);
    const tx = await pool.connect();
    try {
      for (const file of readdirSync(directory).filter(file => /^\d{4}_.+\.sql$/.test(file) && file < migration).sort()) {
        await tx.query("BEGIN");
        try {
          await tx.query(readFileSync(new URL(file, directory), "utf8"));
          await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [file]);
          await tx.query("COMMIT");
        } catch (error) { await tx.query("ROLLBACK"); throw error; }
      }
    } finally { tx.release(); }
    expect((await pool.query("SELECT to_regclass('cloud_computer_template_snapshots') AS relation")).rows[0].relation).toBeNull();
    // Keep admission on the actual pre-0142 reader while seeding the old
    // schema. Restore today's reader before migration and every purge check.
    const legacyReader = vi.spyOn(computerWorkspaceSource, "loadComputerWorkspaceSource")
      .mockImplementation(loadPrePurgeComputerWorkspaceSource);
    let old: Awaited<ReturnType<typeof seedWorkspaceDeletionGraph>>;
    try { old = await seedWorkspaceDeletionGraph(pool, 2); }
    finally { legacyReader.mockRestore(); }
    const retained = ["cloud_workspaces", "cloud_workspace_generations", "cloud_workspace_engine_instances",
      "cloud_workspace_generation_transitions", "cloud_workspace_runtime_transitions", "cloud_workspace_runtime_enrollments",
      "cloud_workspace_allocation_owners", "cloud_workspace_allocation_transfers", "workspace_billing_epochs", "audit_log"];
    const snapshot = async () => Object.fromEntries(await Promise.all(retained.map(async table => [table,
      (await pool.query(`SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY to_jsonb(row)::text`)).rows])));
    const before = await snapshot();
    const pendingMigrations = readdirSync(directory).filter(file => /^\d{4}_.+\.sql$/.test(file) && file >= migration).sort();
    expect(pendingMigrations[0]).toBe(migration);
    expect(await planMigrations(pool)).toEqual({ pendingMigrations, controlledApprovals: [] });
    expect(await runMigrations(pool, { env: { NODE_ENV: "production" } })).toEqual(pendingMigrations);
    expect(await snapshot()).toEqual(before);
    expect(await runMigrations(pool, { env: { NODE_ENV: "production" } })).toEqual([]);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspaces SET agent_boot_id=NULL WHERE id=$1", [old.workspaceId])))
      .rejects.toMatchObject({ code: "23514" });
    // Same INSERT/UPDATE shapes as the deployed setup, local-command and
    // runtime-transfer services: no new columns or options are supplied.
    const after = await seedWorkspaceDeletionGraph(pool);
    for (const fixture of [old, after]) {
      await confirmWorkspaceDeletion(pool, fixture);
      await new CloudWorkspaceOperationsWorker(pool, fixture.objects, { workerId: "expand-purge-fixture" }).runOnce();
      expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state)
        .toBe("succeeded");
    }
  }, 30_000);
});
