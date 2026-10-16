import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { parseDatabaseTarget } from "./database-target.js";
import { createMigrationPool } from "./db.js";
import { isRolloutFlagName } from "./rollout-flags.js";

/** Errors with messages curated for operators; the CLI prints only these. */
export class RolloutFlagManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RolloutFlagManagementError";
  }
}

const curated = (message: string): never => { throw new RolloutFlagManagementError(message); };

const ChangeSchema = z.object({
  operationId: z.string().uuid().transform(value => value.toLowerCase()),
  channel: z.enum(["development", "alpha", "beta", "production"]),
  orgId: z.string().uuid().transform(value => value.toLowerCase()),
  expectedOrgSlug: z.string().trim().min(1).max(128).transform(value => value.toLowerCase()),
  flag: z.string().refine(isRolloutFlagName, "Unknown rollout flag"),
  enabled: z.boolean(),
  actorUserId: z.string().uuid().transform(value => value.toLowerCase()),
  reason: z.string().trim().min(16).max(512),
}).strict();
export type CloudRolloutFlagChange = z.input<typeof ChangeSchema>;

/** Channel and production gate, mirroring manage-cloud-workspace-entitlement:
 * both channel sources must agree, and executing against production needs the
 * explicit confirmation variable. */
function validateChannel(options: { channel: string; execute?: boolean | undefined; railwayEnvironmentName?: string | undefined; productionConfirmed?: string | undefined }): string {
  const channel = options.channel.trim().toLowerCase();
  if (!["development", "alpha", "beta", "production"].includes(channel)) {
    curated("CONTROL_PLANE_ROLLOUT_FLAG_CHANNEL must be development, alpha, beta, or production");
  }
  const railway = options.railwayEnvironmentName?.trim().toLowerCase();
  if (railway && railway !== channel) {
    curated("Rollout flag channel does not match RAILWAY_ENVIRONMENT_NAME");
  }
  if (options.execute && channel === "production" && options.productionConfirmed !== "true") {
    curated("CONTROL_PLANE_ROLLOUT_FLAG_PRODUCTION_CONFIRMED=true is required for production confirmation");
  }
  return channel;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type FlagState = { enabled: boolean; revision: string } | null;

/** Operator change of one organization's rollout flag. Dry run by default:
 * the plan hash it returns must be supplied to execute, so a target that
 * changed in between is refused. Every executed change writes a receipt. */
export async function manageCloudRolloutFlag(
  pool: pg.Pool,
  input: unknown,
  options: {
    databaseUrl: string; channel: string; execute?: boolean; approval?: string | undefined;
    railwayEnvironmentName?: string | undefined; productionConfirmed?: string | undefined;
  },
) {
  const parsed = ChangeSchema.safeParse(input);
  if (!parsed.success) curated("Rollout flag document is invalid");
  const request = parsed.data!;
  const channel = validateChannel(options);
  if (request.channel !== channel) curated("Rollout flag deployment channel mismatch");
  const target = parseDatabaseTarget(options.databaseUrl);
  const targetSha256 = hash([request.channel, target.hostname, target.port, target.pathname, decodeURIComponent(target.username)]);
  const requestSha256 = hash(request);
  const client = await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; SELECT set_config('app.system','on',true)");
    const authority = (await client.query<{ principal: string; database: string; allowed: boolean }>(`SELECT current_user AS principal,current_database() AS database,
      current_user<>'zeros_app' AND bool_and(pg_get_userbyid(relowner)=current_user) AS allowed FROM pg_class
      WHERE oid IN ('public.cloud_rollout_flags'::regclass,'public.cloud_rollout_flag_changes'::regclass)`)).rows[0];
    if (!authority?.allowed || authority.database !== decodeURIComponent(target.pathname.slice(1))) {
      throw new RolloutFlagManagementError("Rollout flag changes require the exact database migration owner");
    }
    // FOR SHARE fences a concurrent demotion of the actor for this transaction.
    const actor = (await client.query<{ auth_status: string; deleted_at: Date | null; staff_role: string | null; auth_revision: string }>(
      "SELECT auth_status,deleted_at,staff_role,auth_revision FROM users WHERE id=$1 FOR SHARE", [request.actorUserId])).rows[0];
    if (!actor || actor.auth_status !== "active" || actor.deleted_at || actor.staff_role !== "platform_owner") {
      throw new RolloutFlagManagementError("Rollout flag changes require an active platform owner");
    }
    const receipt = (await client.query<{ target_sha256: string; request_sha256: string; plan_sha256: string }>(
      "SELECT target_sha256,request_sha256,plan_sha256 FROM cloud_rollout_flag_changes WHERE operation_id=$1", [request.operationId])).rows[0];
    if (receipt) {
      if (receipt.target_sha256 !== targetSha256 || receipt.request_sha256 !== requestSha256) {
        curated("Rollout flag operation already identifies another change");
      }
      if (options.execute && options.approval !== receipt.plan_sha256) curated("Rollout flag plan changed");
      await client.query("ROLLBACK");
      return { state: options.execute ? "replayed" as const : "committed" as const, planSha256: receipt.plan_sha256, targetSha256 };
    }
    // The organization row lock serializes concurrent changes for one org,
    // including the first insert of a flag that has no row yet.
    const org = (await client.query<{ slug: string; is_personal: boolean; deleted_at: Date | null; lifecycle_status: string; cloud_workspaces_allowed: boolean }>(
      "SELECT slug::text AS slug,is_personal,deleted_at,lifecycle_status,cloud_workspaces_allowed FROM organizations WHERE id=$1 FOR NO KEY UPDATE", [request.orgId])).rows[0];
    if (!org || org.deleted_at || org.is_personal) throw new RolloutFlagManagementError("Rollout flags apply only to a live collaborative organization");
    if (org.lifecycle_status !== "active" || !org.cloud_workspaces_allowed) {
      throw new RolloutFlagManagementError("Rollout flags require an active, cloud-enabled organization");
    }
    if (org.slug.toLowerCase() !== request.expectedOrgSlug) curated("Rollout flag expected organization does not match");
    const row = (await client.query<{ enabled: boolean; revision: string }>(
      "SELECT enabled,revision::text AS revision FROM cloud_rollout_flags WHERE org_id=$1 AND flag=$2", [request.orgId, request.flag])).rows[0];
    const previous: FlagState = row ? { enabled: row.enabled, revision: row.revision } : null;
    if (previous?.enabled === request.enabled) {
      curated(`Rollout flag ${request.flag} is already ${request.enabled ? "enabled" : "disabled"} for this organization`);
    }
    const next = { enabled: request.enabled, revision: String(BigInt(previous?.revision ?? "0") + 1n) };
    const planSha256 = hash({ targetSha256, requestSha256, previous, next, actorRevision: String(actor.auth_revision), principal: authority.principal });
    if (!options.execute) {
      await client.query("ROLLBACK");
      return { state: "planned" as const, planSha256, targetSha256, previous, next };
    }
    if (options.approval !== planSha256) curated("Rollout flag plan changed; inspect the current target before execution");
    await client.query(`INSERT INTO cloud_rollout_flags(org_id,flag,enabled,revision) VALUES($1,$2,$3,$4)
      ON CONFLICT(org_id,flag) DO UPDATE SET enabled=EXCLUDED.enabled,revision=EXCLUDED.revision,updated_at=clock_timestamp()`,
      [request.orgId, request.flag, next.enabled, next.revision]);
    await client.query(`INSERT INTO cloud_rollout_flag_changes(operation_id,org_id,flag,actor_user_id,deployment_channel,target_sha256,
      request_sha256,plan_sha256,previous_enabled,next_enabled,next_revision,database_principal,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [request.operationId, request.orgId, request.flag, request.actorUserId, request.channel, targetSha256, requestSha256,
        planSha256, previous?.enabled ?? null, next.enabled, next.revision, authority.principal, request.reason]);
    await client.query("COMMIT");
    return { state: "changed" as const, planSha256, targetSha256, previous, next };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const file = process.env.CLOUD_ROLLOUT_FLAG_CHANGE_FILE, databaseUrl = process.env.DATABASE_URL;
  // Both channel sources must agree; neither silently wins (the entitlement
  // command behaves the same way).
  const channel = process.env.CONTROL_PLANE_ROLLOUT_FLAG_CHANNEL;
  if (!file || !databaseUrl || !channel) throw new RolloutFlagManagementError("Rollout flag configuration is incomplete");
  const changeFile = file, url = databaseUrl, channelName = channel;
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--execute")) curated("Unsupported operator arguments");
  const fd = openSync(changeFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) curated("Invalid operator document");
    input = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  const pool = createMigrationPool(url, { maxConnections: 1 });
  try {
    const result = await manageCloudRolloutFlag(pool, input, {
      databaseUrl: url, channel: channelName, execute: args.includes("--execute"), approval: process.env.CLOUD_ROLLOUT_FLAG_PLAN_SHA256,
      railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
      productionConfirmed: process.env.CONTROL_PLANE_ROLLOUT_FLAG_PRODUCTION_CONFIRMED,
    });
    console.log(JSON.stringify(result));
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    // Curated messages are safe and useful; anything else stays generic so a
    // driver error cannot echo connection details into operator logs.
    console.error(error instanceof RolloutFlagManagementError
      ? `[rollout-flag] ${error.message}`
      : "[rollout-flag] request failed; inspect the target, owner, organization, flag and approval");
    process.exitCode = 1;
  });
}
