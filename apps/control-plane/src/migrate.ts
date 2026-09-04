// ──────────────────────────────────────────────────────────
// Migrations runner — plain numbered .sql files, forward-only,
// each applied in its own transaction, recorded with a content checksum.
// No ORM, no framework: `pg_dump` portability is a design goal.
//
// Strict use: DATABASE_URL=… pnpm migrate
// Production image: DATABASE_URL=… node dist/migrate.js
// Service boot calls the separately constrained runServiceBootMigrations().
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
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

// Two signed int32 keys whose bytes spell ZERO/MIGR. These literal values are
// a cross-release protocol: unlike a database hash function, they cannot drift
// between PostgreSQL versions. The session lock spans the ledger work and all
// per-file transactions on the same dedicated client.
const MIGRATION_LOCK_KEYS = [0x5a45524f, 0x4d494752] as const;

/**
 * Exact compatibility aliases from the two cloud-workspace branch revisions
 * that were run before their migrations were renumbered during the main merge.
 *
 * a80ac25 used 0013-0018. c2b7418 used 0018-0050. Never infer aliases from
 * arithmetic or a filename prefix: a later similarly named migration is new
 * DDL and must run normally.
 */
const RENAMED_MIGRATION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "0020_cloud_workspace_setup_worker.sql": [
    "0013_cloud_workspace_setup_worker.sql",
    "0018_cloud_workspace_setup_worker.sql",
  ],
  "0021_cloud_workspace_setup_authority.sql": [
    "0014_cloud_workspace_setup_authority.sql",
    "0019_cloud_workspace_setup_authority.sql",
  ],
  "0022_cloud_workspace_setup_materials.sql": [
    "0015_cloud_workspace_setup_materials.sql",
    "0020_cloud_workspace_setup_materials.sql",
  ],
  "0023_cloud_workspace_generation_transitions.sql": [
    "0016_cloud_workspace_generation_transitions.sql",
    "0021_cloud_workspace_generation_transitions.sql",
  ],
  "0024_cloud_workspace_client_access.sql": [
    "0017_cloud_workspace_client_access.sql",
    "0022_cloud_workspace_client_access.sql",
  ],
  "0025_cloud_workspace_engine_authority.sql": [
    "0018_cloud_workspace_engine_authority.sql",
    "0023_cloud_workspace_engine_authority.sql",
  ],
  "0026_cloud_workspace_identity_and_entitlements.sql": [
    "0024_cloud_workspace_identity_and_entitlements.sql",
  ],
  "0027_cloud_workspace_settings_providers_and_replicas.sql": [
    "0025_cloud_workspace_settings_providers_and_replicas.sql",
  ],
  "0028_cloud_workspace_durable_record.sql": [
    "0026_cloud_workspace_durable_record.sql",
  ],
  "0029_cloud_workspace_production_operations.sql": [
    "0027_cloud_workspace_production_operations.sql",
  ],
  "0030_cloud_workspace_recovery_and_replica_authority.sql": [
    "0028_cloud_workspace_recovery_and_replica_authority.sql",
  ],
  "0031_cloud_workspace_checkpoint_entries.sql": [
    "0029_cloud_workspace_checkpoint_entries.sql",
  ],
  "0032_cloud_workspace_forks_and_replica_delivery.sql": [
    "0030_cloud_workspace_forks_and_replica_delivery.sql",
  ],
  "0033_cloud_workspace_device_replica_protocol.sql": [
    "0031_cloud_workspace_device_replica_protocol.sql",
  ],
  "0034_cloud_workspace_replica_receipt_idempotency.sql": [
    "0032_cloud_workspace_replica_receipt_idempotency.sql",
  ],
  "0035_cloud_workspace_device_and_replica_commands.sql": [
    "0033_cloud_workspace_device_and_replica_commands.sql",
  ],
  "0036_cloud_workspace_object_size_contract.sql": [
    "0034_cloud_workspace_object_size_contract.sql",
  ],
  "0037_cloud_workspace_retention_and_deletion.sql": [
    "0035_cloud_workspace_retention_and_deletion.sql",
  ],
  "0038_cloud_workspace_fork_copy_integrity.sql": [
    "0036_cloud_workspace_fork_copy_integrity.sql",
  ],
  "0039_cloud_workspace_engine_connection_authority.sql": [
    "0037_cloud_workspace_engine_connection_authority.sql",
  ],
  "0040_cloud_workspace_port_forward_authority.sql": [
    "0038_cloud_workspace_port_forward_authority.sql",
  ],
  "0041_cloud_workspace_provider_connection_authority.sql": [
    "0039_cloud_workspace_provider_connection_authority.sql",
  ],
  "0042_cloud_workspace_secret_authority.sql": [
    "0040_cloud_workspace_secret_authority.sql",
  ],
  "0043_cloud_workspace_profile_default_authority.sql": [
    "0041_cloud_workspace_profile_default_authority.sql",
  ],
  "0044_cloud_workspace_managed_policy_authority.sql": [
    "0042_cloud_workspace_managed_policy_authority.sql",
  ],
  "0045_cloud_workspace_execution_projection.sql": [
    "0043_cloud_workspace_execution_projection.sql",
  ],
  "0046_cloud_workspace_paid_authority_checks.sql": [
    "0044_cloud_workspace_paid_authority_checks.sql",
  ],
  "0047_cloud_workspace_provider_version_authority.sql": [
    "0045_cloud_workspace_provider_version_authority.sql",
  ],
  "0048_cloud_workspace_fork_deadlines.sql": [
    "0046_cloud_workspace_fork_deadlines.sql",
  ],
  "0049_cloud_workspace_replica_command_responses.sql": [
    "0047_cloud_workspace_replica_command_responses.sql",
  ],
  "0050_cloud_workspace_path_hierarchy.sql": [
    "0048_cloud_workspace_path_hierarchy.sql",
  ],
  "0051_cloud_workspace_fork_identity.sql": [
    "0049_cloud_workspace_fork_identity.sql",
  ],
  "0052_cloud_workspace_canonical_path_order.sql": [
    "0050_cloud_workspace_canonical_path_order.sql",
  ],
};

const NO_MIGRATION_ALIASES: readonly string[] = Object.freeze([]);

export function renamedMigrationAliasesFor(file: string): readonly string[] {
  return RENAMED_MIGRATION_ALIASES[file] ?? NO_MIGRATION_ALIASES;
}

export function migrationChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`;
}

type TransactionControl = { keyword: string; line: number };

/** Replace comments and quoted regions while preserving offsets and newlines. */
function maskQuotedSql(sql: string): string {
  const masked = sql.split("");
  let state:
    | "normal"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "dollar-quote" = "normal";
  let blockDepth = 0;
  let dollarTag = "";

  const blank = (start: number, length: number) => {
    for (let offset = 0; offset < length; offset += 1) {
      if (masked[start + offset] !== "\n" && masked[start + offset] !== "\r") {
        masked[start + offset] = " ";
      }
    }
  };

  for (let index = 0; index < sql.length; index += 1) {
    const pair = sql.slice(index, index + 2);
    const character = sql[index]!;

    if (state === "line-comment") {
      if (character === "\n") {
        state = "normal";
      } else {
        blank(index, 1);
      }
      continue;
    }

    if (state === "block-comment") {
      if (pair === "/*") {
        blank(index, 2);
        blockDepth += 1;
        index += 1;
      } else if (pair === "*/") {
        blank(index, 2);
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) state = "normal";
      } else {
        blank(index, 1);
      }
      continue;
    }

    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, index)) {
        blank(index, dollarTag.length);
        index += dollarTag.length - 1;
        state = "normal";
      } else {
        blank(index, 1);
      }
      continue;
    }

    if (state === "single-quote" || state === "double-quote") {
      const delimiter = state === "single-quote" ? "'" : '"';
      blank(index, 1);
      if (character === delimiter && sql[index + 1] === delimiter) {
        blank(index + 1, 1);
        index += 1;
      } else if (character === "\\" && index + 1 < sql.length) {
        blank(index + 1, 1);
        index += 1;
      } else if (character === delimiter) {
        state = "normal";
      }
      continue;
    }

    if (pair === "--") {
      blank(index, 2);
      index += 1;
      state = "line-comment";
      continue;
    }
    if (pair === "/*") {
      blank(index, 2);
      index += 1;
      blockDepth = 1;
      state = "block-comment";
      continue;
    }
    if (character === "'" || character === '"') {
      blank(index, 1);
      state = character === "'" ? "single-quote" : "double-quote";
      continue;
    }
    if (character === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (tag) {
        dollarTag = tag[0];
        blank(index, dollarTag.length);
        index += dollarTag.length - 1;
        state = "dollar-quote";
      }
    }
  }

  return masked.join("");
}

function findTopLevelTransactionControl(
  sql: string,
): TransactionControl | null {
  const masked = maskQuotedSql(sql);
  const statement =
    /(?:^|;)(\s*)(ABORT|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|START\s+TRANSACTION|PREPARE\s+TRANSACTION|SET\s+TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION)\b/giu;
  const match = statement.exec(masked);
  if (!match) return null;
  const prefixLength = match[0]!.startsWith(";") ? 1 : 0;
  const keywordIndex = match.index + prefixLength + match[1]!.length;
  return {
    keyword: match[2]!.replace(/\s+/gu, " ").toUpperCase(),
    line: masked.slice(0, keywordIndex).split("\n").length,
  };
}

export function assertNoTopLevelTransactionControl(
  file: string,
  sql: string,
): void {
  const control = findTopLevelTransactionControl(sql);
  if (!control) return;
  throw new Error(
    `Migration ${file} contains top-level transaction control ${control.keyword} ` +
      `at line ${control.line}; the migration runner owns transaction boundaries.`,
  );
}

function requiresControlledDowntime(sql: string): boolean {
  return sql
    .split(/\r?\n/u)
    .slice(0, 12)
    .some((line) => line.trim() === CONTROLLED_DOWNTIME_MARKER);
}

function approvedMigrationNames(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.CONTROL_PLANE_MIGRATION_APPROVALS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * A marked migration is incompatible with the currently running server schema.
 * The explicit production migrator must receive its exact filename. Automatic
 * service boot has a separate policy and never consumes this approval.
 */
export function assertMigrationApproved(
  file: string,
  sql: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env.NODE_ENV !== "production" ||
    !requiresControlledDowntime(sql) ||
    approvedMigrationNames(env).has(file)
  ) {
    return;
  }
  throw new Error(
    `Migration ${file} requires controlled downtime and is not approved. ` +
      `Stop the old deployment, take a database backup, then set ` +
      `CONTROL_PLANE_MIGRATION_APPROVALS=${file} for the one-time rollout.`,
  );
}

type Migration = { file: string; sql: string; checksum: string };

export type MigrationStatus =
  | { state: "current" }
  | {
      state: "controlled_migration_pending";
      migration: string;
      dependentRuntime: "cloud_workspaces";
    };

export type ServiceBootMigrationResult = {
  ran: string[];
  status: MigrationStatus;
};

type RunMigrationOptions = { env?: NodeJS.ProcessEnv };

export type ServiceBootMigrationOptions = RunMigrationOptions & {
  cloudWorkspacesEnabled: boolean;
};

type MigrationPolicy =
  | { mode: "explicit" }
  | { mode: "service_boot"; cloudWorkspacesEnabled: boolean };

// Only these reviewed migrations may be deferred at boot, and only while the
// entire subsystem that depends on them is disabled. A future downtime marker
// fails closed until it receives its own explicit dependency decision.
type ControlledMigrationBootPolicy = {
  dependentRuntime: "cloud_workspaces";
  safePendingSuffix: readonly string[];
  requiresEmptyPreBoundaryCloudState: boolean;
};

const CONTROLLED_MIGRATION_BOOT_POLICIES: Readonly<
  Record<string, ControlledMigrationBootPolicy>
> = {
  "0025_cloud_workspace_engine_authority.sql": {
    dependentRuntime: "cloud_workspaces",
    requiresEmptyPreBoundaryCloudState: true,
    // Cloud consumers are gated in app.ts/index.ts. The WorkOS fence and
    // owner-only entitlement-evidence migrations are also safe to withhold;
    // unknown provider subjects fail closed while their evidence tables are
    // absent and known active mappings continue. A newly appended migration
    // is not assumed safe: this exact list must receive an explicit review.
    safePendingSuffix: [
      "0025_cloud_workspace_engine_authority.sql",
      "0026_cloud_workspace_identity_and_entitlements.sql",
      "0027_cloud_workspace_settings_providers_and_replicas.sql",
      "0028_cloud_workspace_durable_record.sql",
      "0029_cloud_workspace_production_operations.sql",
      "0030_cloud_workspace_recovery_and_replica_authority.sql",
      "0031_cloud_workspace_checkpoint_entries.sql",
      "0032_cloud_workspace_forks_and_replica_delivery.sql",
      "0033_cloud_workspace_device_replica_protocol.sql",
      "0034_cloud_workspace_replica_receipt_idempotency.sql",
      "0035_cloud_workspace_device_and_replica_commands.sql",
      "0036_cloud_workspace_object_size_contract.sql",
      "0037_cloud_workspace_retention_and_deletion.sql",
      "0038_cloud_workspace_fork_copy_integrity.sql",
      "0039_cloud_workspace_engine_connection_authority.sql",
      "0040_cloud_workspace_port_forward_authority.sql",
      "0041_cloud_workspace_provider_connection_authority.sql",
      "0042_cloud_workspace_secret_authority.sql",
      "0043_cloud_workspace_profile_default_authority.sql",
      "0044_cloud_workspace_managed_policy_authority.sql",
      "0045_cloud_workspace_execution_projection.sql",
      "0046_cloud_workspace_paid_authority_checks.sql",
      "0047_cloud_workspace_provider_version_authority.sql",
      "0048_cloud_workspace_fork_deadlines.sql",
      "0049_cloud_workspace_replica_command_responses.sql",
      "0050_cloud_workspace_path_hierarchy.sql",
      "0051_cloud_workspace_fork_identity.sql",
      "0052_cloud_workspace_canonical_path_order.sql",
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
    ],
  },
  "0060_cloud_workspace_pending_blob_deletions.sql": {
    dependentRuntime: "cloud_workspaces",
    // Existing cloud state is the data this migration must conservatively
    // backfill. Deferral is safe because no DDL runs and the cloud runtime is
    // disabled; unlike 0025, an occupied pre-boundary schema is expected.
    requiresEmptyPreBoundaryCloudState: false,
    safePendingSuffix: [
      "0060_cloud_workspace_pending_blob_deletions.sql",
      "0061_workos_provider_erasure_fences.sql",
      "0062_cloud_workspace_entitlement_operations.sql",
    ],
  },
  "0061_workos_provider_erasure_fences.sql": {
    dependentRuntime: "cloud_workspaces",
    // This boundary must be crossed only after every old deletion worker is
    // drained. While it is pending, the new binary pauses its deletion loop;
    // known WorkOS mappings remain usable and unknown subjects fail closed.
    requiresEmptyPreBoundaryCloudState: false,
    safePendingSuffix: [
      "0061_workos_provider_erasure_fences.sql",
      "0062_cloud_workspace_entitlement_operations.sql",
    ],
  },
};

function assertSafePendingSuffix(
  migrations: readonly Migration[],
  index: number,
  policy: ControlledMigrationBootPolicy,
): void {
  const actual = migrations.slice(index).map((migration) => migration.file);
  const expected = policy.safePendingSuffix;
  const sharedMismatch = actual.findIndex(
    (file, position) => file !== expected[position],
  );
  const mismatchAt =
    sharedMismatch >= 0
      ? sharedMismatch
      : actual.length === expected.length
        ? -1
        : Math.min(actual.length, expected.length);
  if (mismatchAt === -1) return;
  throw new Error(
    `Cannot defer controlled migration ${migrations[index]!.file}: pending ` +
      `migration ${actual[mismatchAt] ?? expected[mismatchAt]} is not covered ` +
      `by its explicit dormant-runtime policy.`,
  );
}

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      assertNoTopLevelTransactionControl(file, sql);
      return { file, sql, checksum: migrationChecksum(sql) };
    }),
  );
}

/** Validate every marked file before an operator performs a destructive reset. */
export async function assertAllControlledMigrationsApproved(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  for (const migration of await loadMigrations()) {
    if (requiresControlledDowntime(migration.sql)) {
      assertMigrationApproved(migration.file, migration.sql, env);
    }
  }
}

async function withMigrationClient<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let originalStatementTimeout: string | null = null;
  let timeoutDisabled = false;
  let lockHeld = false;
  let completed = false;
  let result: T | undefined;
  let operationError: unknown;

  try {
    const timeout = await client.query<{ statement_timeout: string }>(
      "SHOW statement_timeout",
    );
    originalStatementTimeout = timeout.rows[0]?.statement_timeout ?? null;
    if (originalStatementTimeout === null) {
      throw new Error("Could not read migration client statement_timeout");
    }
    await client.query("SET statement_timeout = 0");
    timeoutDisabled = true;
    await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
      ...MIGRATION_LOCK_KEYS,
    ]);
    lockHeld = true;
    result = await work(client);
    completed = true;
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (lockHeld) {
    try {
      await client.query(
        "SELECT pg_advisory_unlock($1::integer, $2::integer)",
        [...MIGRATION_LOCK_KEYS],
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  if (timeoutDisabled && originalStatementTimeout !== null) {
    try {
      await client.query("SELECT set_config('statement_timeout', $1, false)", [
        originalStatementTimeout,
      ]);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  client.release(cleanupError ? true : undefined);

  if (!completed) throw operationError;
  if (cleanupError) {
    throw new Error(
      `Migration client cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
  return result as T;
}

async function prepareMigrationLedger(
  client: pg.PoolClient,
  migrations: readonly Migration[],
): Promise<Map<string, string | null>> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum   text
      )
    `);
    // Existing deployments have the original filename-only ledger. Nullable
    // is intentional: historical alias rows have no source file in this tree,
    // while every canonical row is backfilled or inserted with a checksum.
    await client.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text",
    );
    const { rows } = await client.query<{
      name: string;
      checksum: string | null;
    }>("SELECT name, checksum FROM schema_migrations");
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));

    for (const migration of migrations) {
      if (!applied.has(migration.file)) continue;
      const recorded = applied.get(migration.file);
      if (recorded === null) {
        await client.query(
          `UPDATE schema_migrations
           SET checksum = $2
           WHERE name = $1 AND checksum IS NULL`,
          [migration.file, migration.checksum],
        );
        applied.set(migration.file, migration.checksum);
      } else if (recorded !== migration.checksum) {
        throw new Error(
          `Migration ${migration.file} checksum mismatch: the database records ` +
            `${recorded}, but the file is ${migration.checksum}. Released ` +
            `migration content is immutable.`,
        );
      }
    }

    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function recordedAlias(
  migration: Migration,
  applied: ReadonlyMap<string, string | null>,
): string | null {
  return (
    renamedMigrationAliasesFor(migration.file).find((alias) =>
      applied.has(alias),
    ) ?? null
  );
}

async function recordRenamedMigration(
  client: pg.PoolClient,
  migration: Migration,
  legacyFile: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO schema_migrations (name, applied_at, checksum)
       SELECT $1, applied_at, $2
       FROM schema_migrations
       WHERE name = $3
       ON CONFLICT (name) DO NOTHING`,
      [migration.file, migration.checksum, legacyFile],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  console.log(
    `[migrate] recognized renamed migration ${legacyFile} as ${migration.file}`,
  );
}

function laterRecordedMigration(
  migrations: readonly Migration[],
  index: number,
  applied: ReadonlyMap<string, string | null>,
  includeAliases: boolean,
): Migration | null {
  for (const later of migrations.slice(index + 1)) {
    // A previous version of this runner may already have materialized the
    // canonical compatibility row for a historical alias. That is still a
    // supported rename ladder, not an out-of-order canonical application.
    if (applied.has(later.file)) {
      if (!includeAliases && recordedAlias(later, applied)) continue;
      return later;
    }
    if (includeAliases && recordedAlias(later, applied)) return later;
  }
  return null;
}

async function findPreBoundaryCloudState(
  client: pg.PoolClient,
): Promise<string | null> {
  await client.query("BEGIN");
  try {
    // These are every cloud-workspace relation that can contain durable state
    // immediately before 0025. Bind the same system context used by control-
    // plane background work so FORCE ROW LEVEL SECURITY cannot hide rows from
    // this fail-closed deployment check.
    await client.query("SELECT set_config('app.system', 'on', true)");
    const { rows } = await client.query<{ relation: string }>(`
      SELECT relation
      FROM (
        SELECT 'cloud_workspace_quotas' AS relation
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_quotas LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspaces'
          WHERE EXISTS (SELECT 1 FROM cloud_workspaces LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_generations'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_generations LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_provider_bindings'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_provider_bindings LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_lifecycle_intents'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_endpoint_grants'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_endpoint_grants LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_setup_runs'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_setup_runs LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_provider_orphans'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_provider_orphans LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_setup_specs'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_setup_specs LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_setup_attestations'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_setup_attestations LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_setup_secrets'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_setup_secrets LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_engine_instances'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_engine_instances LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_generation_transitions'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_generation_transitions LIMIT 1)
        UNION ALL
        SELECT 'cloud_workspace_client_access_grants'
          WHERE EXISTS (SELECT 1 FROM cloud_workspace_client_access_grants LIMIT 1)
      ) occupied
      ORDER BY relation
      LIMIT 1
    `);
    await client.query("COMMIT");
    return rows[0]?.relation ?? null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function applyMigration(
  client: pg.PoolClient,
  migration: Migration,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
      [migration.file, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      `Migration ${migration.file} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function executeMigrations(
  pool: pg.Pool,
  policy: MigrationPolicy,
  env: NodeJS.ProcessEnv,
): Promise<ServiceBootMigrationResult> {
  const migrations = await loadMigrations();
  return withMigrationClient(pool, async (client) => {
    const applied = await prepareMigrationLedger(client, migrations);
    const ran: string[] = [];

    for (const [index, migration] of migrations.entries()) {
      if (applied.has(migration.file)) continue;

      const legacyFile = recordedAlias(migration, applied);
      if (legacyFile) {
        await recordRenamedMigration(client, migration, legacyFile);
        applied.set(migration.file, migration.checksum);
        continue;
      }

      // A canonical later row without its historical alias cannot come from a
      // supported rename ladder. Refuse to fill such a gap silently.
      const unexpectedLater = laterRecordedMigration(
        migrations,
        index,
        applied,
        false,
      );
      if (unexpectedLater) {
        throw new Error(
          `Migration ledger is out of order: ${unexpectedLater.file} is ` +
            `recorded after missing ${migration.file}.`,
        );
      }

      const productionControlledBoundary =
        env.NODE_ENV === "production" &&
        requiresControlledDowntime(migration.sql);
      if (productionControlledBoundary && policy.mode === "service_boot") {
        const bootPolicy = CONTROLLED_MIGRATION_BOOT_POLICIES[migration.file];
        if (bootPolicy && !policy.cloudWorkspacesEnabled) {
          assertSafePendingSuffix(migrations, index, bootPolicy);
          const later = laterRecordedMigration(
            migrations,
            index,
            applied,
            true,
          );
          if (later) {
            throw new Error(
              `Migration ledger is out of order: ${later.file} is recorded ` +
                `after missing controlled boundary ${migration.file}.`,
            );
          }
          if (bootPolicy.requiresEmptyPreBoundaryCloudState) {
            const existingCloudState = await findPreBoundaryCloudState(client);
            if (existingCloudState) {
              throw new Error(
                `Cannot defer controlled migration ${migration.file}: existing ` +
                  `cloud state was found in ${existingCloudState}. Run the ` +
                  `strict operator migration during controlled downtime before ` +
                  `starting this release.`,
              );
            }
          }
          return {
            ran,
            status: {
              state: "controlled_migration_pending",
              migration: migration.file,
              dependentRuntime: bootPolicy.dependentRuntime,
            },
          };
        }

        // Automatic production boot never consumes the operator approval
        // variable. Only a migration with an explicit dormant-subsystem
        // policy may pause; core-schema and future marked boundaries fail.
        throw new Error(
          `Migration ${migration.file} requires controlled downtime and is ` +
            `not approved for automatic service boot. ` +
            `CONTROL_PLANE_MIGRATION_APPROVALS is honored only by the strict ` +
            `operator migrator.`,
        );
      }

      // Explicit runs consume one-time approvals. Development boot preserves
      // its existing unguarded behavior; production service boot returned or
      // failed above and can never execute a controlled boundary itself.
      assertMigrationApproved(migration.file, migration.sql, env);
      await applyMigration(client, migration);
      applied.set(migration.file, migration.checksum);
      ran.push(migration.file);
      console.log(`[migrate] applied ${migration.file}`);
    }

    return { ran, status: { state: "current" } };
  });
}

/** Strict operator/programmatic runner: a controlled boundary is never skipped. */
export async function runMigrations(
  pool: pg.Pool,
  options: RunMigrationOptions = {},
): Promise<string[]> {
  const result = await executeMigrations(
    pool,
    { mode: "explicit" },
    options.env ?? process.env,
  );
  return result.ran;
}

/**
 * Automatic boot runner. It may report one of the reviewed pending cloud
 * boundaries only while cloud runtime is actually disabled; every other case
 * is strict.
 */
export async function runServiceBootMigrations(
  pool: pg.Pool,
  options: ServiceBootMigrationOptions,
): Promise<ServiceBootMigrationResult> {
  return executeMigrations(
    pool,
    {
      mode: "service_boot",
      cloudWorkspacesEnabled: options.cloudWorkspacesEnabled,
    },
    options.env ?? process.env,
  );
}

async function runMigrationCli(): Promise<void> {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const ran = await runMigrations(pool);
    console.log(
      ran.length
        ? `[migrate] done (${ran.length} applied)`
        : "[migrate] up to date",
    );
  } finally {
    await pool.end();
  }
}

// Strict CLI entrypoint for both source checkouts (`pnpm migrate`) and the
// production image (`node dist/migrate.js`). Exact module identity avoids
// running this side effect when tests or the service import the runner.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runMigrationCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
