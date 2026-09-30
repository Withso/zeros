// Vitest global setup: migrate TEST_DATABASE_URL once per run and hand every
// test file the baseline that resetMigratedTestDatabase() restores. Without a
// database URL the DB-backed suites skip, so there is nothing to prepare.
import pg from "pg";
import type { TestProject } from "vitest/node";
import { rebuildMigratedTestDatabase } from "./test-database.js";

export default async function setup(project: TestProject): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) return;
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    project.provide(
      "migratedTestDatabaseBaseline",
      await rebuildMigratedTestDatabase(pool),
    );
  } finally {
    await pool.end();
  }
}
