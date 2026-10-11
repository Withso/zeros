// Database-owner command for requesting ordinary cloud workspace deletion.
// Planning only reads and locks rows; execution commits the same lifecycle
// intent, checkpoint barrier and deletion job as HTTP DELETE. Provider cleanup
// remains worker-owned. An audited approval makes exact reruns replayable.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type pg from "pg";
import { z } from "zod";

import { audit } from "./audit.js";
import { HttpError, requireOrganizationRole } from "./authz.js";
import { authorizeCloudWorkspaceCleanup } from "./cloud-workspaces/actors.js";
import { loadGenerationCloudProviderConnection } from "./cloud-workspaces/provider-connections.js";
import { requestCloudWorkspaceDeletion } from "./cloud-workspaces/routes.js";
import { parseDatabaseTarget } from "./database-target.js";
import { createMigrationPool } from "./db.js";

const CHANNELS = ["development", "alpha", "beta"] as const;
const UUID = z.string().uuid();
const RECEIPT_ACTION = "cloud_workspace.operator_deletion_requested";
const MAX_WORKSPACES = 100;
const SnapshotSchema = z.object({
  workspaceId: UUID,
  status: z.string(),
  desiredState: z.string(),
  version: z.string().regex(/^[1-9][0-9]*$/),
  generation: z.number().int().positive(),
  deleted: z.boolean(),
});
type Snapshot = z.infer<typeof SnapshotSchema>;

export interface CloudWorkspaceDeletionRequestInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  allowRunning?: boolean | undefined;
  approval?: string | undefined;
  approvalId: string | undefined;
  organizationId: string | undefined;
  expectedOrganizationSlug: string | undefined;
  actorUserId: string | undefined;
  workspaceIds: string | undefined;
  reason: string | undefined;
}

export interface ValidatedCloudWorkspaceDeletionRequest {
  channel: (typeof CHANNELS)[number];
  targetFingerprint: string;
  execute: boolean;
  allowRunning: boolean;
  approval: string | null;
  approvalId: string;
  organizationId: string;
  expectedOrganizationSlug: string;
  actorUserId: string;
  workspaceIds: string[];
  reason: string;
}

export interface CloudWorkspaceDeletionResult {
  state: "planned" | "requested" | "replayed" | "unchanged";
  approval: string;
  workspaces: Array<Snapshot & {
    outcome: "planned" | "requested" | "replayed" | "skipped_deleted";
    intentId: string | null;
    intentState: string | null;
  }>;
}

export class CloudWorkspaceDeletionManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudWorkspaceDeletionManagementError";
  }
}

function fail(message: string): never {
  throw new CloudWorkspaceDeletionManagementError(message);
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isDeleted = (workspace: Snapshot) => workspace.deleted || workspace.status === "deleted";
const idempotencyKey = (approvalId: string, workspaceId: string) => `operator-delete:${approvalId}:${workspaceId}`;

export function validateCloudWorkspaceDeletionRequest(
  input: CloudWorkspaceDeletionRequestInput,
): ValidatedCloudWorkspaceDeletionRequest {
  const channel = input.channel?.trim().toLowerCase();
  const deployment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (channel === "production" || deployment === "production") fail("Production cloud workspace deletion is disabled for this operator");
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number]))
    fail("CONTROL_PLANE_CLOUD_DELETION_CHANNEL must be development, alpha or beta");
  if (deployment && deployment !== channel) fail("Cloud deletion channel does not match RAILWAY_ENVIRONMENT_NAME");

  const ids = [input.approvalId, input.organizationId, input.actorUserId].map(value => UUID.safeParse(value));
  if (ids.some(id => !id.success)) fail("Cloud deletion approval id, Organization and actor must be exact UUIDs");
  const workspaceIds = (input.workspaceIds ?? "").split(",").map(value => value.trim().toLowerCase());
  if (workspaceIds.length > MAX_WORKSPACES || workspaceIds.some(value => !UUID.safeParse(value).success))
    fail(`Cloud deletion must name 1 to ${MAX_WORKSPACES} exact cloud workspace UUIDs`);
  if (new Set(workspaceIds).size !== workspaceIds.length) fail("Cloud deletion workspace UUIDs must not repeat");
  const slug = z.string().trim().min(1).max(255).safeParse(input.expectedOrganizationSlug);
  if (!slug.success) fail("CONTROL_PLANE_CLOUD_DELETION_EXPECTED_ORGANIZATION_SLUG is required");
  const reason = z.string().trim().min(16).max(512).safeParse(input.reason);
  if (!reason.success) fail("CONTROL_PLANE_CLOUD_DELETION_REASON must contain 16 to 512 characters");
  let target: URL;
  try { target = parseDatabaseTarget(input.databaseUrl); }
  catch { return fail("DATABASE_URL must identify one explicit PostgreSQL target without routing overrides"); }
  const targetFingerprint = hash([
    "zeros-control-plane-cloud-deletion.v1", channel,
    target.hostname, target.port, target.pathname, decodeURIComponent(target.username),
  ]).slice(0, 16);
  return {
    channel: channel as ValidatedCloudWorkspaceDeletionRequest["channel"], targetFingerprint,
    execute: input.execute, allowRunning: input.allowRunning === true, approval: input.approval?.trim() || null,
    approvalId: input.approvalId!.toLowerCase(), organizationId: input.organizationId!.toLowerCase(),
    actorUserId: input.actorUserId!.toLowerCase(), expectedOrganizationSlug: slug.data.toLowerCase(),
    workspaceIds: workspaceIds.sort(), reason: reason.data,
  };
}

function approvalText(request: ValidatedCloudWorkspaceDeletionRequest, workspaces: Snapshot[]): string {
  return ["cloud-workspace-deletion", request.channel, request.targetFingerprint, request.approvalId, hash({
    organizationId: request.organizationId, expectedOrganizationSlug: request.expectedOrganizationSlug,
    actorUserId: request.actorUserId, workspaceIds: request.workspaceIds,
    allowRunning: request.allowRunning, reason: request.reason, workspaces,
  })].join(":");
}

export async function manageCloudWorkspaceDeletion(
  pool: pg.Pool,
  request: ValidatedCloudWorkspaceDeletionRequest,
): Promise<CloudWorkspaceDeletionResult> {
  if (!CHANNELS.includes(request.channel)) fail("Production cloud workspace deletion is disabled for this operator");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SET LOCAL lock_timeout = '10s'");
    await tx.query("SET LOCAL statement_timeout = '30s'");
    await tx.query("SELECT set_config('app.system', 'on', true)");
    const owner = (await tx.query<{ principal: string; owns_tables: boolean }>(`SELECT current_user AS principal,
      count(*)=4 AND bool_and(pg_get_userbyid(relowner)=current_user) AS owns_tables
      FROM pg_class WHERE oid IN ('public.cloud_workspaces'::regclass,
        'public.cloud_workspace_lifecycle_intents'::regclass,'public.workspace_deletion_jobs'::regclass,
        'public.audit_log'::regclass)`)).rows[0];
    if (!owner?.owns_tables || owner.principal === "zeros_app")
      fail("Cloud deletion requires the database/migration owner; the application role is refused");

    // Match lifecycle's Organization-first lock order. The Organization lock
    // also serializes batches sharing an approval id, without a new table.
    const organization = (await tx.query<{ slug: string; is_personal: boolean; deleted_at: Date | null }>(
      "SELECT slug::text,is_personal,deleted_at FROM organizations WHERE id=$1 FOR UPDATE", [request.organizationId],
    )).rows[0];
    if (!organization || organization.deleted_at) fail("Cloud deletion Organization was not found");
    if (organization.is_personal) fail("Personal tenants and local workspaces cannot use cloud deletion");
    if (organization.slug.toLowerCase() !== request.expectedOrganizationSlug)
      fail("Organization UUID does not match CONTROL_PLANE_CLOUD_DELETION_EXPECTED_ORGANIZATION_SLUG");
    await requireOrganizationRole(tx, request.organizationId, request.actorUserId, "admin");
    const actor = await tx.query("SELECT id FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL", [request.actorUserId]);
    if (actor.rowCount !== 1) fail("Cloud deletion requires an active acting Organization owner or admin");

    const snapshots = (await tx.query<Snapshot>(`SELECT id AS "workspaceId",status,desired_state AS "desiredState",
      version::text,current_generation AS generation,deleted_at IS NOT NULL AS deleted FROM cloud_workspaces
      WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [request.organizationId, request.workspaceIds])).rows;
    if (snapshots.length !== request.workspaceIds.length)
      fail("Every requested workspace must be an existing cloud workspace in the exact Organization");
    for (const workspace of snapshots) {
      await authorizeCloudWorkspaceCleanup(tx, {
        organizationId: request.organizationId, workspaceId: workspace.workspaceId, actorUserId: request.actorUserId,
      });
      if (!isDeleted(workspace) && !await loadGenerationCloudProviderConnection(tx, {
        organizationId: request.organizationId, workspaceId: workspace.workspaceId,
        generation: workspace.generation, requireActive: false,
      })) fail("A requested workspace uses unsupported compute authority");
    }

    const receipts = (await tx.query<{ subject: unknown }>(`SELECT subject FROM audit_log
      WHERE org_id=$1 AND action=$2 AND subject->>'approvalId'=$3 ORDER BY id LIMIT 2`,
    [request.organizationId, RECEIPT_ACTION, request.approvalId])).rows;
    if (receipts.length > 1) fail("Operator approval has inconsistent receipts");
    const receipt = receipts[0] ? z.object({
      schemaVersion: z.literal(1), approval: z.string(), workspaces: z.array(SnapshotSchema).min(1).max(MAX_WORKSPACES),
    }).safeParse(receipts[0].subject) : null;
    if (receipt && !receipt.success) fail("Operator approval has an invalid receipt");
    const approvedSnapshots = receipt?.success ? receipt.data.workspaces : snapshots;
    const approval = approvalText(request, approvedSnapshots);
    if ((receipt?.success && receipt.data.approval !== approval) ||
        (request.execute && request.approval !== approval))
      fail("CONTROL_PLANE_CLOUD_DELETION_APPROVAL does not match the target-bound plan");

    const keys = request.workspaceIds.map(workspaceId => idempotencyKey(request.approvalId, workspaceId));
    const intents = (await tx.query<{ workspace_id: string; id: string; state: string }>(`SELECT workspace_id,id,state
      FROM cloud_workspace_lifecycle_intents WHERE org_id=$1 AND idempotency_key=ANY($2::text[])`,
    [request.organizationId, keys])).rows;
    const replaying = receipt !== null;
    if (!replaying && intents.length) fail("Approval id has lifecycle intents without an operator receipt; choose a new approval id");

    const workspaces: CloudWorkspaceDeletionResult["workspaces"] = [];
    for (const workspace of snapshots) {
      const original = approvedSnapshots.find(item => item.workspaceId === workspace.workspaceId);
      const intent = intents.find(item => item.workspace_id === workspace.workspaceId);
      if (replaying && (!original || (!isDeleted(workspace) && (isDeleted(original) || !intent))))
        fail("Operator approval no longer has its exact workspace intents; generate a fresh plan");
      const running = ["ready", "busy"].includes(workspace.status);
      if (!isDeleted(workspace) && ((running && !request.allowRunning) ||
          (!replaying && !running && !["stopped", "archived", "failed"].includes(workspace.status))))
        fail(`Workspace ${workspace.workspaceId} has refused status ${workspace.status}; ready/busy require --allow-running`);
      workspaces.push({ ...workspace,
        outcome: isDeleted(workspace) ? "skipped_deleted" : replaying ? "replayed" : "planned",
        intentId: intent?.id ?? null, intentState: intent?.state ?? null,
      });
    }
    if (!request.execute) {
      await tx.query("ROLLBACK");
      return { state: replaying ? "replayed" : workspaces.every(isDeleted) ? "unchanged" : "planned", approval, workspaces };
    }

    for (let index = 0; index < workspaces.length; index++) {
      const workspace = workspaces[index]!;
      if (isDeleted(workspace)) continue;
      const result = await requestCloudWorkspaceDeletion(tx, {
        organizationId: request.organizationId, workspaceId: workspace.workspaceId, actorUserId: request.actorUserId,
        idempotencyKey: idempotencyKey(request.approvalId, workspace.workspaceId),
      });
      workspaces[index] = {
        workspaceId: workspace.workspaceId, status: result.workspace.status,
        desiredState: result.workspace.desired_state, generation: result.workspace.current_generation,
        version: String(result.workspace.version), deleted: result.workspace.deleted_at !== null,
        outcome: result.replayed ? "replayed" : "requested", intentId: result.intent.id, intentState: result.intent.state,
      };
    }
    const requested = workspaces.some(workspace => workspace.outcome === "requested");
    if (requested) await audit(tx, request.organizationId, request.actorUserId, RECEIPT_ACTION, {
      schemaVersion: 1, approvalId: request.approvalId, approval,
      channel: request.channel, targetFingerprint: request.targetFingerprint,
      organizationId: request.organizationId, actorUserId: request.actorUserId,
      allowRunning: request.allowRunning, workspaces: snapshots,
      reason: request.reason, databasePrincipal: owner.principal,
    });
    await tx.query("COMMIT");
    return { state: requested ? "requested" : replaying ? "replayed" : "unchanged", approval, workspaces };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

/** Driver errors can include connection strings or SQL values. Only authored
 * operator errors and bounded public authorization codes reach the terminal. */
export function cloudWorkspaceDeletionErrorMessage(error: unknown): string {
  if (error instanceof CloudWorkspaceDeletionManagementError) return error.message;
  if (error instanceof HttpError && /^[a-z0-9_]{1,128}$/.test(error.code)) return `Request refused (${error.code})`;
  return "Cloud workspace deletion failed; no database or credential details are printed";
}

async function runCli(): Promise<void> {
  const { values } = parseArgs({ options: {
    execute: { type: "boolean", default: false },
    "allow-running": { type: "boolean", default: false },
  }, allowPositionals: false, strict: true });
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const request = validateCloudWorkspaceDeletionRequest({
    databaseUrl, channel: process.env.CONTROL_PLANE_CLOUD_DELETION_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: values.execute, allowRunning: values["allow-running"],
    approval: process.env.CONTROL_PLANE_CLOUD_DELETION_APPROVAL,
    approvalId: process.env.CONTROL_PLANE_CLOUD_DELETION_APPROVAL_ID,
    organizationId: process.env.CONTROL_PLANE_CLOUD_DELETION_ORGANIZATION_ID,
    expectedOrganizationSlug: process.env.CONTROL_PLANE_CLOUD_DELETION_EXPECTED_ORGANIZATION_SLUG,
    actorUserId: process.env.CONTROL_PLANE_CLOUD_DELETION_ACTOR_USER_ID,
    workspaceIds: process.env.CONTROL_PLANE_CLOUD_DELETION_WORKSPACE_IDS,
    reason: process.env.CONTROL_PLANE_CLOUD_DELETION_REASON,
  });
  const pool = createMigrationPool(databaseUrl, { maxConnections: 1 });
  try {
    const result = await manageCloudWorkspaceDeletion(pool, request);
    console.log(`[cloud-workspace-deletion] state=${result.state} channel=${request.channel} target=${request.targetFingerprint} ` +
      `organization=${request.organizationId} actor=${request.actorUserId}`);
    for (const workspace of result.workspaces) console.log(
      `[cloud-workspace-deletion] workspace=${workspace.workspaceId} status=${workspace.status} version=${workspace.version} ` +
      `outcome=${workspace.outcome} intent=${workspace.intentId ?? "none"} intent_state=${workspace.intentState ?? "none"}`,
    );
    console.log(`[cloud-workspace-deletion] approval=${result.approval}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch(error => {
    console.error(`[cloud-workspace-deletion] failed: ${cloudWorkspaceDeletionErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
