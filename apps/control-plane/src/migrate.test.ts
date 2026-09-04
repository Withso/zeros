import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import {
  assertNoTopLevelTransactionControl,
  migrationChecksum,
  renamedMigrationAliasesFor,
  runMigrations,
  runServiceBootMigrations,
} from "./migrate.js";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);
const LADDER = readdirSync(MIGRATIONS_DIR)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();

const A80AC25_RENAMES = [
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

const C2B7418_RENAMES = [
  [
    "0020_cloud_workspace_setup_worker.sql",
    "0018_cloud_workspace_setup_worker.sql",
  ],
  [
    "0021_cloud_workspace_setup_authority.sql",
    "0019_cloud_workspace_setup_authority.sql",
  ],
  [
    "0022_cloud_workspace_setup_materials.sql",
    "0020_cloud_workspace_setup_materials.sql",
  ],
  [
    "0023_cloud_workspace_generation_transitions.sql",
    "0021_cloud_workspace_generation_transitions.sql",
  ],
  [
    "0024_cloud_workspace_client_access.sql",
    "0022_cloud_workspace_client_access.sql",
  ],
  [
    "0025_cloud_workspace_engine_authority.sql",
    "0023_cloud_workspace_engine_authority.sql",
  ],
  [
    "0026_cloud_workspace_identity_and_entitlements.sql",
    "0024_cloud_workspace_identity_and_entitlements.sql",
  ],
  [
    "0027_cloud_workspace_settings_providers_and_replicas.sql",
    "0025_cloud_workspace_settings_providers_and_replicas.sql",
  ],
  [
    "0028_cloud_workspace_durable_record.sql",
    "0026_cloud_workspace_durable_record.sql",
  ],
  [
    "0029_cloud_workspace_production_operations.sql",
    "0027_cloud_workspace_production_operations.sql",
  ],
  [
    "0030_cloud_workspace_recovery_and_replica_authority.sql",
    "0028_cloud_workspace_recovery_and_replica_authority.sql",
  ],
  [
    "0031_cloud_workspace_checkpoint_entries.sql",
    "0029_cloud_workspace_checkpoint_entries.sql",
  ],
  [
    "0032_cloud_workspace_forks_and_replica_delivery.sql",
    "0030_cloud_workspace_forks_and_replica_delivery.sql",
  ],
  [
    "0033_cloud_workspace_device_replica_protocol.sql",
    "0031_cloud_workspace_device_replica_protocol.sql",
  ],
  [
    "0034_cloud_workspace_replica_receipt_idempotency.sql",
    "0032_cloud_workspace_replica_receipt_idempotency.sql",
  ],
  [
    "0035_cloud_workspace_device_and_replica_commands.sql",
    "0033_cloud_workspace_device_and_replica_commands.sql",
  ],
  [
    "0036_cloud_workspace_object_size_contract.sql",
    "0034_cloud_workspace_object_size_contract.sql",
  ],
  [
    "0037_cloud_workspace_retention_and_deletion.sql",
    "0035_cloud_workspace_retention_and_deletion.sql",
  ],
  [
    "0038_cloud_workspace_fork_copy_integrity.sql",
    "0036_cloud_workspace_fork_copy_integrity.sql",
  ],
  [
    "0039_cloud_workspace_engine_connection_authority.sql",
    "0037_cloud_workspace_engine_connection_authority.sql",
  ],
  [
    "0040_cloud_workspace_port_forward_authority.sql",
    "0038_cloud_workspace_port_forward_authority.sql",
  ],
  [
    "0041_cloud_workspace_provider_connection_authority.sql",
    "0039_cloud_workspace_provider_connection_authority.sql",
  ],
  [
    "0042_cloud_workspace_secret_authority.sql",
    "0040_cloud_workspace_secret_authority.sql",
  ],
  [
    "0043_cloud_workspace_profile_default_authority.sql",
    "0041_cloud_workspace_profile_default_authority.sql",
  ],
  [
    "0044_cloud_workspace_managed_policy_authority.sql",
    "0042_cloud_workspace_managed_policy_authority.sql",
  ],
  [
    "0045_cloud_workspace_execution_projection.sql",
    "0043_cloud_workspace_execution_projection.sql",
  ],
  [
    "0046_cloud_workspace_paid_authority_checks.sql",
    "0044_cloud_workspace_paid_authority_checks.sql",
  ],
  [
    "0047_cloud_workspace_provider_version_authority.sql",
    "0045_cloud_workspace_provider_version_authority.sql",
  ],
  [
    "0048_cloud_workspace_fork_deadlines.sql",
    "0046_cloud_workspace_fork_deadlines.sql",
  ],
  [
    "0049_cloud_workspace_replica_command_responses.sql",
    "0047_cloud_workspace_replica_command_responses.sql",
  ],
  [
    "0050_cloud_workspace_path_hierarchy.sql",
    "0048_cloud_workspace_path_hierarchy.sql",
  ],
  [
    "0051_cloud_workspace_fork_identity.sql",
    "0049_cloud_workspace_fork_identity.sql",
  ],
  [
    "0052_cloud_workspace_canonical_path_order.sql",
    "0050_cloud_workspace_canonical_path_order.sql",
  ],
] as const;

describe("migration SQL transaction guard", () => {
  it.each([
    "BEGIN; SELECT 1;",
    "START TRANSACTION; SELECT 1;",
    "SELECT 1; COMMIT WORK;",
    "SELECT 1; ROLLBACK;",
    "SAVEPOINT before_change; SELECT 1;",
    "PREPARE TRANSACTION 'migration';",
  ])("rejects top-level transaction control in %s", (sql) => {
    expect(() =>
      assertNoTopLevelTransactionControl("0001_example.sql", sql),
    ).toThrow(/0001_example\.sql.*top-level transaction control/i);
  });

  it("ignores transaction words in comments, strings, and dollar-quoted bodies", () => {
    const sql = `
-- BEGIN; COMMIT;
CREATE TABLE example (value text DEFAULT 'ROLLBACK;');
/* START TRANSACTION; */
CREATE FUNCTION example_trigger() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  NEW.value := 'COMMIT;';
  RETURN NEW;
END
$function$;
`;

    expect(() =>
      assertNoTopLevelTransactionControl("0001_example.sql", sql),
    ).not.toThrow();
  });
});

describe("historical migration filename compatibility", () => {
  it("uses the explicit a80ac25 0013-0018 mapping", () => {
    for (const [current, historical] of A80AC25_RENAMES) {
      expect(renamedMigrationAliasesFor(current)).toContain(historical);
    }
  });

  it("uses the explicit c2b7418 0018-0050 mapping", () => {
    for (const [current, historical] of C2B7418_RENAMES) {
      expect(renamedMigrationAliasesFor(current)).toContain(historical);
    }
  });

  it("does not infer aliases for later similarly named migrations", () => {
    expect(
      renamedMigrationAliasesFor(
        "0053_cloud_workspace_personal_organization_invariant.sql",
      ),
    ).toEqual([]);
    expect(
      renamedMigrationAliasesFor("0999_cloud_workspace_future.sql"),
    ).toEqual([]);
  });
});

describe("migration checksums", () => {
  it("uses a stable, algorithm-qualified digest of exact file content", () => {
    expect(migrationChecksum("SELECT 1;\n")).toBe(
      "sha256:b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
    );
    expect(migrationChecksum("SELECT 1;")).not.toBe(
      migrationChecksum("SELECT 1;\n"),
    );
  });
});

describe("migration runner connection boundary", () => {
  it("uses one client, disables its request timeout, and holds the stable lock", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const ledger = LADDER.map((name) => ({
      name,
      checksum: migrationChecksum(
        readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
      ),
    }));
    const release = vi.fn();
    const client = {
      query: vi.fn(
        async (
          query: string | { text: string; values?: unknown[] },
          values?: unknown[],
        ) => {
          const text = typeof query === "string" ? query : query.text;
          const parameters =
            values ?? (typeof query === "string" ? [] : (query.values ?? []));
          calls.push({ text, values: parameters });
          if (/SHOW\s+statement_timeout/i.test(text)) {
            return { rows: [{ statement_timeout: "30s" }], rowCount: 1 };
          }
          if (
            /SELECT\s+name,\s*checksum\s+FROM\s+schema_migrations/i.test(text)
          ) {
            return { rows: ledger, rowCount: ledger.length };
          }
          return { rows: [], rowCount: 0 };
        },
      ),
      release,
    };
    const poolQuery = vi.fn(() => {
      throw new Error("migration escaped its dedicated client");
    });
    const pool = {
      connect: vi.fn(async () => client),
      query: poolQuery,
    } as unknown as pg.Pool;

    await expect(runMigrations(pool)).resolves.toEqual([]);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();

    const timeoutDisabledAt = calls.findIndex(({ text }) =>
      /SET\s+statement_timeout\s*=\s*0/i.test(text),
    );
    const lockedAt = calls.findIndex(({ text }) =>
      /pg_advisory_lock/i.test(text),
    );
    const unlockedAt = calls.findIndex(({ text }) =>
      /pg_advisory_unlock/i.test(text),
    );
    const timeoutRestoredAt = calls.findIndex(({ text }) =>
      /set_config\('statement_timeout'/i.test(text),
    );

    expect(timeoutDisabledAt).toBeGreaterThanOrEqual(0);
    expect(lockedAt).toBeGreaterThan(timeoutDisabledAt);
    expect(calls[lockedAt]?.values).toEqual([1514492495, 1296648018]);
    expect(unlockedAt).toBeGreaterThan(lockedAt);
    expect(timeoutRestoredAt).toBeGreaterThan(unlockedAt);
  });
});

function poolWithAppliedMigrations(appliedNames: readonly string[]): {
  pool: pg.Pool;
  calls: Array<{ text: string; values: readonly unknown[] }>;
} {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const ledger = appliedNames.map((name) => ({
    name,
    checksum: migrationChecksum(
      readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
    ),
  }));
  const client = {
    query: vi.fn(
      async (
        query: string | { text: string; values?: unknown[] },
        values?: unknown[],
      ) => {
        const text = typeof query === "string" ? query : query.text;
        const parameters =
          values ?? (typeof query === "string" ? [] : (query.values ?? []));
        calls.push({ text, values: parameters });
        if (/SHOW\s+statement_timeout/i.test(text)) {
          return { rows: [{ statement_timeout: "30s" }], rowCount: 1 };
        }
        if (
          /SELECT\s+name,\s*checksum\s+FROM\s+schema_migrations/i.test(text)
        ) {
          return { rows: ledger, rowCount: ledger.length };
        }
        return { rows: [], rowCount: 0 };
      },
    ),
    release: vi.fn(),
  };
  return {
    calls,
    pool: {
      connect: vi.fn(async () => client),
      query: vi.fn(() => {
        throw new Error("migration escaped its dedicated client");
      }),
    } as unknown as pg.Pool,
  };
}

describe("automatic service-boot migration policy", () => {
  const controlledBoundary = "0025_cloud_workspace_engine_authority.sql";
  const throughBeforeBoundary = LADDER.slice(
    0,
    LADDER.indexOf(controlledBoundary),
  );
  const productionWithoutApproval = { NODE_ENV: "production" };

  it("never defers the unapproved 0009 core-schema boundary", async () => {
    const coreBoundary = "0009_organization_team_hierarchy.sql";
    const { pool } = poolWithAppliedMigrations(
      LADDER.slice(0, LADDER.indexOf(coreBoundary)),
    );

    await expect(
      runServiceBootMigrations(pool, {
        cloudWorkspacesEnabled: false,
        env: productionWithoutApproval,
      }),
    ).rejects.toThrow(/0009_organization_team_hierarchy\.sql.*not approved/i);
  });

  it("stops at the unapproved boundary when cloud runtime is disabled", async () => {
    const { pool, calls } = poolWithAppliedMigrations(throughBeforeBoundary);

    await expect(
      runServiceBootMigrations(pool, {
        cloudWorkspacesEnabled: false,
        env: productionWithoutApproval,
      }),
    ).resolves.toEqual({
      ran: [],
      status: {
        state: "controlled_migration_pending",
        migration: controlledBoundary,
        dependentRuntime: "cloud_workspaces",
      },
    });

    const recordedNames = calls
      .filter(({ text }) => /INSERT\s+INTO\s+schema_migrations/i.test(text))
      .flatMap(({ values }) => values)
      .filter((value): value is string => typeof value === "string");
    expect(recordedNames).not.toContain(controlledBoundary);
    expect(recordedNames).not.toContain(
      "0026_cloud_workspace_identity_and_entitlements.sql",
    );
  });

  it("ignores a leaked 0025 approval at service boot and still leaves it pending", async () => {
    const { pool, calls } = poolWithAppliedMigrations(throughBeforeBoundary);

    await expect(
      runServiceBootMigrations(pool, {
        cloudWorkspacesEnabled: false,
        env: {
          NODE_ENV: "production",
          CONTROL_PLANE_MIGRATION_APPROVALS: controlledBoundary,
        },
      }),
    ).resolves.toMatchObject({
      ran: [],
      status: {
        state: "controlled_migration_pending",
        migration: controlledBoundary,
      },
    });

    const recordedNames = calls
      .filter(({ text }) => /INSERT\s+INTO\s+schema_migrations/i.test(text))
      .map(({ values }) => values[0]);
    expect(recordedNames).not.toContain(controlledBoundary);
    expect(recordedNames).not.toContain(
      "0026_cloud_workspace_identity_and_entitlements.sql",
    );
  });

  it("applies only the safe prefix before reporting the pending boundary", async () => {
    const cloudStart = LADDER.indexOf("0020_cloud_workspace_setup_worker.sql");
    const { pool, calls } = poolWithAppliedMigrations(
      LADDER.slice(0, cloudStart),
    );

    const result = await runServiceBootMigrations(pool, {
      cloudWorkspacesEnabled: false,
      env: productionWithoutApproval,
    });

    expect(result.ran).toEqual(
      LADDER.slice(cloudStart, LADDER.indexOf(controlledBoundary)),
    );
    expect(result.status).toMatchObject({
      state: "controlled_migration_pending",
      migration: controlledBoundary,
    });
    const recordedNames = calls
      .filter(({ text }) => /INSERT\s+INTO\s+schema_migrations/i.test(text))
      .map(({ values }) => values[0]);
    expect(recordedNames).toContain("0024_cloud_workspace_client_access.sql");
    expect(recordedNames).not.toContain(controlledBoundary);
    expect(recordedNames).not.toContain(
      "0026_cloud_workspace_identity_and_entitlements.sql",
    );
  });

  it("fails closed at the same boundary when cloud runtime is enabled", async () => {
    const { pool } = poolWithAppliedMigrations(throughBeforeBoundary);

    await expect(
      runServiceBootMigrations(pool, {
        cloudWorkspacesEnabled: true,
        env: productionWithoutApproval,
      }),
    ).rejects.toThrow(
      /0025_cloud_workspace_engine_authority\.sql.*not approved/i,
    );
  });

  it("keeps explicit migration strict and never skips the boundary", async () => {
    const { pool } = poolWithAppliedMigrations(throughBeforeBoundary);

    await expect(
      runMigrations(pool, { env: productionWithoutApproval }),
    ).rejects.toThrow(
      /0025_cloud_workspace_engine_authority\.sql.*not approved/i,
    );
  });

  it("rejects a ledger with a later migration recorded across a gap", async () => {
    const later = "0026_cloud_workspace_identity_and_entitlements.sql";
    const { pool } = poolWithAppliedMigrations([
      ...throughBeforeBoundary,
      later,
    ]);

    await expect(
      runServiceBootMigrations(pool, {
        cloudWorkspacesEnabled: false,
        env: productionWithoutApproval,
      }),
    ).rejects.toThrow(
      /migration ledger is out of order.*0026_cloud_workspace_identity_and_entitlements\.sql.*0025_cloud_workspace_engine_authority\.sql/i,
    );
  });
});
