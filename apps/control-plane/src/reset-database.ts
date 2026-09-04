// Guarded clean-reset utility for pre-production authentication cutovers.
//
// The default mode is read-only. Destructive execution is target-bound by a
// non-secret fingerprint, requires an explicit backup confirmation, and is
// unavailable for Production (where the runbook requires a fresh database).

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

import {
  assertAllControlledMigrationsApproved,
  runMigrations,
} from "./migrate.js";

const RESETTABLE_CHANNELS = new Set(["alpha", "beta", "development"]);
const COUNT_TABLES = [
  "users",
  "user_identities",
  "organizations",
  "organization_members",
  "teams",
  "team_members",
  "invitations",
  "organization_settings",
  "audit_log",
  "staff_role_changes",
  "staff_operation_grants",
  "billing_customers",
  "billing_subscriptions",
  "github_oauth_states",
  "github_oauth_handoffs",
  "github_authorizations",
  "github_installations",
  "github_audit_log",
  "cloud_workspace_quotas",
  "cloud_workspace_quota_changes",
  "cloud_workspaces",
  "cloud_workspace_generations",
  "cloud_workspace_provider_bindings",
  "cloud_workspace_lifecycle_intents",
  "cloud_workspace_endpoint_grants",
  "cloud_workspace_setup_runs",
  "cloud_workspace_provider_orphans",
  "identity_provider_events",
  "auth_sessions",
  "workos_browser_sessions",
  "workos_organization_links",
  "workos_membership_projections",
  "workos_event_inbox",
  "workos_event_cursors",
  "workos_command_outbox",
  "security_events",
  "account_recovery_requests",
  "security_notification_outbox",
  "deletion_requests",
  "deletion_request_events",
] as const;

export interface ResetRequestInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  backupConfirmed?: string | undefined;
  approval?: string | undefined;
}

export interface ValidatedResetRequest {
  channel: "alpha" | "beta" | "development";
  execute: boolean;
  fingerprint: string;
}

export class DatabaseResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseResetError";
  }
}

function parsedDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new DatabaseResetError(
      "Invalid reset configuration: DATABASE_URL must be a PostgreSQL URL",
    );
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new DatabaseResetError(
      "Invalid reset configuration: DATABASE_URL must identify one PostgreSQL database",
    );
  }
  return parsed;
}

export function resetTargetFingerprint(
  databaseUrl: string,
  channel: string,
): string {
  const parsed = parsedDatabaseUrl(databaseUrl);
  const target = [
    "zeros-control-plane-reset.v1",
    channel.trim().toLowerCase(),
    parsed.hostname.toLowerCase(),
    parsed.port || "5432",
    parsed.pathname,
  ].join("\0");
  return createHash("sha256").update(target, "utf8").digest("hex").slice(0, 16);
}

export function resetApprovalText(
  channel: string,
  fingerprint: string,
): string {
  return `reset:${channel}:${fingerprint}`;
}

export function validateResetRequest(
  input: ResetRequestInput,
): ValidatedResetRequest {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (channel === "production") {
    throw new DatabaseResetError(
      "Production must cut over to a fresh database; in-place reset is disabled",
    );
  }
  if (!RESETTABLE_CHANNELS.has(channel)) {
    throw new DatabaseResetError(
      "Invalid reset configuration: CONTROL_PLANE_RESET_CHANNEL must be alpha, beta, or development",
    );
  }
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel) {
    throw new DatabaseResetError(
      "Reset channel does not match RAILWAY_ENVIRONMENT_NAME",
    );
  }

  const fingerprint = resetTargetFingerprint(input.databaseUrl, channel);
  if (input.execute) {
    if (input.backupConfirmed !== "true") {
      throw new DatabaseResetError(
        "CONTROL_PLANE_RESET_BACKUP_CONFIRMED=true is required for execution",
      );
    }
    const expectedApproval = resetApprovalText(channel, fingerprint);
    if (input.approval !== expectedApproval) {
      throw new DatabaseResetError(
        `CONTROL_PLANE_RESET_APPROVAL must equal ${expectedApproval}`,
      );
    }
  }
  return {
    channel: channel as ValidatedResetRequest["channel"],
    execute: input.execute,
    fingerprint,
  };
}

type MigrationRunner = (pool: pg.Pool) => Promise<string[]>;

async function strictResetMigrationRunner(): Promise<MigrationRunner> {
  // Reset always replays the production ladder, even from a development
  // operator shell. Validate every controlled boundary before dropping the
  // schema, then preserve that exact environment for the strict runner.
  const env = { ...process.env, NODE_ENV: "production" };
  try {
    await assertAllControlledMigrationsApproved(env);
  } catch (error) {
    throw new DatabaseResetError(
      `Migration approval preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return (pool) => runMigrations(pool, { env });
}

export async function resetPublicSchema(
  pool: pg.Pool,
  migrate?: MigrationRunner,
): Promise<string[]> {
  const runResetMigrations = migrate ?? (await strictResetMigrationRunner());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new DatabaseResetError(
      "Database reset failed; no migrations were run",
    );
  } finally {
    client.release();
  }
  return runResetMigrations(pool);
}

async function inspectRowCounts(
  pool: pg.Pool,
): Promise<Record<string, number | null>> {
  // Prove the connection resolves before showing an approval fingerprint. The
  // database name and host never enter output.
  await pool.query("SELECT 1");
  const counts: Record<string, number | null> = {};
  for (const table of COUNT_TABLES) {
    const exists = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass($1) AS relation",
      [`public.${table}`],
    );
    if (!exists.rows[0]?.relation) {
      counts[table] = null;
      continue;
    }
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${table}`,
    );
    counts[table] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new DatabaseResetError("DATABASE_URL is required");
  }
  const request = validateResetRequest({
    databaseUrl,
    channel: process.env.CONTROL_PLANE_RESET_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: process.argv.includes("--execute"),
    backupConfirmed: process.env.CONTROL_PLANE_RESET_BACKUP_CONFIRMED,
    approval: process.env.CONTROL_PLANE_RESET_APPROVAL,
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const counts = await inspectRowCounts(pool);
    console.log(
      `[reset] mode=${request.execute ? "execute" : "plan"} channel=${request.channel} target=${request.fingerprint}`,
    );
    console.log(`[reset] row-counts=${JSON.stringify(counts)}`);
    if (!request.execute) {
      console.log(
        `[reset] approval=${resetApprovalText(request.channel, request.fingerprint)}`,
      );
      console.log("[reset] dry run complete; no data changed");
      return;
    }
    const migrations = await resetPublicSchema(pool);
    console.log(
      `[reset] complete; applied ${migrations.length} migration(s) to the empty schema`,
    );
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    const message =
      error instanceof DatabaseResetError
        ? error.message
        : "Database inspection or reset failed";
    console.error(`[reset] ${message}`);
    process.exitCode = 1;
  });
}
