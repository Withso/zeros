// ──────────────────────────────────────────────────────────
// The migration ladder, actually executed.
//
// `check:control-plane-migrations` proves the ladder is append-only, but it never
// runs a line of SQL. This file does — and it exists because migration 0006
// (a destructive, irreversible rename of every tenant table) reached review
// having never executed anywhere but a developer's laptop: CI had no Postgres,
// so the whole DB suite self-skipped.
//
// What makes this worth more than "does it apply to an empty database":
// production is never empty. `runMigrations` runs at service BOOT
// (index.ts awaits it before serve()), so a migration that throws on real data
// is not a failed deploy — it is a crash-loop with no control plane. The
// upgrade-path test below is the one that models that.
//
// Runs only when TEST_DATABASE_URL points at a THROWAWAY Postgres — every test
// drops the public schema. CI provides one (preflight.yml `control-plane` job);
// locally:
//   docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=t postgres:16
//   TEST_DATABASE_URL=postgres://postgres:t@localhost:5433/postgres pnpm test
// ──────────────────────────────────────────────────────────

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import {
  migrationChecksum,
  renamedMigrationAliasesFor,
  runMigrations,
  runServiceBootMigrations,
} from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/** Same filter + order migrate.ts uses, so the tests see the real ladder. */
const LADDER = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

function migrationSource(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
}

describe("cloud migration regression contracts", () => {
  it("places temporary schemas last in every pg_catalog/public function path", () => {
    const unsafePaths = LADDER.filter((file) => file >= "0020_").flatMap(
      (file) =>
        migrationSource(file)
          .split("\n")
          .map((line, index) => ({ file, line: index + 1, sql: line.trim() }))
          .filter(
            ({ sql }) =>
              /^SET search_path\s*=\s*pg_catalog\s*,\s*public\b/iu.test(sql) &&
              !/^SET search_path\s*=\s*pg_catalog\s*,\s*public\s*,\s*pg_temp\s*;?$/iu.test(
                sql,
              ),
          ),
    );

    expect(unsafePaths).toEqual([]);
  });

  it("case-folds both sides of the legacy repository identity backfill", () => {
    const sql = migrationSource(
      "0026_cloud_workspace_identity_and_entitlements.sql",
    );
    expect(sql).toContain(
      "lower(repository.owner_name) = lower(cw.repository_owner)",
    );
    expect(sql).toContain(
      "lower(repository.repository_name) = lower(cw.repository_name)",
    );
  });

  it("suspends the append-only trigger only around the usage backfill", () => {
    const sql = migrationSource(
      "0029_cloud_workspace_production_operations.sql",
    );
    const disabled = sql.indexOf(
      "DISABLE TRIGGER cloud_workspace_usage_append_only",
    );
    const backfill = sql.indexOf("UPDATE cloud_workspace_usage_events usage");
    const enabled = sql.indexOf(
      "ENABLE TRIGGER cloud_workspace_usage_append_only",
    );
    expect(disabled).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(disabled);
    expect(enabled).toBeGreaterThan(backfill);
  });

  it("keeps recovery grants bound to a mutable setup run without foreign-keying its fence", () => {
    const sql = migrationSource(
      "0030_cloud_workspace_recovery_and_replica_authority.sql",
    );
    const foreignKey = sql.match(
      /FOREIGN KEY \(\s*setup_run_id[\s\S]*?\)\s+REFERENCES cloud_workspace_setup_runs\([\s\S]*?\) ON DELETE CASCADE/,
    )?.[0];
    expect(foreignKey).toBeDefined();
    expect(foreignKey).not.toContain("setup_execution_fence");
    expect(foreignKey).not.toContain("execution_fence");
  });

  it("revokes issuing and active tunnel grants when their device is revoked", () => {
    expect(
      migrationSource("0040_cloud_workspace_port_forward_authority.sql"),
    ).toContain("access.state IN ('issuing', 'active')");
  });

  it.each([
    [
      "0054_cloud_workspace_quota_operations.sql",
      [
        "previous_max_workspaces IS NOT NULL",
        "previous_max_running_workspaces IS NOT NULL",
        "previous_max_cpu_millicores IS NOT NULL",
        "previous_max_memory_mib IS NOT NULL",
        "previous_max_storage_mib IS NOT NULL",
      ],
    ],
    [
      "0055_cloud_workspace_object_storage_admission.sql",
      [
        "previous_organization_bytes IS NOT NULL",
        "previous_workspace_bytes IS NOT NULL",
      ],
    ],
  ] as const)("requires complete previous snapshots in %s", (file, fields) => {
    const sql = migrationSource(file);
    for (const field of fields) expect(sql).toContain(field);
  });

  it("binds durable record batches to the engine tenant and generation", () => {
    const sql = migrationSource("0028_cloud_workspace_durable_record.sql");
    expect(sql).toContain(
      "FOREIGN KEY (engine_instance_id, workspace_id, generation, org_id)",
    );
    expect(sql).toContain(
      "REFERENCES cloud_workspace_engine_instances(\n      id, workspace_id, generation, org_id\n    )",
    );
  });

  it("binds each port-forward device to the session user", () => {
    const sql = migrationSource(
      "0027_cloud_workspace_settings_providers_and_replicas.sql",
    );
    expect(sql).toContain("FOREIGN KEY (device_id, user_id)");
    expect(sql).toContain("REFERENCES devices(id, user_id) ON DELETE CASCADE");
  });

  it("lets one workspace cascade delete both sides of a lifecycle relationship", () => {
    const sql = migrationSource(
      "0023_cloud_workspace_generation_transitions.sql",
    );
    expect(sql.match(/ON DELETE NO ACTION/g)).toHaveLength(3);
    expect(sql).not.toMatch(
      /(?:drain_intent_id|provision_intent_id|generation_transition_id)[\s\S]{0,220}ON DELETE RESTRICT/,
    );
  });
});

d("migration ladder", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
  });
  afterAll(async () => {
    await pool.end();
  });

  /** A blank database. `CASCADE` also takes the RLS policies with the tables;
   *  the cluster-wide `zeros_app` role survives, which 0004 tolerates. */
  const reset = () =>
    pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

  /** Apply the first `count` migrations exactly the way migrate.ts does —
   *  including recording them — so a later runMigrations() picks up cleanly
   *  from that point instead of re-running what's already there. This is how
   *  we reconstruct "a database at yesterday's revision". */
  const applyThrough = async (count: number) => {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name       text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      for (const file of LADDER.slice(0, count)) {
        const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (name) VALUES ($1)",
            [file],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      client.release();
    }
  };

  const applyAndRecord = async (file: string) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migrationSource(file));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const seedLegacyCloudTenant = async (input: {
    userId: string;
    organizationId: string;
    teamId: string;
    workspaces: Array<{
      id: string;
      repositoryOwner: string;
      repositoryName: string;
      generations?: number;
    }>;
  }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
        input.userId,
        `${input.userId}@example.test`,
      ]);
      await client.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Migration Regression', $3, false, true)`,
        [
          input.organizationId,
          `migration-${input.organizationId}`,
          input.userId,
        ],
      );
      await client.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [input.organizationId, input.userId],
      );
      await client.query(
        `INSERT INTO teams (
           id, org_id, slug, name, is_default, created_by
         ) VALUES ($1, $2, 'default', 'Default', true, $3)`,
        [input.teamId, input.organizationId, input.userId],
      );
      await client.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [input.teamId, input.organizationId, input.userId],
      );
      for (const workspace of input.workspaces) {
        await client.query(
          `INSERT INTO cloud_workspaces (
             id, org_id, team_id, created_by, display_name,
             repository_forge, repository_owner, repository_name,
             repository_revision, status, desired_state
           ) VALUES ($1, $2, $3, $4, 'Migration Regression', 'github.com',
                     $5, $6, 'main', 'requested', 'running')`,
          [
            workspace.id,
            input.organizationId,
            input.teamId,
            input.userId,
            workspace.repositoryOwner,
            workspace.repositoryName,
          ],
        );
        await client.query(
          `INSERT INTO cloud_workspace_generations (
             workspace_id, generation, org_id, provider, image_ref,
             architecture, cpu_millicores, memory_mib, storage_mib, created_by
           )
           SELECT $1, generation, $2, 'daytona', 'snapshot:test',
                  'linux/amd64', 2000, 4096, 20480, $3
           FROM generate_series(1, $4::integer) AS generation`,
          [
            workspace.id,
            input.organizationId,
            input.userId,
            workspace.generations ?? 1,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const ledger = async () =>
    (
      await pool.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      )
    ).rows.map((r) => r.name);

  beforeEach(reset);

  it("applies cleanly to an empty database (the fresh-install path)", async () => {
    const ran = await runMigrations(pool);
    expect(ran).toEqual(LADDER);
    expect(await ledger()).toEqual(LADDER);
  });

  it("keeps temporary relations behind public in pinned function paths", async () => {
    await runMigrations(pool);

    const unsafeFunctions = await pool.query<{ name: string }>(
      `SELECT p.oid::regprocedure::text AS name
       FROM pg_proc p
       CROSS JOIN LATERAL unnest(coalesce(p.proconfig, ARRAY[]::text[])) setting
       WHERE p.pronamespace = 'public'::regnamespace
         AND setting = 'search_path=pg_catalog, public'`,
    );
    expect(unsafeFunctions.rows).toEqual([]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TEMP TABLE cloud_workspace_setup_runs (id uuid)",
      );
      await client.query("SET LOCAL search_path = pg_catalog, public, pg_temp");
      const resolved = await client.query<{ public_wins: boolean }>(
        `SELECT 'cloud_workspace_setup_runs'::regclass =
                'public.cloud_workspace_setup_runs'::regclass AS public_wins`,
      );
      expect(resolved.rows).toEqual([{ public_wins: true }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("defers the 0023 lifecycle-intent foreign-key scan to controlled 0025", async () => {
    const boundaryIndex = LADDER.indexOf(
      "0025_cloud_workspace_engine_authority.sql",
    );
    expect(boundaryIndex).toBeGreaterThan(0);
    await applyThrough(boundaryIndex);

    await expect(
      pool.query<{ validated: boolean }>(
        `SELECT convalidated AS validated
         FROM pg_constraint
         WHERE conname =
           'cloud_workspace_lifecycle_intents_transition_fkey'`,
      ),
    ).resolves.toMatchObject({ rows: [{ validated: false }] });

    await applyAndRecord(LADDER[boundaryIndex]!);
    await expect(
      pool.query<{ validated: boolean }>(
        `SELECT convalidated AS validated
         FROM pg_constraint
         WHERE conname =
           'cloud_workspace_lifecycle_intents_transition_fkey'`,
      ),
    ).resolves.toMatchObject({ rows: [{ validated: true }] });
  });

  it("upgrades case-aliased repository identities without leaving an unmatched workspace", async () => {
    const identityIndex = LADDER.indexOf(
      "0026_cloud_workspace_identity_and_entitlements.sql",
    );
    await applyThrough(identityIndex);
    await seedLegacyCloudTenant({
      userId: "11111111-1111-4111-8111-111111111101",
      organizationId: "22222222-2222-4222-8222-222222222201",
      teamId: "33333333-3333-4333-8333-333333333301",
      workspaces: [
        {
          id: "44444444-4444-4444-8444-444444444401",
          repositoryOwner: "Withso",
          repositoryName: "Zeros",
        },
        {
          id: "55555555-5555-4555-8555-555555555501",
          repositoryOwner: "wItHsO",
          repositoryName: "zErOs",
        },
      ],
    });

    await applyAndRecord(LADDER[identityIndex]!);

    await expect(
      pool.query(
        `SELECT count(*)::integer AS workspace_count,
                count(DISTINCT repository_id)::integer AS repository_count,
                count(*) FILTER (WHERE repository_id IS NULL)::integer AS unmatched
         FROM cloud_workspaces`,
      ),
    ).resolves.toMatchObject({
      rows: [{ workspace_count: 2, repository_count: 1, unmatched: 0 }],
    });
  });

  it("backfills populated append-only usage rows and restores their trigger", async () => {
    const identityIndex = LADDER.indexOf(
      "0026_cloud_workspace_identity_and_entitlements.sql",
    );
    const productionIndex = LADDER.indexOf(
      "0029_cloud_workspace_production_operations.sql",
    );
    await applyThrough(identityIndex);
    const userId = "11111111-1111-4111-8111-111111111102";
    const organizationId = "22222222-2222-4222-8222-222222222202";
    const workspaceId = "44444444-4444-4444-8444-444444444402";
    await seedLegacyCloudTenant({
      userId,
      organizationId,
      teamId: "33333333-3333-4333-8333-333333333302",
      workspaces: [
        {
          id: workspaceId,
          repositoryOwner: "withso",
          repositoryName: "zeros",
        },
      ],
    });
    for (const file of LADDER.slice(identityIndex, productionIndex)) {
      await applyAndRecord(file);
    }
    const usageId = "66666666-6666-4666-8666-666666666602";
    await pool.query(
      `INSERT INTO cloud_workspace_usage_events (
         id, org_id, workspace_id, generation, authority_epoch,
         actor_user_id, billing_owner_user_id, billing_epoch, provider,
         meter, quantity, source_idempotency_key, occurred_at
       ) VALUES ($1, $2, $3, 1, 1, $4, $4, 1, 'daytona',
                 'cpu_millisecond', 42, 'usage-before-0029', now())`,
      [usageId, organizationId, workspaceId, userId],
    );

    await applyAndRecord(LADDER[productionIndex]!);

    await expect(
      pool.query(
        `SELECT provider_connection_id IS NOT NULL AS connection_bound,
                provider_connection_version,
                octet_length(request_sha256) AS hash_bytes
         FROM cloud_workspace_usage_events WHERE id = $1`,
        [usageId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          connection_bound: true,
          provider_connection_version: "1",
          hash_bytes: 32,
        },
      ],
    });
    await expect(
      pool.query(
        `UPDATE cloud_workspace_usage_events SET quantity = 43 WHERE id = $1`,
        [usageId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("cascades a workspace whose transition and lifecycle intent reference each other", async () => {
    const transitionIndex = LADDER.indexOf(
      "0023_cloud_workspace_generation_transitions.sql",
    );
    await applyThrough(transitionIndex + 1);
    const organizationId = "22222222-2222-4222-8222-222222222203";
    const workspaceId = "44444444-4444-4444-8444-444444444403";
    await seedLegacyCloudTenant({
      userId: "11111111-1111-4111-8111-111111111103",
      organizationId,
      teamId: "33333333-3333-4333-8333-333333333303",
      workspaces: [
        {
          id: workspaceId,
          repositoryOwner: "withso",
          repositoryName: "zeros",
          generations: 2,
        },
      ],
    });
    const intentId = "66666666-6666-4666-8666-666666666603";
    const transitionId = "77777777-7777-4777-8777-777777777703";
    await pool.query(
      `INSERT INTO cloud_workspace_lifecycle_intents (
         id, workspace_id, generation, org_id, operation,
         idempotency_key, request_sha256
       ) VALUES ($1, $2, 1, $3, 'stop', 'mutual-fk-intent',
                 decode(repeat('11', 32), 'hex'))`,
      [intentId, workspaceId, organizationId],
    );
    await pool.query(
      `INSERT INTO cloud_workspace_generation_transitions (
         id, workspace_id, org_id, operation, source_generation,
         template_generation, candidate_generation, state, drain_intent_id
       ) VALUES ($1, $2, $3, 'upgrade', 1, 1, 2, 'draining', $4)`,
      [transitionId, workspaceId, organizationId, intentId],
    );
    await pool.query(
      `UPDATE cloud_workspace_lifecycle_intents
       SET generation_transition_id = $1 WHERE id = $2`,
      [transitionId, intentId],
    );

    await expect(
      pool.query(`DELETE FROM cloud_workspaces WHERE id = $1`, [workspaceId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::integer FROM cloud_workspace_lifecycle_intents) AS intents,
           (SELECT count(*)::integer FROM cloud_workspace_generation_transitions) AS transitions`,
      ),
    ).resolves.toMatchObject({ rows: [{ intents: 0, transitions: 0 }] });
  });

  it("retires workspaces after pgcrypto is relocated outside the pinned search path", async () => {
    const authorityIndex = LADDER.indexOf(
      "0025_cloud_workspace_engine_authority.sql",
    );
    await applyThrough(authorityIndex + 1);
    const organizationId = "22222222-2222-4222-8222-222222222204";
    const workspaceId = "44444444-4444-4444-8444-444444444404";
    await seedLegacyCloudTenant({
      userId: "11111111-1111-4111-8111-111111111104",
      organizationId,
      teamId: "33333333-3333-4333-8333-333333333304",
      workspaces: [
        {
          id: workspaceId,
          repositoryOwner: "withso",
          repositoryName: "zeros",
        },
      ],
    });
    await pool.query(
      "CREATE SCHEMA crypto; ALTER EXTENSION pgcrypto SET SCHEMA crypto",
    );
    try {
      await expect(
        pool.query(
          `UPDATE organizations SET deleted_at = now() WHERE id = $1`,
          [organizationId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query(
          `SELECT octet_length(request_sha256) AS hash_bytes
           FROM cloud_workspace_lifecycle_intents
           WHERE workspace_id = $1 AND operation = 'delete'`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ hash_bytes: 32 }] });
    } finally {
      await pool.query(
        "ALTER EXTENSION pgcrypto SET SCHEMA public; DROP SCHEMA crypto",
      );
    }
  });

  it("enforces the same 64 MiB file ceiling at every durable storage layer", async () => {
    await runMigrations(pool);
    const constraints = await pool.query<{
      table_name: string;
      definition: string;
    }>(
      `SELECT conrelid::regclass::text AS table_name,
              pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname IN (
         'workspace_blobs_plaintext_bytes_check',
         'workspace_blobs_ciphertext_bytes_check',
         'workspace_file_events_size_bytes_check',
         'workspace_file_entries_size_bytes_check',
         'workspace_checkpoint_entries_size_bytes_check',
         'workspace_fork_import_entries_size_bytes_check'
       )
       ORDER BY conname`,
    );
    expect(constraints.rows).toHaveLength(6);
    for (const row of constraints.rows) {
      expect(row.definition, row.table_name).toContain("67108864");
      expect(row.definition, row.table_name).not.toContain("1073741824");
    }
  });

  it("enforces file modes and bounded symlink targets in every durable projection", async () => {
    await runMigrations(pool);
    const constraints = await pool.query<{
      constraint_name: string;
      definition: string;
    }>(
      `SELECT conname AS constraint_name,
              pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname IN (
         'workspace_file_events_descriptor_check',
         'workspace_file_entries_descriptor_check',
         'workspace_checkpoint_entries_symlink_size_check',
         'workspace_fork_import_entries_symlink_size_check'
       )
       ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
      "workspace_checkpoint_entries_symlink_size_check",
      "workspace_file_entries_descriptor_check",
      "workspace_file_events_descriptor_check",
      "workspace_fork_import_entries_symlink_size_check",
    ]);
    for (const row of constraints.rows) {
      expect(row.definition, row.constraint_name).toContain("4096");
      expect(row.definition, row.constraint_name).toContain("symlink");
    }
    for (const row of constraints.rows.filter((row) =>
      row.constraint_name.includes("file_e"),
    )) {
      expect(row.definition, row.constraint_name).toContain("40960");
      expect(row.definition, row.constraint_name).toContain("33188");
      expect(row.definition, row.constraint_name).toContain("33261");
    }
  });

  it("indexes durable path pagination with database-independent byte ordering", async () => {
    await runMigrations(pool);
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'workspace_file_entries_canonical_path_idx',
         'workspace_checkpoint_entries_canonical_path_idx',
         'workspace_fork_import_entries_canonical_path_idx'
       )
       ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "workspace_checkpoint_entries_canonical_path_idx",
      "workspace_file_entries_canonical_path_idx",
      "workspace_fork_import_entries_canonical_path_idx",
    ]);
    for (const row of indexes.rows) {
      expect(row.indexdef).toContain('COLLATE "C"');
    }
  });

  it("indexes object deletion foreign keys and previously uncovered worker claims", async () => {
    await runMigrations(pool);
    const uncoveredBlobForeignKeys = await pool.query<{ conname: string }>(
      `SELECT constraint_row.conname
       FROM pg_constraint constraint_row
       WHERE constraint_row.contype = 'f'
         AND constraint_row.confrelid = 'workspace_blobs'::regclass
         AND NOT EXISTS (
           SELECT 1 FROM pg_index index_row
           WHERE index_row.indrelid = constraint_row.conrelid
             AND index_row.indisvalid AND index_row.indisready
             AND (index_row.indkey::smallint[])[0] = constraint_row.conkey[1]
         )
       ORDER BY constraint_row.conname`,
    );
    expect(uncoveredBlobForeignKeys.rows).toEqual([]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'workspace_fork_intents_result_blob_fk_idx',
         'workspace_file_events_blob_fk_idx',
         'workspace_file_entries_blob_fk_idx',
         'workspace_checkpoints_artifact_blob_fk_idx',
         'workspace_checkpoints_manifest_blob_fk_idx',
         'workspace_exports_export_blob_fk_idx',
         'workspace_setup_recovery_artifact_blob_fk_idx',
         'workspace_setup_recovery_manifest_blob_fk_idx',
         'workspace_checkpoint_entries_blob_fk_idx',
         'workspace_fork_import_entries_blob_fk_idx',
         'workspace_deletion_blob_targets_blob_fk_idx',
         'workspace_blob_storage_reservations_blob_fk_idx',
         'workspace_blob_references_workspace_fk_idx',
         'workspace_blob_rotation_jobs_claim_idx',
         'workspace_blobs_pending_gc_claim_idx'
       ) ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toHaveLength(15);
  });

  it("lets retained projections outlive compacted journals without leaving export pins", async () => {
    await runMigrations(pool);
    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND (
         (table_name = 'cloud_workspaces' AND column_name = 'data_deleted_at')
         OR (table_name = 'workspace_retention_policies'
             AND column_name = 'last_applied_at')
         OR (table_name = 'workspace_deletion_jobs'
             AND column_name = 'next_attempt_at')
         OR (table_name = 'workspace_exports' AND column_name = 'checkpoint_id')
       )
       ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toEqual([
      {
        table_name: "cloud_workspaces",
        column_name: "data_deleted_at",
        is_nullable: "YES",
      },
      {
        table_name: "workspace_deletion_jobs",
        column_name: "next_attempt_at",
        is_nullable: "NO",
      },
      {
        table_name: "workspace_exports",
        column_name: "checkpoint_id",
        is_nullable: "YES",
      },
      {
        table_name: "workspace_retention_policies",
        column_name: "last_applied_at",
        is_nullable: "YES",
      },
    ]);
    const projectionLinks = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_constraint
       WHERE conname IN (
         'workspace_record_entities_workspace_id_revision_fkey',
         'workspace_file_entries_workspace_id_revision_org_id_fkey'
       )`,
    );
    expect(projectionLinks.rows[0]).toEqual({ count: "0" });
    const defaults = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM cloud_workspaces workspace
       LEFT JOIN workspace_retention_policies policy
         ON policy.workspace_id = workspace.id AND policy.org_id = workspace.org_id
       WHERE policy.workspace_id IS NULL`,
    );
    expect(defaults.rows[0]).toEqual({ count: "0" });
  });

  it("is idempotent — a redeploy re-runs nothing", async () => {
    await runMigrations(pool);
    // Railway restarts the container on every deploy, health-check retry, and
    // crash. Each one calls runMigrations again against the same database.
    expect(await runMigrations(pool)).toEqual([]);
    expect(await runMigrations(pool)).toEqual([]);
    expect(await ledger()).toEqual(LADDER);
  });

  it("serializes concurrent startup runners across the whole ladder", async () => {
    const results = await Promise.all([
      runMigrations(pool),
      runMigrations(pool),
    ]);
    expect(results.map((ran) => ran.length).sort((a, b) => a - b)).toEqual([
      0,
      LADDER.length,
    ]);
    expect(await ledger()).toEqual(LADDER);
  });

  it("backfills checksums on an existing filename-only ledger", async () => {
    await applyThrough(3);

    await runMigrations(pool);

    const checksums = await pool.query<{
      name: string;
      checksum: string | null;
    }>("SELECT name, checksum FROM schema_migrations ORDER BY name");
    expect(checksums.rows).toEqual(
      LADDER.map((name) => ({
        name,
        checksum: migrationChecksum(
          readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
        ),
      })),
    );
  });

  it("refuses an applied migration whose durable checksum changed", async () => {
    await runMigrations(pool);
    await pool.query(
      `UPDATE schema_migrations
       SET checksum = $2
       WHERE name = $1`,
      ["0001_init.sql", `sha256:${"0".repeat(64)}`],
    );

    await expect(runMigrations(pool)).rejects.toThrow(
      /0001_init\.sql.*checksum mismatch/i,
    );
  });

  it("leaves a controlled boundary and every suffix pending at safe service boot", async () => {
    const boundary = "0025_cloud_workspace_engine_authority.sql";
    const boundaryIndex = LADDER.indexOf(boundary);
    expect(boundaryIndex).toBeGreaterThan(0);
    await applyThrough(boundaryIndex);
    await expect(
      pool.query<{ relation: string | null }>(
        `SELECT to_regclass(
           'public.workos_provider_erasure_fences'
         )::text AS relation`,
      ),
    ).resolves.toMatchObject({
      rows: [{ relation: null }],
    });

    const result = await runServiceBootMigrations(pool, {
      cloudWorkspacesEnabled: false,
      env: { NODE_ENV: "production" },
    });

    expect(result).toEqual({
      ran: [],
      status: {
        state: "controlled_migration_pending",
        migration: boundary,
        dependentRuntime: "cloud_workspaces",
      },
    });
    expect(await ledger()).toEqual(LADDER.slice(0, boundaryIndex));
    expect(
      (
        await pool.query<{ relation: string | null }>(
          "SELECT to_regclass('public.account_entitlements')::text AS relation",
        )
      ).rows[0]?.relation,
    ).toBeNull();

    const bootConfig: Config = {
      databaseUrl: url!,
      auth: {
        provider: "auth0",
        issuers: ["https://tenant.example.test/"],
        jwksUrl: "https://tenant.example.test/.well-known/jwks.json",
        audience: "https://api.example.test",
      },
      workos: null,
      inviteLinkBase: "https://app.example.test/invite",
      port: 8080,
      isProduction: true,
      deploymentChannel: "alpha",
      github: null,
      feedback: null,
      cloudWorkspaces: null,
    };
    const app = createApp(
      bootConfig,
      pool,
      { from: null, token: null, apiUrl: "", inviteLinkBase: "" },
      { migrationStatus: result.status },
    );
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      migrations: {
        state: "controlled_migration_pending",
        migration: boundary,
      },
    });
    const cloud = await app.request("/v1/devices");
    expect(cloud.status).toBe(503);
    expect(await cloud.json()).toMatchObject({
      error: { code: "controlled_migration_pending", migration: boundary },
    });
    expect((await app.request("/v1/me")).status).toBe(401);

    await expect(
      runMigrations(pool, { env: { NODE_ENV: "production" } }),
    ).rejects.toThrow(
      /0025_cloud_workspace_engine_authority\.sql.*not approved/i,
    );
    expect(await ledger()).toEqual(LADDER.slice(0, boundaryIndex));
  });

  it("refuses deferred boot when any pre-boundary cloud resource exists", async () => {
    const boundary = "0025_cloud_workspace_engine_authority.sql";
    const boundaryIndex = LADDER.indexOf(boundary);
    await applyThrough(boundaryIndex);
    await pool.query(
      `INSERT INTO cloud_workspace_provider_orphans (
         provider, provider_resource_id
       ) VALUES ('daytona', 'sandbox-left-from-an-earlier-release')`,
    );

    await expect(
      runServiceBootMigrations(pool, {
        cloudWorkspacesEnabled: false,
        env: { NODE_ENV: "production" },
      }),
    ).rejects.toThrow(
      /cannot defer.*0025_cloud_workspace_engine_authority\.sql.*cloud_workspace_provider_orphans/i,
    );
    expect(await ledger()).toEqual(LADDER.slice(0, boundaryIndex));
  });

  it("pauses safely at 0060 from a populated 0059 ledger and requires its exact approval", async () => {
    const boundary = "0060_cloud_workspace_pending_blob_deletions.sql";
    const boundaryIndex = LADDER.indexOf(boundary);
    expect(boundaryIndex).toBeGreaterThan(0);
    await applyThrough(boundaryIndex);
    await pool.query(
      `INSERT INTO cloud_workspace_provider_orphans (
         provider, provider_resource_id
       ) VALUES ('daytona', 'sandbox-retained-at-0059')`,
    );

    const result = await runServiceBootMigrations(pool, {
      cloudWorkspacesEnabled: false,
      env: {
        NODE_ENV: "production",
        CONTROL_PLANE_MIGRATION_APPROVALS: boundary,
      },
    });
    expect(result).toEqual({
      ran: [],
      status: {
        state: "controlled_migration_pending",
        migration: boundary,
        dependentRuntime: "cloud_workspaces",
      },
    });
    expect(await ledger()).toEqual(LADDER.slice(0, boundaryIndex));

    await expect(
      runMigrations(pool, { env: { NODE_ENV: "production" } }),
    ).rejects.toThrow(
      /0060_cloud_workspace_pending_blob_deletions\.sql.*not approved/i,
    );
    expect(await ledger()).toEqual(LADDER.slice(0, boundaryIndex));

    await expect(
      runMigrations(pool, {
        env: {
          NODE_ENV: "production",
          CONTROL_PLANE_MIGRATION_APPROVALS: [
            boundary,
            "0061_workos_provider_erasure_fences.sql",
          ].join(","),
        },
      }),
    ).resolves.toEqual(LADDER.slice(boundaryIndex));
    expect(await ledger()).toEqual(LADDER);
  });

  it("upgrades databases that recorded the a80ac25 0013-0018 filenames", async () => {
    const authStart = LADDER.indexOf("0013_auth_lifecycle.sql");
    expect(authStart).toBe(12);
    await applyThrough(authStart);

    const historicalPairs = [
      [
        "0020_cloud_workspace_setup_worker.sql",
        "0013_cloud_workspace_setup_worker.sql",
      ],
      [
        "0021_cloud_workspace_setup_authority.sql",
        "0014_cloud_workspace_setup_authority.sql",
      ],
      [
        "0022_cloud_workspace_setup_materials.sql",
        "0015_cloud_workspace_setup_materials.sql",
      ],
      [
        "0023_cloud_workspace_generation_transitions.sql",
        "0016_cloud_workspace_generation_transitions.sql",
      ],
      [
        "0024_cloud_workspace_client_access.sql",
        "0017_cloud_workspace_client_access.sql",
      ],
      [
        "0025_cloud_workspace_engine_authority.sql",
        "0018_cloud_workspace_engine_authority.sql",
      ],
    ] as const;
    for (const [currentFile, historicalFile] of historicalPairs) {
      expect(renamedMigrationAliasesFor(currentFile)).toContain(historicalFile);
      const sql = readFileSync(path.join(MIGRATIONS_DIR, currentFile), "utf8");
      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          historicalFile,
        ]);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }

    const ran = await runMigrations(pool);
    const alreadyAppliedCurrentNames = new Set<string>(
      historicalPairs.map(([currentFile]) => currentFile),
    );
    expect(ran).toEqual(
      LADDER.slice(authStart).filter(
        (file) => !alreadyAppliedCurrentNames.has(file),
      ),
    );
    const recorded = await ledger();
    for (const file of LADDER) expect(recorded).toContain(file);
    await expect(
      pool.query<{ relation: string | null }>(
        `SELECT to_regclass(
           'public.workos_provider_erasure_fences'
         )::text AS relation`,
      ),
    ).resolves.toMatchObject({
      rows: [{ relation: "workos_provider_erasure_fences" }],
    });
  });

  it("upgrades databases that recorded the pre-merge cloud migration filenames", async () => {
    const firstMainCollision = LADDER.indexOf("0018_deletion_lifecycle.sql");
    expect(firstMainCollision).toBeGreaterThan(0);
    await applyThrough(firstMainCollision);

    const ownerId = "abababab-abab-4bab-8bab-abababababab";
    const personalOrgId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    await pool.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, 'legacy-cloud-owner@example.test', 'Legacy Owner')`,
      [ownerId],
    );
    await pool.query(
      `INSERT INTO organizations (
         id, slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, 'legacy-personal', 'Legacy Personal', $2, true, false)`,
      [personalOrgId, ownerId],
    );

    const renamedCloudMigrations = LADDER.filter((file) => {
      const sequence = Number(file.slice(0, 4));
      return sequence >= 20 && sequence <= 52;
    });
    expect(renamedCloudMigrations).toHaveLength(33);
    for (const currentFile of renamedCloudMigrations) {
      const legacyFile = renamedMigrationAliasesFor(currentFile).at(-1);
      expect(legacyFile, currentFile).toBeDefined();
      const sql = readFileSync(path.join(MIGRATIONS_DIR, currentFile), "utf8");
      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          legacyFile!,
        ]);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }

    // The pre-merge 0024 migration removed this constraint and enabled the
    // coarse capability on Personal. Recreate those durable effects even
    // though the current 0026 file deliberately no longer does either.
    await pool.query(
      "ALTER TABLE organizations DROP CONSTRAINT personal_organizations_are_local_only",
    );
    await pool.query(
      `UPDATE organizations SET cloud_workspaces_allowed = true
       WHERE id = $1`,
      [personalOrgId],
    );

    await expect(runMigrations(pool)).resolves.toEqual([
      "0018_deletion_lifecycle.sql",
      "0019_resend_product_notifications.sql",
      "0053_cloud_workspace_personal_organization_invariant.sql",
      "0054_cloud_workspace_quota_operations.sql",
      "0055_cloud_workspace_object_storage_admission.sql",
      "0056_cloud_workspace_secret_verifiers.sql",
      "0057_cloud_workspace_storage_worker_indexes.sql",
      "0058_cloud_workspace_storage_invariants.sql",
      "0059_cloud_workspace_entitlement_activation.sql",
      "0060_cloud_workspace_pending_blob_deletions.sql",
      "0061_workos_provider_erasure_fences.sql",
      "0062_cloud_workspace_entitlement_operations.sql",
    ]);
    await expect(
      pool.query(
        `SELECT cloud_workspaces_allowed
         FROM organizations WHERE id = $1`,
        [personalOrgId],
      ),
    ).resolves.toMatchObject({
      rows: [{ cloud_workspaces_allowed: false }],
    });
    const recorded = await ledger();
    for (const file of LADDER) expect(recorded).toContain(file);
  });

  it("applies the NEWEST migration to a database at the previous revision", async () => {
    // The actual production upgrade path, and the one a fresh-install test
    // cannot see: DDL that is fine against an empty schema can still fail
    // against the schema the previous migration left behind. Generic over the
    // ladder, so it keeps testing whatever the newest migration is.
    await applyThrough(LADDER.length - 1);
    const ran = await runMigrations(pool);
    expect(ran).toEqual([LADDER[LADDER.length - 1]]);
  });

  it("adds owner-only append-only Organization entitlement activation evidence", async () => {
    await runMigrations(pool);
    await expect(
      pool.query<{ relation: string | null }>(
        `SELECT to_regclass(
           'public.cloud_workspace_entitlement_changes'
         )::text AS relation`,
      ),
    ).resolves.toMatchObject({
      rows: [{ relation: "cloud_workspace_entitlement_changes" }],
    });
    await expect(
      pool.query(
        `SELECT has_table_privilege(
           'zeros_app', 'public.cloud_workspace_entitlement_changes', 'INSERT'
         ) AS can_insert`,
      ),
    ).resolves.toMatchObject({ rows: [{ can_insert: false }] });
  });

  it("backfills provider erasure fences but keeps incomplete historical purges unresolved", async () => {
    const fenceMigration = "0061_workos_provider_erasure_fences.sql";
    const fenceMigrationIndex = LADDER.indexOf(fenceMigration);
    expect(fenceMigrationIndex).toBeGreaterThan(0);
    await applyThrough(fenceMigrationIndex);

    const evidencedRequest = "71717171-7171-4171-8171-717171717171";
    const unresolvedRequest = "72727272-7272-4272-8272-727272727272";
    await pool.query(
      `INSERT INTO deletion_requests (
         id, public_code, target_kind, target_id, state, requested_at,
         purge_after, purge_started_at, purged_at
       ) VALUES
         ($1, 'ZD-HSTF-ENCD', 'account', $1, 'purged',
          '2025-01-01T00:00:00Z', '2025-01-31T00:00:00Z',
          '2025-01-31T00:00:00Z', '2025-01-31T00:01:00Z'),
         ($2, 'ZD-HSTN-OFNC', 'organization', $2, 'purged',
          '2025-02-01T00:00:00Z', '2025-03-03T00:00:00Z',
          '2025-03-03T00:00:00Z', '2025-03-03T00:01:00Z')`,
      [evidencedRequest, unresolvedRequest],
    );
    await pool.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, action, metadata
       ) VALUES ($1, 'purge.provider_erasure_fenced', $2::jsonb)`,
      [
        evidencedRequest,
        JSON.stringify({
          provider: "workos",
          workosSubjectHashes: ["a".repeat(64)],
        }),
      ],
    );

    await expect(runMigrations(pool)).resolves.toEqual([
      fenceMigration,
      "0062_cloud_workspace_entitlement_operations.sql",
    ]);
    await expect(
      pool.query(
        `SELECT fence.provider, fence.subject_kind, fence.hash_version,
                fence.subject_hash, reconciliation.disposition
         FROM workos_provider_erasure_fences fence
         JOIN workos_provider_erasure_reconciliations reconciliation
           ON reconciliation.deletion_request_id = fence.deletion_request_id`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          provider: "workos",
          subject_kind: "user",
          hash_version: 1,
          subject_hash: "a".repeat(64),
          disposition: "fenced",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS unresolved
         FROM deletion_requests request
         WHERE request.state = 'purged'
           AND NOT EXISTS (
             SELECT 1
             FROM workos_provider_erasure_reconciliations reconciliation
             WHERE reconciliation.deletion_request_id = request.id
           )`,
      ),
    ).resolves.toMatchObject({ rows: [{ unresolved: 1 }] });
    await expect(
      pool.query(
        `UPDATE workos_provider_erasure_fences
         SET subject_hash = $1`,
        ["b".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("moves pre-fence failed rotations into conservative target cleanup", async () => {
    const fenceMigration = "0060_cloud_workspace_pending_blob_deletions.sql";
    const fenceMigrationIndex = LADDER.indexOf(fenceMigration);
    expect(fenceMigrationIndex).toBeGreaterThan(0);
    await applyThrough(fenceMigrationIndex);

    const userId = "61616161-6161-4161-8161-616161616161";
    const organizationId = "62626262-6262-4262-8262-626262626262";
    const sourceBlobId = "63636363-6363-4363-8363-636363636363";
    const publishedBlobId = "64646464-6464-4464-8464-646464646464";
    const succeededBlobId = "65656565-6565-4565-8565-656565656565";
    const deletedBlobId = "66666666-6666-4666-8666-666666666666";
    const restoredBlobId = "67676767-6767-4767-8767-676767676767";
    const sourceKey = `workspace/v2/${organizationId}/${sourceBlobId}/k1`;
    const sourceTargetKey = `workspace/v2/${organizationId}/${sourceBlobId}/k2`;
    const publishedSourceKey = `workspace/v2/${organizationId}/${publishedBlobId}/k1`;
    const publishedTargetKey = `workspace/v2/${organizationId}/${publishedBlobId}/k2`;
    const succeededSourceKey = `workspace/v2/${organizationId}/${succeededBlobId}/k1`;
    const succeededTargetKey = `workspace/v2/${organizationId}/${succeededBlobId}/k2`;
    const deletedKey = `workspace/v2/${organizationId}/${deletedBlobId}/k1`;
    await pool.query(
      `INSERT INTO users (id, email)
       VALUES ($1, 'rotation-upgrade@example.test')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO organizations (
         id, slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, 'rotation-upgrade', 'Rotation Upgrade', $2, false, true)`,
      [organizationId, userId],
    );
    await pool.query(
      `INSERT INTO workspace_blobs (
         id, org_id, plaintext_sha256, ciphertext_sha256, plaintext_bytes,
         ciphertext_bytes, object_key, encryption_key_version, nonce, auth_tag,
         state, available_at, deleted_at
       ) VALUES
       ($1, $3, decode(repeat('11', 32), 'hex'),
        decode(repeat('12', 32), 'hex'), 5, 5, $4, 1,
        decode(repeat('13', 12), 'hex'), decode(repeat('14', 16), 'hex'),
        'available', now(), NULL),
       ($2, $3, decode(repeat('21', 32), 'hex'),
        decode(repeat('22', 32), 'hex'), 7, 7, $5, 2,
        decode(repeat('23', 12), 'hex'), decode(repeat('24', 16), 'hex'),
        'available', now(), NULL),
       ($6, $3, decode(repeat('31', 32), 'hex'),
        decode(repeat('32', 32), 'hex'), 9, 9, $7, 2,
        decode(repeat('33', 12), 'hex'), decode(repeat('34', 16), 'hex'),
        'available', now(), NULL),
       ($8, $3, decode(repeat('41', 32), 'hex'),
        decode(repeat('42', 32), 'hex'), 11, 11, $9, 1,
        decode(repeat('43', 12), 'hex'), decode(repeat('44', 16), 'hex'),
        'deleted', now(), now())`,
      [
        sourceBlobId,
        publishedBlobId,
        organizationId,
        sourceKey,
        publishedTargetKey,
        succeededBlobId,
        succeededTargetKey,
        deletedBlobId,
        deletedKey,
      ],
    );
    await pool.query(
      `INSERT INTO workspace_blob_rotation_jobs (
         blob_id, org_id, target_key_version, source_object_key,
         target_object_key, state, completed_at, reserved_bytes
       ) VALUES
       ($1, $3, 2, $4, $5, 'failed', now(), 0),
       ($2, $3, 2, $6, $7, 'failed', now(), 3),
       ($8, $3, 2, $9, $10, 'succeeded', now(), 0)`,
      [
        sourceBlobId,
        publishedBlobId,
        organizationId,
        sourceKey,
        sourceTargetKey,
        publishedSourceKey,
        publishedTargetKey,
        succeededBlobId,
        succeededSourceKey,
        succeededTargetKey,
      ],
    );

    await expect(runMigrations(pool)).resolves.toEqual([
      fenceMigration,
      "0061_workos_provider_erasure_fences.sql",
      "0062_cloud_workspace_entitlement_operations.sql",
    ]);
    await expect(
      pool.query(
        `SELECT blob_id, state, reserved_bytes, completed_at
         FROM workspace_blob_rotation_jobs
         WHERE blob_id IN ($1, $2)
         ORDER BY blob_id`,
        [sourceBlobId, publishedBlobId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          blob_id: sourceBlobId,
          state: "target_cleanup_pending",
          reserved_bytes: "5",
          completed_at: null,
        },
        {
          blob_id: publishedBlobId,
          state: "target_cleanup_pending",
          reserved_bytes: "7",
          completed_at: null,
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT state, reserved_bytes FROM workspace_blob_rotation_jobs
         WHERE blob_id = $1`,
        [succeededBlobId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "succeeded", reserved_bytes: "0" }],
    });
    await expect(
      pool.query(
        `SELECT blob_id, object_key, reserved_bytes, fenced_at
         FROM workspace_blob_object_deletions
         ORDER BY blob_id, object_key`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          blob_id: succeededBlobId,
          object_key: succeededSourceKey,
          reserved_bytes: "9",
          fenced_at: null,
        },
        {
          blob_id: deletedBlobId,
          object_key: deletedKey,
          reserved_bytes: "11",
          fenced_at: null,
        },
      ],
    });
    await expect(
      pool.query(
        `INSERT INTO workspace_blobs (
           id, org_id, plaintext_sha256, plaintext_bytes, object_key,
           encryption_key_version, nonce
         ) VALUES ($1, $2, decode(repeat('41', 32), 'hex'), 11, $3, 2,
                   decode(repeat('45', 12), 'hex'))`,
        [
          restoredBlobId,
          organizationId,
          `workspace/v2/${organizationId}/${restoredBlobId}/k2`,
        ],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      pool.query(
        `INSERT INTO workspace_blobs (
           id, org_id, plaintext_sha256, plaintext_bytes, object_key,
           encryption_key_version, nonce
         ) VALUES ($1, $2, decode(repeat('41', 32), 'hex'), 11, $3, 2,
                   decode(repeat('46', 12), 'hex'))`,
        [
          "68686868-6868-4868-8868-686868686868",
          organizationId,
          `workspace/v2/${organizationId}/68686868-6868-4868-8868-686868686868/k2`,
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("removes legacy raw secret digests without invalidating encrypted rows", async () => {
    const verifierMigrationIndex = LADDER.indexOf(
      "0056_cloud_workspace_secret_verifiers.sql",
    );
    expect(verifierMigrationIndex).toBeGreaterThan(0);
    await applyThrough(verifierMigrationIndex);

    const userId = "10101010-1010-4010-8010-101010101010";
    const orgId = "20202020-2020-4020-8020-202020202020";
    const bindingId = "30303030-3030-4030-8030-303030303030";
    await pool.query("BEGIN");
    try {
      await pool.query(
        `INSERT INTO users (id, email)
         VALUES ($1, 'legacy-secret-upgrade@example.test')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'legacy-secret-upgrade', 'Legacy Secret Upgrade',
                   $2, false, true)`,
        [orgId, userId],
      );
      await pool.query(
        `INSERT INTO secret_bindings (
           id, org_id, owner_kind, name, purpose, placement, created_at
         ) VALUES ($1, $2, 'organization', 'LEGACY_TOKEN', 'environment',
                   'cloud', now())`,
        [bindingId, orgId],
      );
      await pool.query(
        `INSERT INTO secret_binding_versions (
           binding_id, org_id, version, key_version, nonce, ciphertext,
           auth_tag, value_sha256, created_by
         ) VALUES (
           $1, $2, 1, 1, decode(repeat('11', 12), 'hex'),
           decode('aabbcc', 'hex'), decode(repeat('22', 16), 'hex'),
           decode(repeat('33', 32), 'hex'), $3
         )`,
        [bindingId, orgId, userId],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    await runMigrations(pool);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'secret_binding_versions'
         AND column_name IN ('value_sha256', 'value_verifier', 'verifier_scheme')
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "value_verifier",
      "verifier_scheme",
    ]);
    await expect(
      pool.query(
        `SELECT key_version, encode(nonce, 'hex') AS nonce,
                encode(ciphertext, 'hex') AS ciphertext,
                encode(auth_tag, 'hex') AS auth_tag,
                verifier_scheme, value_verifier
         FROM secret_binding_versions WHERE binding_id = $1`,
        [bindingId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          key_version: 1,
          nonce: "111111111111111111111111",
          ciphertext: "aabbcc",
          auth_tag: "22222222222222222222222222222222",
          verifier_scheme: 0,
          value_verifier: null,
        },
      ],
    });
  });

  it("replays from every intermediate revision", async () => {
    // A deployment can be at ANY prior revision (a long-lived staging box, a
    // restored backup, a rollback). Every suffix of the ladder must apply to
    // the state its prefix leaves. This deliberately runs the full ladder once
    // per starting revision, which can exceed Vitest's default on hosted
    // Postgres even while every migration is making healthy progress.
    for (let k = 0; k < LADDER.length; k++) {
      await reset();
      await applyThrough(k);
      const ran = await runMigrations(pool);
      expect(ran, `applying from revision ${k}`).toEqual(LADDER.slice(k));
    }
    // This is O(n²) real DDL: every possible deployed prefix is upgraded through
    // the full suffix. Forty-plus migrations exceed Vitest's generic 30-second
    // unit-test ceiling on shared CI even while PostgreSQL is making progress.
    // Keep the larger budget scoped to this exhaustive compatibility matrix.
  }, 180_000);

  it("backfills immutable setup inputs and safely requeues pre-lease running work", async () => {
    const setupMigrationIndex = LADDER.findIndex((file) =>
      file.endsWith("_cloud_workspace_setup_worker.sql"),
    );
    expect(setupMigrationIndex).toBeGreaterThan(0);
    await applyThrough(setupMigrationIndex);

    const userId = "11111111-1111-4111-8111-111111111111";
    const orgId = "22222222-2222-4222-8222-222222222222";
    const teamId = "33333333-3333-4333-8333-333333333333";
    const workspaceId = "44444444-4444-4444-8444-444444444444";
    await pool.query("BEGIN");
    try {
      await pool.query(
        `INSERT INTO users (id, email) VALUES ($1, 'setup-owner@example.test')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'setup-upgrade', 'Setup Upgrade', $2, false, true)`,
        [orgId, userId],
      );
      await pool.query(
        `INSERT INTO teams (
           id, org_id, slug, name, is_default, created_by
         ) VALUES ($1, $2, 'default', 'Default', true, $3)`,
        [teamId, orgId, userId],
      );
      await pool.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Upgrade', 'github.com', 'withso',
                   'zeros', 'release/test', 'setting_up', 'running')`,
        [workspaceId, orgId, teamId, userId],
      );
      await pool.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3)`,
        [workspaceId, orgId, userId],
      );
      await pool.query(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, started_at
         ) VALUES ($1, 1, $2, 1, 'running', now())`,
        [workspaceId, orgId],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    await runMigrations(pool);
    const result = await pool.query(
      `SELECT ss.repository_forge, ss.repository_owner, ss.repository_name,
              ss.repository_revision, ss.settings_snapshot,
              ss.settings_snapshot_sha256 =
                digest(ss.settings_snapshot::text, 'sha256') AS valid_hash,
              sr.state, sr.error_code, sr.started_at, sr.claim_count,
              sr.execution_fence, sr.lease_owner, sr.lease_expires_at
       FROM cloud_workspace_setup_specs ss
       JOIN cloud_workspace_setup_runs sr
         ON sr.workspace_id = ss.workspace_id
        AND sr.generation = ss.generation
       WHERE ss.workspace_id = $1`,
      [workspaceId],
    );
    expect(result.rows[0]).toEqual({
      repository_forge: "github.com",
      repository_owner: "withso",
      repository_name: "zeros",
      repository_revision: "release/test",
      settings_snapshot: { schemaVersion: 1, values: {} },
      valid_hash: true,
      state: "queued",
      error_code: "setup_lease_upgrade_requeued",
      started_at: null,
      claim_count: 0,
      execution_fence: "0",
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it("retires setup grants that predate execution-fence authority", async () => {
    const authorityMigrationIndex = LADDER.findIndex((file) =>
      file.endsWith("_cloud_workspace_setup_authority.sql"),
    );
    expect(authorityMigrationIndex).toBeGreaterThan(0);
    await applyThrough(authorityMigrationIndex);

    const userId = "11111111-1111-4111-8111-111111111112";
    const orgId = "22222222-2222-4222-8222-222222222223";
    const teamId = "33333333-3333-4333-8333-333333333334";
    const workspaceId = "44444444-4444-4444-8444-444444444445";
    const grantId = "55555555-5555-4555-8555-555555555556";
    await pool.query("BEGIN");
    try {
      await pool.query(
        `INSERT INTO users (id, email)
         VALUES ($1, 'setup-authority-upgrade@example.test')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'setup-authority-upgrade', 'Setup Authority Upgrade',
                   $2, false, true)`,
        [orgId, userId],
      );
      await pool.query(
        `INSERT INTO teams (
           id, org_id, slug, name, is_default, created_by
         ) VALUES ($1, $2, 'default', 'Default', true, $3)`,
        [teamId, orgId, userId],
      );
      await pool.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Authority Upgrade', 'github.com',
                   'withso', 'zeros', 'main', 'setting_up', 'running')`,
        [workspaceId, orgId, teamId, userId],
      );
      await pool.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480,
                   '0123456789abcdef0123456789abcdef01234567', $3)`,
        [workspaceId, orgId, userId],
      );
      await pool.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           settings_snapshot, settings_snapshot_sha256
         ) VALUES ($1, 1, $2, 'github.com', 'withso', 'zeros', 'main',
                   '{"schemaVersion":1,"values":{}}'::jsonb,
                   digest('{"values": {}, "schemaVersion": 1}'::jsonb::text,
                          'sha256'))`,
        [workspaceId, orgId],
      );
      await pool.query(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt
         ) VALUES ($1, 1, $2, 1)`,
        [workspaceId, orgId],
      );
      await pool.query(
        `INSERT INTO cloud_workspace_endpoint_grants (
           id, workspace_id, generation, org_id, account_user_id, purpose,
           audience, token_hash, account_revision, authorization_revision,
           expires_at
         ) VALUES ($1, $2, 1, $3, $4, 'setup',
                   'https://control.example.test/', digest('legacy-token', 'sha256'), 1, 1,
                   now() + interval '5 minutes')`,
        [grantId, workspaceId, orgId, userId],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    expect(await runMigrations(pool)).toEqual(
      LADDER.slice(authorityMigrationIndex),
    );
    const retired = await pool.query(
      `SELECT revoked_at IS NOT NULL AS revoked,
              setup_run_id, setup_execution_fence
       FROM cloud_workspace_endpoint_grants
       WHERE id = $1`,
      [grantId],
    );
    expect(retired.rows[0]).toEqual({
      revoked: true,
      setup_run_id: null,
      setup_execution_fence: null,
    });
    await expect(
      pool.query(
        `UPDATE cloud_workspace_endpoint_grants
         SET revoked_at = NULL WHERE id = $1`,
        [grantId],
      ),
    ).rejects.toThrow(/setup_binding_check|check constraint/i);
  });

  it("backfills deleted-account authority in workspace-before-grant lock order", async () => {
    const engineAuthorityIndex = LADDER.findIndex((file) =>
      file.endsWith("_cloud_workspace_engine_authority.sql"),
    );
    expect(engineAuthorityIndex).toBeGreaterThan(0);
    await applyThrough(engineAuthorityIndex);

    const userId = "11111111-1111-4111-8111-111111111118";
    const orgId = "22222222-2222-4222-8222-222222222228";
    const teamId = "33333333-3333-4333-8333-333333333338";
    const workspaceId = "44444444-4444-4444-8444-444444444448";
    const grantId = "55555555-5555-4555-8555-555555555558";
    await pool.query(
      `INSERT INTO users (id, email)
       VALUES ($1, 'deleted-owner-upgrade@example.test')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO organizations (
         id, slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, 'deleted-owner-upgrade', 'Deleted Owner Upgrade',
                 $2, false, true)`,
      [orgId, userId],
    );
    await pool.query(
      `INSERT INTO teams (
         id, org_id, slug, name, is_default, created_by
       ) VALUES ($1, $2, 'default', 'Default', true, $3)`,
      [teamId, orgId, userId],
    );
    const seed = await pool.connect();
    try {
      await seed.query("BEGIN");
      await seed.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Deleted Owner Upgrade', 'github.com',
                   'withso', 'zeros', 'main', 'ready', 'running')`,
        [workspaceId, orgId, teamId, userId],
      );
      await seed.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3)`,
        [workspaceId, orgId, userId],
      );
      await seed.query(
        `INSERT INTO cloud_workspace_client_access_grants (
           id, workspace_id, generation, org_id, account_user_id, kind,
           provider_resource_id, provider_access_id, token_hash,
           idempotency_key, request_sha256, state, requested_expires_at,
           expires_at, issued_at
         ) VALUES ($1, $2, 1, $3, $4, 'ssh', 'sandbox-upgrade',
                   'provider-access-upgrade', digest('access-token', 'sha256'),
                   'upgrade-lock-order', digest('request', 'sha256'), 'active',
                   now() + interval '15 minutes',
                   now() + interval '15 minutes', now())`,
        [grantId, workspaceId, orgId, userId],
      );
      await seed.query("COMMIT");
    } catch (error) {
      await seed.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      seed.release();
    }
    await pool.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [
      userId,
    ]);

    const workspaceOwner = await pool.connect();
    let migration: ReturnType<typeof runMigrations> | null = null;
    try {
      await workspaceOwner.query("BEGIN");
      await workspaceOwner.query("SET LOCAL statement_timeout = '750ms'");
      await workspaceOwner.query(
        `SELECT 1 FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [workspaceId],
      );

      migration = runMigrations(pool);
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock'
               AND query LIKE '%0025 — Engine membership retirement%'`,
          );
          expect(waiting.rows[0]!.count).toBeGreaterThan(0);
        },
        { timeout: 2_000, interval: 20 },
      );

      // The migration must wait for workspace authority before taking schema or
      // row locks on child tables. Otherwise its engine ALTER and/or credential
      // backfill forms the inverse edge and these ordinary workspace-first
      // mutations time out or deadlock.
      await expect(
        workspaceOwner.query(
          `UPDATE cloud_workspace_engine_instances
           SET updated_at = now() WHERE workspace_id = $1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        workspaceOwner.query(
          `UPDATE cloud_workspace_client_access_grants
           SET updated_at = now() WHERE id = $1`,
          [grantId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await workspaceOwner.query("COMMIT");
      await expect(migration).resolves.toEqual(
        LADDER.slice(engineAuthorityIndex),
      );
    } finally {
      await workspaceOwner.query("ROLLBACK").catch(() => undefined);
      if (migration) await migration.catch(() => undefined);
      workspaceOwner.release();
    }

    const retired = await pool.query(
      `SELECT desired_state, status
       FROM cloud_workspaces WHERE id = $1`,
      [workspaceId],
    );
    expect(retired.rows[0]).toEqual({
      desired_state: "deleted",
      status: "deleting",
    });
  });
});

// ── Per-migration data-preservation ──────────────────────
//
// Only migrations that TRANSFORM existing rows need one of these; most just add
// a table or column and the generic tests above cover them. 0006 renames every
// tenant table, moves a foreign key, and rewrites audit_log — so it gets one.
d("0006 org→team preserves existing data", () => {
  let pool: pg.Pool;
  const TEAM = "aaaaaaaa-0000-0000-0000-000000000001";
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const MEMBER = "22222222-2222-2222-2222-222222222222";
  const SUBTEAM = "bbbbbbbb-0000-0000-0000-000000000002";

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Bring the database to the pre-rename revision (0005).
    for (const file of LADDER.filter((f) => f < "0006")) {
      await pool.query("BEGIN");
      await pool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await pool.query("COMMIT");
    }
    // Seed the org-era shape: a real org, two members, a NESTED sub-team, an
    // invitation pointing at that sub-team, settings, billing, and audit rows
    // in both the org.* and sub-team team.* namespaces.
    await pool.query(
      `INSERT INTO users (id, email) VALUES ($1,'owner@example.com'), ($2,'mate@example.com')`,
      [OWNER, MEMBER],
    );
    await pool.query(
      `INSERT INTO organizations (id, slug, name, logo, created_by)
       VALUES ($1,'acme','Acme','data:image/png;base64,iVBORw0KGgo=',$2)`,
      [TEAM, OWNER],
    );
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1,$2,'owner'), ($1,$3,'member')`,
      [TEAM, OWNER, MEMBER],
    );
    await pool.query(
      `INSERT INTO teams (id, org_id, name, is_default)
       VALUES ('bbbbbbbb-0000-0000-0000-000000000001',$1,'Personal',true), ($2,$1,'Design',false)`,
      [TEAM, SUBTEAM],
    );
    await pool.query(
      `INSERT INTO invitations (org_id, email, token_hash, invited_by, team_id)
       VALUES ($1,'new@example.com','\\x00112233'::bytea,$2,$3)`,
      [TEAM, OWNER, SUBTEAM],
    );
    await pool.query(
      `INSERT INTO org_settings (org_id, scope, doc)
       VALUES ($1,'*','{"git":{"base_branch":"main"}}'::jsonb)`,
      [TEAM],
    );
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_id, action)
       VALUES ($1,$2,'org.created'), ($1,$2,'org.renamed'),
              ($1,$2,'team.created'), ($1,$2,'member.invited')`,
      [TEAM, OWNER],
    );
    await pool.query(
      `INSERT INTO billing_customers (org_id, stripe_customer_id) VALUES ($1,'cus_123')`,
      [TEAM],
    );

    // Apply ONLY 0006. The ladder now continues by restoring the two-level
    // model in 0009; letting runMigrations apply every later file would make
    // this historical migration's assertions inspect the wrong revision.
    const file = LADDER.find((name) => name.startsWith("0006_"))!;
    await pool.query("BEGIN");
    await pool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
      file,
    ]);
    await pool.query("COMMIT");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("carries the org across as the team, identity and all", async () => {
    const { rows } = await pool.query(
      `SELECT id, slug, name, logo, created_by FROM teams`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: TEAM,
      slug: "acme",
      name: "Acme",
      created_by: OWNER,
    });
    expect(rows[0].logo).toContain("data:image/png");
  });

  it("keeps every membership and its role", async () => {
    // ORDER BY user_id, not role: `role` is the team_role ENUM, which sorts by
    // declaration order (owner, admin, member) rather than alphabetically.
    const { rows } = await pool.query(
      `SELECT user_id, role FROM team_members WHERE team_id = $1 ORDER BY user_id`,
      [TEAM],
    );
    expect(rows).toEqual([
      { user_id: OWNER, role: "owner" },
      { user_id: MEMBER, role: "member" },
    ]);
  });

  it("re-points invitations at the TENANT ROOT, not the deleted sub-team", async () => {
    // The subtle one. `invitations` had BOTH org_id and a sub-team team_id;
    // after the rename only one team_id survives and it must be the org's.
    // Getting this backwards would silently invite people into a dead row.
    const { rows } = await pool.query(`SELECT email, team_id FROM invitations`);
    expect(rows).toEqual([{ email: "new@example.com", team_id: TEAM }]);
  });

  it("separates the retired sub-team history from the tenant history", async () => {
    const { rows } = await pool.query<{ action: string; n: string }>(
      `SELECT action, count(*) n FROM audit_log GROUP BY action ORDER BY action`,
    );
    // org.created/org.renamed become team.*; the sub-team's own team.created
    // moves to subteam.* so the two never merge under one name.
    expect(rows.map((r) => r.action)).toEqual([
      "member.invited",
      "subteam.created",
      "team.created",
      "team.renamed",
    ]);
  });

  it("carries settings and billing over on the renamed key", async () => {
    const settings = await pool.query(`SELECT team_id, doc FROM team_settings`);
    expect(settings.rows[0]).toMatchObject({ team_id: TEAM });
    expect(settings.rows[0].doc).toEqual({ git: { base_branch: "main" } });
    const billing = await pool.query(`SELECT team_id FROM billing_customers`);
    expect(billing.rows[0]).toEqual({ team_id: TEAM });
  });

  it("leaves no org_* identifier anywhere in the schema", async () => {
    const { rows } = await pool.query<{ leftover: string }>(`
      SELECT 'table '  || table_name AS leftover FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%org%'
      UNION ALL
      SELECT 'column ' || table_name || '.' || column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%org%'
      UNION ALL
      SELECT 'index '  || indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname LIKE '%org%'
      UNION ALL
      SELECT 'policy ' || policyname FROM pg_policies
        WHERE schemaname = 'public' AND policyname LIKE '%org%'
      UNION ALL
      SELECT 'function ' || proname FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%org%'
    `);
    expect(rows.map((r) => r.leftover)).toEqual([]);
  });

  it("still enforces tenant isolation under the unprivileged app role", async () => {
    // The migration recreates the SECURITY DEFINER helper every policy keys
    // on. If that recreate were wrong, RLS would fail OPEN and every team
    // would see every other team's rows — silently, since nothing errors.
    const asUser = async (userId: string, sql: string) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE zeros_app");
        await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        const r = await c.query(sql);
        await c.query("COMMIT");
        return r.rows[0];
      } finally {
        c.release();
      }
    };
    const STRANGER = "99999999-9999-9999-9999-999999999999";

    expect(await asUser(OWNER, "SELECT count(*)::int n FROM teams")).toEqual({
      n: 1,
    });
    expect(await asUser(STRANGER, "SELECT count(*)::int n FROM teams")).toEqual(
      { n: 0 },
    );
    expect(
      await asUser(STRANGER, "SELECT count(*)::int n FROM team_settings"),
    ).toEqual({ n: 0 });
    expect(
      await asUser(STRANGER, "SELECT count(*)::int n FROM audit_log"),
    ).toEqual({ n: 0 });
  });
});

d("0009 organization→team hierarchy preserves flat-Team data", () => {
  let pool: pg.Pool;
  const ORG = "aaaaaaaa-0000-0000-0000-000000000001";
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const MEMBER = "22222222-2222-2222-2222-222222222222";
  const STRANGER = "33333333-3333-3333-3333-333333333333";
  const SQUAT = "aaaaaaaa-0000-0000-0000-000000000002";

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(`
      CREATE TABLE schema_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const file of LADDER.filter((name) => name < "0009")) {
      await pool.query("BEGIN");
      await pool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await pool.query("COMMIT");
    }

    await pool.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, 'owner@example.com', 'Ada'),
              ($2, 'member@example.com', NULL),
              ($3, 'stranger@example.com', 'Lin')`,
      [OWNER, MEMBER, STRANGER],
    );
    await pool.query(
      `INSERT INTO teams (id, slug, name, logo, created_by)
       VALUES ($1, 'acme', 'Acme', 'data:image/png;base64,iVBORw0KGgo=', $2),
              ($3, 'personal-33333333333333333333333333333333',
               'Legacy slug squatter', NULL, $2)`,
      [ORG, OWNER, SQUAT],
    );
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [ORG, OWNER, MEMBER],
    );
    await pool.query(
      `INSERT INTO invitations (team_id, email, token_hash, invited_by)
       VALUES ($1, 'invite@example.com', '\\x00112233'::bytea, $2)`,
      [ORG, OWNER],
    );
    await pool.query(
      `INSERT INTO team_settings (team_id, scope, doc)
       VALUES ($1, '*', '{"git":{"base_branch":"main"}}'::jsonb)`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO billing_customers (team_id, stripe_customer_id)
       VALUES ($1, 'cus_123')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO billing_subscriptions (id, team_id, status, plan, seats)
       VALUES ('sub_123', $1, 'active', 'pro', 4)`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO github_installations (
         github_installation_id, app_variant, team_id, account_login,
         account_type, target_type, all_repositories
       ) VALUES (9001, 'github.com', $1, 'acme', 'Organization',
                 'Organization', true)`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO audit_log (team_id, actor_id, action)
       VALUES ($1, $2, 'team.created'), ($1, $2, 'subteam.created')`,
      [ORG, OWNER],
    );

    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("promotes every flat-Team id to an organization without identity loss", async () => {
    const result = await pool.query(
      `SELECT id, slug, name, logo, created_by, is_personal,
              cloud_workspaces_allowed
       FROM organizations WHERE id = $1`,
      [ORG],
    );
    expect(result.rows[0]).toMatchObject({
      id: ORG,
      slug: "acme",
      name: "Acme",
      created_by: OWNER,
      is_personal: false,
      cloud_workspaces_allowed: true,
    });
    expect(result.rows[0].logo).toContain("data:image/png");
  });

  it("creates one default child team and mirrors organization members", async () => {
    const teams = await pool.query<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM teams
       WHERE org_id = $1 AND is_default AND deleted_at IS NULL`,
      [ORG],
    );
    expect(teams.rows).toHaveLength(1);
    expect(teams.rows[0]!.id).not.toBe(ORG);
    const members = await pool.query(
      `SELECT user_id, role FROM team_members
       WHERE team_id = $1 ORDER BY user_id`,
      [teams.rows[0]!.id],
    );
    expect(members.rows).toEqual([
      { user_id: OWNER, role: "maintainer" },
      { user_id: MEMBER, role: "member" },
    ]);
  });

  it("allows a soft-deleted team slug to be recreated without reviving its identity", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const original = await client.query<{ id: string }>(
        `UPDATE teams SET deleted_at = now()
         WHERE org_id = $1 AND is_default
         RETURNING id`,
        [ORG],
      );
      const replacement = await client.query<{ id: string }>(
        `INSERT INTO teams (org_id, slug, name, is_default, created_by)
         VALUES ($1, 'default', 'Default', true, $2)
         RETURNING id`,
        [ORG, OWNER],
      );
      expect(replacement.rows[0]!.id).not.toBe(original.rows[0]!.id);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("backfills one permanent, local-only Personal organization per user", async () => {
    const personal = await pool.query(
      `SELECT created_by, name, cloud_workspaces_allowed
       FROM organizations WHERE is_personal ORDER BY created_by`,
    );
    expect(personal.rows).toEqual([
      { created_by: OWNER, name: "Ada", cloud_workspaces_allowed: false },
      { created_by: MEMBER, name: "Personal", cloud_workspaces_allowed: false },
      { created_by: STRANGER, name: "Lin", cloud_workspaces_allowed: false },
    ]);
    const shells = await pool.query<{ n: number }>(`
      SELECT count(*)::int AS n
      FROM organizations o
      JOIN organization_members om
        ON om.org_id = o.id AND om.user_id = o.created_by AND om.role = 'owner'
      JOIN teams t ON t.org_id = o.id AND t.is_default
      JOIN team_members tm
        ON tm.team_id = t.id AND tm.user_id = o.created_by
       AND tm.role = 'maintainer'
      WHERE o.is_personal
    `);
    expect(shells.rows[0]!.n).toBe(3);
  });

  it("allocates Personal when a legacy organization already owns its preferred slug", async () => {
    const result = await pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM organizations
       WHERE created_by = $1 AND is_personal`,
      [STRANGER],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.slug).toMatch(
      /^personal-33333333333333333333333333333333-[0-9a-f]{32}$/,
    );
    expect(
      await pool.query(`SELECT id FROM organizations WHERE id = $1`, [SQUAT]),
    ).toMatchObject({ rows: [{ id: SQUAT }] });
  });

  it("preserves invitation, settings, billing, and GitHub organization keys", async () => {
    expect((await pool.query(`SELECT org_id FROM invitations`)).rows).toEqual([
      { org_id: ORG },
    ]);
    expect(
      (await pool.query(`SELECT org_id, doc FROM organization_settings`))
        .rows[0],
    ).toMatchObject({ org_id: ORG, doc: { git: { base_branch: "main" } } });
    expect(
      (await pool.query(`SELECT org_id FROM billing_customers`)).rows,
    ).toEqual([{ org_id: ORG }]);
    expect(
      (await pool.query(`SELECT org_id FROM billing_subscriptions`)).rows,
    ).toEqual([{ org_id: ORG }]);
    expect(
      (await pool.query(`SELECT org_id FROM github_installations`)).rows,
    ).toEqual([{ org_id: ORG }]);
  });

  it("restores organization and team audit namespaces without merging them", async () => {
    const actions = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE org_id = $1 ORDER BY action`,
      [ORG],
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      "organization.created",
      "team.created",
    ]);
  });

  it("enforces that every child-team member is already an organization member", async () => {
    const team = await pool.query<{ id: string }>(
      `SELECT id FROM teams WHERE org_id = $1 AND is_default`,
      [ORG],
    );
    await expect(
      pool.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [team.rows[0]!.id, ORG, STRANGER],
      ),
    ).rejects.toThrow(/team_members_org_id_user_id_fkey|foreign key/i);
  });

  it("keeps RLS scoped by organization, including each user's Personal shell", async () => {
    const visible = async (userId: string) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE zeros_app");
        await client.query("SELECT set_config('app.user_id', $1, true)", [
          userId,
        ]);
        const result = await client.query<{ id: string; is_personal: boolean }>(
          `SELECT id, is_personal FROM organizations ORDER BY id`,
        );
        await client.query("COMMIT");
        return result.rows;
      } finally {
        client.release();
      }
    };
    const ownerRows = await visible(OWNER);
    expect(ownerRows.some((row) => row.id === ORG)).toBe(true);
    expect(ownerRows.filter((row) => row.is_personal)).toHaveLength(1);
    const strangerRows = await visible(STRANGER);
    expect(strangerRows.some((row) => row.id === ORG)).toBe(false);
    expect(strangerRows.filter((row) => row.is_personal)).toHaveLength(1);
  });
});

d("0019 retires legacy provider backlog without losing audit rows", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(`
      CREATE TABLE schema_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const file of LADDER.filter((name) => name < "0019")) {
      await pool.query("BEGIN");
      await pool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await pool.query("COMMIT");
    }
    await pool.query(`
      INSERT INTO security_notification_outbox (
        destination_email, template, state, lease_owner, lease_expires_at,
        last_error_code, sent_at
      ) VALUES
        ('queued@example.com', 'sessions_revoked', 'queued', NULL, NULL,
         'zeptomail_429', NULL),
        ('sending@example.com', 'sessions_revoked', 'sending', 'old-worker',
         now() + interval '1 minute', NULL, NULL),
        ('sent@example.com', 'sessions_revoked', 'sent', NULL, NULL,
         NULL, now()),
        ('dead@example.com', 'sessions_revoked', 'dead', NULL, NULL,
         'zeptomail_400', NULL)
    `);
    const file = LADDER.find((name) => name.startsWith("0019_"))!;
    await pool.query("BEGIN");
    await pool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
      file,
    ]);
    await pool.query("COMMIT");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("preserves prior rows under an explicit legacy provider", async () => {
    const rows = await pool.query<{
      destination_email: string;
      state: string;
      delivery_provider: string;
      last_error_code: string | null;
      lease_owner: string | null;
    }>(`
      SELECT destination_email, state, delivery_provider, last_error_code,
             lease_owner
      FROM security_notification_outbox
      ORDER BY destination_email
    `);
    expect(rows.rows).toEqual([
      {
        destination_email: "dead@example.com",
        state: "dead",
        delivery_provider: "legacy_zeptomail",
        last_error_code: "zeptomail_400",
        lease_owner: null,
      },
      {
        destination_email: "queued@example.com",
        state: "dead",
        delivery_provider: "legacy_zeptomail",
        last_error_code: "provider_retired_zeptomail",
        lease_owner: null,
      },
      {
        destination_email: "sending@example.com",
        state: "dead",
        delivery_provider: "legacy_zeptomail",
        last_error_code: "provider_retired_zeptomail",
        lease_owner: null,
      },
      {
        destination_email: "sent@example.com",
        state: "sent",
        delivery_provider: "legacy_zeptomail",
        last_error_code: null,
        lease_owner: null,
      },
    ]);
  });

  it("defaults only newly-created notifications to Resend", async () => {
    const inserted = await pool.query<{
      delivery_provider: string;
      state: string;
    }>(`
      INSERT INTO security_notification_outbox (
        destination_email, template
      ) VALUES ('new@example.com', 'sessions_revoked')
      RETURNING delivery_provider, state
    `);
    expect(inserted.rows[0]).toEqual({
      delivery_provider: "resend",
      state: "queued",
    });
    await expect(
      pool.query(
        `UPDATE security_notification_outbox
         SET delivery_provider = 'legacy_zeptomail'
         WHERE destination_email = 'new@example.com'`,
      ),
    ).rejects.toThrow(/delivery provider is immutable/i);
  });
});
