import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, "migrations");
const DIST_MIGRATOR = path.join(PACKAGE_ROOT, "dist/migrate.js");
const DIST_QUOTA_MANAGER = path.join(
  PACKAGE_ROOT,
  "dist/manage-cloud-workspace-quota.js",
);
const DIST_OBJECT_STORAGE_MANAGER = path.join(
  PACKAGE_ROOT,
  "dist/manage-cloud-workspace-object-storage.js",
);
const LADDER = readdirSync(MIGRATIONS_DIR)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();
const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

beforeAll(() => {
  execFileSync("pnpm", ["build"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
});

it("runs the compiled quota manager as the documented production entrypoint", () => {
  const result = spawnSync(process.execPath, [DIST_QUOTA_MANAGER], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "[cloud-quota] failed: DATABASE_URL is required",
  );
});

it("runs the compiled object-storage manager as the documented production entrypoint", () => {
  const result = spawnSync(process.execPath, [DIST_OBJECT_STORAGE_MANAGER], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "[cloud-object-storage] failed: DATABASE_URL is required",
  );
});

databaseDescribe("compiled production migration entrypoint", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(`
      CREATE TABLE schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const boundary = LADDER.indexOf(
      "0025_cloud_workspace_engine_authority.sql",
    );
    for (const file of LADDER.slice(0, boundary)) {
      await pool.query("BEGIN");
      try {
        await pool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
        await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }
  });

  it("executes node dist/migrate.js strictly and refuses an unapproved boundary", () => {
    const result = spawnSync(process.execPath, [DIST_MIGRATOR], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NODE_ENV: "production",
        AUTH_PROVIDER: "auth0",
        AUTH0_DOMAIN: "tenant.example.test",
        AUTH_AUDIENCE: "https://api.example.test",
        CLOUD_WORKSPACES_ENABLED: "false",
        CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "false",
        CONTROL_PLANE_MIGRATION_APPROVALS: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /0025_cloud_workspace_engine_authority\.sql.*not approved/i,
    );
  });
});
