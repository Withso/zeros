// Owner-operated, one-time promotion of the active/previous Computer captures.
// Planning never constructs a provider or consumes a name allocation.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type pg from "pg";
import { z } from "zod";
import { audit } from "./audit.js";
import { HttpError, requireOrganizationRole } from "./authz.js";
import { parseDatabaseTarget } from "./database-target.js";
import { createMigrationPool } from "./db.js";
import { loadReleaseCanaryBoatConfig } from "./config.js";
import { BoatApiClient } from "./cloud-workspaces/boat-client.js";
import { lockCloudComputerOrganization } from "./cloud-workspaces/computer-identity.js";
import { computerTemplateSnapshotName } from "./cloud-workspaces/computer-template-name.js";
import { BoatComputerTemplateSnapshots } from "./cloud-workspaces/computer-template-snapshot-boat.js";
import { COMPUTER_SNAPSHOT_MIGRATION_ACTION, ComputerTemplateSnapshots,
  type ComputerTemplateSnapshotLifecycle } from "./cloud-workspaces/computer-template-snapshots.js";

const CHANNELS = ["development", "alpha", "beta"] as const;
const uuid = z.string().uuid();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class MigrationError extends Error {}
function fail(message: string): never { throw new MigrationError(message); }

export interface ComputerSnapshotMigrationInput {
  databaseUrl: string; channel: string | undefined; railwayEnvironmentName?: string | undefined;
  execute: boolean; approval?: string | undefined; approvalId: string | undefined;
  organizationId: string | undefined; expectedOrganizationSlug: string | undefined;
  actorUserId: string | undefined; reason: string | undefined;
  accountScope: string | undefined; billingOrg: string | undefined;
}
export function validateComputerSnapshotMigration(input: ComputerSnapshotMigrationInput) {
  const channel = input.channel?.trim().toLowerCase();
  const deployment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (channel === "production" || deployment === "production") fail("Production Computer snapshot migration is disabled");
  if (!CHANNELS.includes(channel as typeof CHANNELS[number])) fail("Migration channel must be development, alpha or beta");
  if (deployment && deployment !== channel) fail("Migration channel does not match RAILWAY_ENVIRONMENT_NAME");
  if ([input.approvalId, input.organizationId, input.actorUserId].some(id => !uuid.safeParse(id).success))
    fail("Approval, Organization and actor must be exact UUIDs");
  const slug = z.string().trim().min(1).max(255).safeParse(input.expectedOrganizationSlug);
  const reason = z.string().trim().min(16).max(512).safeParse(input.reason);
  const account = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).safeParse(input.accountScope);
  const wallet = z.string().regex(/^team_[0-9a-f-]{36}$/).safeParse(input.billingOrg);
  if (!slug.success || !reason.success || !account.success || !wallet.success)
    fail("Exact Organization slug, account, wallet and a 16–512 character reason are required");
  let target: URL;
  try { target = parseDatabaseTarget(input.databaseUrl); }
  catch { return fail("DATABASE_URL must identify one explicit PostgreSQL target without routing overrides"); }
  return { channel: channel as typeof CHANNELS[number], execute: input.execute,
    approval: input.approval?.trim() || null, approvalId: input.approvalId!.toLowerCase(),
    organizationId: input.organizationId!.toLowerCase(), actorUserId: input.actorUserId!.toLowerCase(),
    expectedOrganizationSlug: slug.data.toLowerCase(), reason: reason.data,
    accountScope: account.data, billingOrg: wallet.data,
    targetFingerprint: hash(["zeros.computer-named-migration/v1", channel, target.hostname, target.port,
      target.pathname, decodeURIComponent(target.username), account.data, wallet.data]).slice(0, 16) };
}
type Request = ReturnType<typeof validateComputerSnapshotMigration>;
type Template = { buildId: string; version: string; sourceSandboxId: string; manifestSha256: string;
  name: string | null; state: string | null; sourceOwned: boolean };
type Result = { state: "planned" | "completed" | "replayed"; approval: string; templates: Array<{ buildId: string; version: string; name: string }> };

export async function manageCloudComputerSnapshots(pool: pg.Pool, request: Request,
  createLifecycle: () => ComputerTemplateSnapshotLifecycle): Promise<Result> {
  if (!CHANNELS.includes(request.channel)) fail("Production Computer snapshot migration is disabled");
  const tx = await pool.connect();
  let templates: Template[], approval: string, replayed: boolean;
  try {
    await tx.query("BEGIN");
    await tx.query("SET LOCAL lock_timeout='10s'");
    await tx.query("SET LOCAL statement_timeout='30s'");
    await tx.query("SELECT set_config('app.system','on',true)");
    const owner = (await tx.query<{ principal: string; owns_tables: boolean }>(`SELECT current_user AS principal,
      count(*)=4 AND bool_and(pg_get_userbyid(relowner)=current_user) AS owns_tables FROM pg_class WHERE oid IN
      ('public.cloud_computer_v2_heads'::regclass,'public.cloud_computer_templates'::regclass,
       'public.cloud_computer_template_snapshots'::regclass,'public.audit_log'::regclass)`)).rows[0];
    if (!owner?.owns_tables || owner.principal === "zeros_app") fail("Migration requires the database owner; application role is refused");
    const org = (await tx.query<{ slug: string; is_personal: boolean; lifecycle_status: string }>(
      "SELECT slug,is_personal,lifecycle_status FROM organizations WHERE id=$1 FOR UPDATE", [request.organizationId])).rows[0];
    if (!org || org.lifecycle_status !== "active") fail("Migration Organization is not active");
    if (org.is_personal) fail("Personal owners and local workspaces cannot use Computer snapshot migration");
    if (org.slug.toLowerCase() !== request.expectedOrganizationSlug) fail("Organization UUID does not match expected slug");
    await requireOrganizationRole(tx, request.organizationId, request.actorUserId, "admin");
    if (!(await tx.query("SELECT 1 FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL", [request.actorUserId])).rowCount)
      fail("Migration requires an active Organization owner or admin");
    await lockCloudComputerOrganization(tx, request.organizationId);
    const head = (await tx.query<{ revision: string; active_build_id: string | null; previous_build_id: string | null }>(
      "SELECT revision,active_build_id,previous_build_id FROM cloud_computer_v2_heads WHERE org_id=$1 FOR UPDATE", [request.organizationId])).rows[0];
    if (!head?.active_build_id) fail("Organization has no active Computer to migrate");
    const buildIds = [...new Set([head.active_build_id, head.previous_build_id].filter((id): id is string => id !== null))].sort();
    templates = (await tx.query<Template>(`SELECT build.id AS "buildId",build.version::text,
      template.provider_resource_id AS "sourceSandboxId",encode(template.manifest_sha256,'hex') AS "manifestSha256",
      snapshot.snapshot_name AS name,snapshot.state,
      EXISTS(SELECT 1 FROM cloud_builder_vm_operations operation WHERE operation.account_scope=template.account_scope
        AND operation.operation_key=template.builder_operation_key AND operation.operation_key='computer-build:'||build.id::text
        AND operation.purpose='computer-build' AND operation.state='archived' AND operation.sandbox_id=template.provider_resource_id) AS "sourceOwned"
      FROM cloud_computer_v2_builds build JOIN cloud_computer_templates template ON template.build_id=build.id AND template.org_id=build.org_id
      LEFT JOIN cloud_computer_template_snapshots snapshot ON snapshot.build_id=build.id AND snapshot.org_id=build.org_id
      WHERE build.org_id=$1 AND build.id=ANY($2::uuid[]) AND build.state='succeeded' AND template.state='ready'
        AND template.account_scope=$3 AND template.billing_org=$4 AND template.stopped_at IS NOT NULL
        AND template.manifest_sha256 IS NOT NULL AND template.protected_contract_digest IS NOT NULL
        AND (snapshot.build_id IS NULL OR (snapshot.channel=$5 AND snapshot.account_scope=$3 AND snapshot.billing_org=$4))
      ORDER BY build.version FOR UPDATE OF build,template`, [request.organizationId, buildIds,
      request.accountScope, request.billingOrg, request.channel])).rows;
    if (templates.length !== buildIds.length || templates.some(row => !row.sourceOwned || ["retiring", "retired"].includes(row.state ?? "")))
      fail("Every active/previous template must have its exact stopped builder journal and retained artifact");
    // Mutable capture progress is deliberately absent: a partial run must
    // replay the same audited plan without needing a new approval.
    const reviewed = templates.map(({ buildId, version, sourceSandboxId, manifestSha256 }) => ({ buildId, version, sourceSandboxId, manifestSha256 }));
    approval = ["computer-snapshot-migration", request.channel, request.targetFingerprint, request.approvalId,
      hash({ organizationId: request.organizationId, slug: request.expectedOrganizationSlug, actor: request.actorUserId,
        reason: request.reason, account: request.accountScope, wallet: request.billingOrg, head, templates: reviewed })].join(":");
    const receipts = (await tx.query<{ subject: { approval?: string } }>(`SELECT subject FROM audit_log WHERE org_id=$1 AND action=$2
      AND subject->>'approvalId'=$3 LIMIT 2`, [request.organizationId, COMPUTER_SNAPSHOT_MIGRATION_ACTION, request.approvalId])).rows;
    if (receipts.length > 1 || (receipts[0] && receipts[0].subject.approval !== approval) ||
        (request.execute && request.approval !== approval)) fail("Approval does not match the current target-bound Computer plan");
    replayed = receipts.length === 1 && templates.every(row => row.state === "ready");
    if (request.execute && !receipts.length) await audit(tx, request.organizationId, request.actorUserId,
      COMPUTER_SNAPSHOT_MIGRATION_ACTION, { schemaVersion: 1, approvalId: request.approvalId, approval,
        channel: request.channel, targetFingerprint: request.targetFingerprint, accountScope: request.accountScope,
        billingOrg: request.billingOrg, buildIds, templates: reviewed, head, reason: request.reason, databasePrincipal: owner.principal });
    await tx.query(request.execute ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { tx.release(); }
  const result: Result = { state: request.execute ? replayed ? "replayed" : "completed" : "planned", approval,
    templates: templates.map(row => ({ buildId: row.buildId, version: row.version, name: row.name ??
      computerTemplateSnapshotName({ organizationSlug: request.expectedOrganizationSlug, channel: request.channel, version: 1 }).replace(/v1$/, "v<N allocated on execute>") })) };
  if (!request.execute || replayed) return result;
  const lifecycle = createLifecycle();
  for (const [index, template] of templates.entries()) {
    const captured = await lifecycle.capture({ buildId: template.buildId, approvalId: request.approvalId,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    result.templates[index]!.name = captured.name;
  }
  return result;
}

export function computerSnapshotMigrationErrorMessage(error: unknown): string {
  if (error instanceof MigrationError) return error.message;
  if (error instanceof HttpError && /^[a-z0-9_]{1,128}$/.test(error.code)) return `Request refused (${error.code})`;
  return "Computer snapshot migration failed; no database or provider details are printed";
}
async function runCli() {
  const { values } = parseArgs({ options: { execute: { type: "boolean", default: false } }, strict: true, allowPositionals: false });
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const prefix = "CONTROL_PLANE_COMPUTER_SNAPSHOT_MIGRATION_";
  const request = validateComputerSnapshotMigration({ databaseUrl, execute: values.execute,
    channel: process.env[`${prefix}CHANNEL`], railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    approval: process.env[`${prefix}APPROVAL`], approvalId: process.env[`${prefix}APPROVAL_ID`],
    organizationId: process.env[`${prefix}ORGANIZATION_ID`], expectedOrganizationSlug: process.env[`${prefix}EXPECTED_ORGANIZATION_SLUG`],
    actorUserId: process.env[`${prefix}ACTOR_USER_ID`], reason: process.env[`${prefix}REASON`],
    accountScope: process.env.BOAT_ACCOUNT_SCOPE, billingOrg: process.env.BOAT_BILLING_ORG });
  const pool = createMigrationPool(databaseUrl, { maxConnections: 2 });
  try {
    const result = await manageCloudComputerSnapshots(pool, request, () => {
      const boat = loadReleaseCanaryBoatConfig(process.env);
      if (!boat || boat.accountScope !== request.accountScope || boat.billingOrg !== request.billingOrg)
        return fail("Provider configuration must match the approved account and wallet");
      return new ComputerTemplateSnapshots(pool, { ...boat, channel: request.channel,
        provider: new BoatComputerTemplateSnapshots(new BoatApiClient({ apiKey: boat.apiKey, billingOrg: boat.billingOrg, timeoutMs: 45_000 }),
          boat.billingOrg, request.channel) });
    });
    console.log(JSON.stringify({ channel: request.channel, target: request.targetFingerprint, ...result }));
  } finally { await pool.end(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch(error => { console.error(computerSnapshotMigrationErrorMessage(error)); process.exitCode = 1; });
}
