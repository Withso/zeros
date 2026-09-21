import pg from "pg";
import {afterEach, expect, it, vi} from "vitest";
import {createMigrationPool, createPool} from "./db.js";

afterEach(() => vi.unstubAllEnvs());

it("prevents ambient startup options from selecting database authority", async () => {
  vi.stubEnv("PGOPTIONS", "-c role=unreviewed_owner");
  vi.stubEnv("DATABASE_MIGRATION_ROLE", undefined);
  for (const create of [createPool, createMigrationPool]) {
    const pool = create("postgres://operator@database.test/zeros");
    try {
      // pg falls back to PGOPTIONS for an empty options string. Inspect the
      // actual driver's parsed startup parameters, not only Pool's inputs.
      const client = new pg.Client(pool.options);
      expect(client.connectionParameters.options).toBe("-c role=none");
    } finally { await pool.end(); }
  }
});

it("selects only the validated stable owner for migration connections", async () => {
  vi.stubEnv("PGOPTIONS", "-c role=unreviewed_owner");
  const pool = createMigrationPool("postgres://operator@database.test/zeros", {role:"postgres"});
  try {
    expect(new pg.Client(pool.options).connectionParameters.options).toBe("-c role=postgres");
  } finally { await pool.end(); }
});
