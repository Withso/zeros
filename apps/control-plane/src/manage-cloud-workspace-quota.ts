// Guarded database-owner utility for provisioning Organization cloud-workspace
// quotas. The default mode is read-only. Execution is bound to one database,
// deployment channel, Organization, accountable platform owner, exact current
// and next quota, and audit reason. Quota decreases cannot strand usage above
// the new limit, and every mutation writes owner-only append-only evidence.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { z } from "zod";

const CHANNELS = ["development", "alpha", "beta", "production"] as const;
const UserIdSchema = z.string().uuid();
const OrganizationIdSchema = z.string().uuid();
const OrganizationSlugSchema = z.string().trim().min(1).max(255);
const ReasonSchema = z.string().trim().min(16).max(512);
const PostgresIntegerSchema = z.coerce.number().int().min(1).max(2_147_483_647);
const CpuMillicoresSchema = PostgresIntegerSchema.min(250);
const MemoryMiBSchema = PostgresIntegerSchema.min(512);
const StorageMiBSchema = PostgresIntegerSchema.min(1_024);

export interface CloudWorkspaceQuotaLimits {
  maxWorkspaces: number;
  maxRunningWorkspaces: number;
  maxCpuMillicores: number;
  maxMemoryMiB: number;
  maxStorageMiB: number;
}

export interface CloudWorkspaceQuotaRequestInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  productionConfirmed?: string | undefined;
  approval?: string | undefined;
  organizationId: string | undefined;
  expectedOrganizationSlug: string | undefined;
  actorUserId: string | undefined;
  maxWorkspaces: string | undefined;
  maxRunningWorkspaces: string | undefined;
  maxCpuMillicores: string | undefined;
  maxMemoryMiB: string | undefined;
  maxStorageMiB: string | undefined;
  reason: string | undefined;
}

export interface ValidatedCloudWorkspaceQuotaRequest {
  databaseUrl: string;
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  organizationId: string;
  expectedOrganizationSlug: string;
  actorUserId: string;
  next: CloudWorkspaceQuotaLimits;
  reason: string;
  targetFingerprint: string;
}

export interface CloudWorkspaceQuotaChangeResult {
  state: "planned" | "changed" | "unchanged";
  organizationId: string;
  actorUserId: string;
  previous: CloudWorkspaceQuotaLimits | null;
  next: CloudWorkspaceQuotaLimits;
  targetFingerprint: string;
  approval: string | null;
}

type QuotaRow = {
  max_workspaces: number;
  max_running_workspaces: number;
  max_cpu_millicores: number;
  max_memory_mib: number;
  max_storage_mib: number;
};

type UsageRow = {
  workspaces: string | number;
  running: string | number;
  cpu_millicores: string | number;
  memory_mib: string | number;
  storage_mib: string | number;
};

export class CloudWorkspaceQuotaManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudWorkspaceQuotaManagementError";
  }
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new CloudWorkspaceQuotaManagementError(
      "Invalid quota configuration: DATABASE_URL must be a PostgreSQL URL",
    );
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new CloudWorkspaceQuotaManagementError(
      "Invalid quota configuration: DATABASE_URL must identify one PostgreSQL database",
    );
  }
  return parsed;
}

function targetFingerprint(databaseUrl: string, channel: string): string {
  const parsed = parseDatabaseUrl(databaseUrl);
  const target = [
    "zeros-control-plane-cloud-quota.v1",
    channel,
    parsed.hostname.toLowerCase(),
    parsed.port || "5432",
    parsed.pathname,
  ].join("\0");
  return createHash("sha256").update(target, "utf8").digest("hex").slice(0, 16);
}

function reasonFingerprint(reason: string): string {
  return createHash("sha256").update(reason, "utf8").digest("hex").slice(0, 12);
}

function quotaLabel(quota: CloudWorkspaceQuotaLimits | null): string {
  return quota
    ? [
        quota.maxWorkspaces,
        quota.maxRunningWorkspaces,
        quota.maxCpuMillicores,
        quota.maxMemoryMiB,
        quota.maxStorageMiB,
      ].join(",")
    : "none";
}

function quotaFromRow(
  row: QuotaRow | undefined,
): CloudWorkspaceQuotaLimits | null {
  if (!row) return null;
  return {
    maxWorkspaces: row.max_workspaces,
    maxRunningWorkspaces: row.max_running_workspaces,
    maxCpuMillicores: row.max_cpu_millicores,
    maxMemoryMiB: row.max_memory_mib,
    maxStorageMiB: row.max_storage_mib,
  };
}

function quotasEqual(
  left: CloudWorkspaceQuotaLimits | null,
  right: CloudWorkspaceQuotaLimits,
): boolean {
  return (
    left !== null &&
    left.maxWorkspaces === right.maxWorkspaces &&
    left.maxRunningWorkspaces === right.maxRunningWorkspaces &&
    left.maxCpuMillicores === right.maxCpuMillicores &&
    left.maxMemoryMiB === right.maxMemoryMiB &&
    left.maxStorageMiB === right.maxStorageMiB
  );
}

export function validateCloudWorkspaceQuotaRequest(
  input: CloudWorkspaceQuotaRequestInput,
): ValidatedCloudWorkspaceQuotaRequest {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
    throw new CloudWorkspaceQuotaManagementError(
      "CONTROL_PLANE_CLOUD_QUOTA_CHANNEL must be development, alpha, beta, or production",
    );
  }
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel) {
    throw new CloudWorkspaceQuotaManagementError(
      "Cloud quota channel does not match RAILWAY_ENVIRONMENT_NAME",
    );
  }
  if (
    input.execute &&
    channel === "production" &&
    input.productionConfirmed !== "true"
  ) {
    throw new CloudWorkspaceQuotaManagementError(
      "CONTROL_PLANE_CLOUD_QUOTA_PRODUCTION_CONFIRMED=true is required for production confirmation",
    );
  }

  const organizationId = OrganizationIdSchema.safeParse(input.organizationId);
  const expectedOrganizationSlug = OrganizationSlugSchema.safeParse(
    input.expectedOrganizationSlug,
  );
  const actorUserId = UserIdSchema.safeParse(input.actorUserId);
  const reason = ReasonSchema.safeParse(input.reason);
  if (!organizationId.success) {
    throw new CloudWorkspaceQuotaManagementError(
      "CONTROL_PLANE_CLOUD_QUOTA_ORGANIZATION_ID must be one exact UUID",
    );
  }
  if (!expectedOrganizationSlug.success) {
    throw new CloudWorkspaceQuotaManagementError(
      "CONTROL_PLANE_CLOUD_QUOTA_EXPECTED_ORGANIZATION_SLUG is required and must be at most 255 characters",
    );
  }
  if (!actorUserId.success) {
    throw new CloudWorkspaceQuotaManagementError(
      "CONTROL_PLANE_CLOUD_QUOTA_ACTOR_USER_ID must be one exact UUID",
    );
  }
  if (!reason.success) {
    throw new CloudWorkspaceQuotaManagementError(
      "CONTROL_PLANE_CLOUD_QUOTA_REASON must contain 16 to 512 characters",
    );
  }

  const parsedLimits = z
    .object({
      maxWorkspaces: PostgresIntegerSchema,
      maxRunningWorkspaces: PostgresIntegerSchema,
      maxCpuMillicores: CpuMillicoresSchema,
      maxMemoryMiB: MemoryMiBSchema,
      maxStorageMiB: StorageMiBSchema,
    })
    .safeParse({
      maxWorkspaces: input.maxWorkspaces,
      maxRunningWorkspaces: input.maxRunningWorkspaces,
      maxCpuMillicores: input.maxCpuMillicores,
      maxMemoryMiB: input.maxMemoryMiB,
      maxStorageMiB: input.maxStorageMiB,
    });
  if (!parsedLimits.success) {
    throw new CloudWorkspaceQuotaManagementError(
      "Cloud quota limits must be bounded positive PostgreSQL integers (CPU >= 250, memory >= 512 MiB, storage >= 1024 MiB)",
    );
  }
  if (
    parsedLimits.data.maxRunningWorkspaces > parsedLimits.data.maxWorkspaces
  ) {
    throw new CloudWorkspaceQuotaManagementError(
      "Cloud quota running workspace limit cannot exceed the total workspace limit",
    );
  }

  return {
    databaseUrl: input.databaseUrl,
    channel: channel as ValidatedCloudWorkspaceQuotaRequest["channel"],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    organizationId: organizationId.data,
    expectedOrganizationSlug: expectedOrganizationSlug.data.toLowerCase(),
    actorUserId: actorUserId.data,
    next: parsedLimits.data,
    reason: reason.data,
    targetFingerprint: targetFingerprint(input.databaseUrl, channel),
  };
}

export function cloudWorkspaceQuotaApprovalText(
  request: ValidatedCloudWorkspaceQuotaRequest,
  previous: CloudWorkspaceQuotaLimits | null,
): string {
  return [
    "cloud-quota",
    request.channel,
    request.targetFingerprint,
    request.organizationId,
    request.actorUserId,
    quotaLabel(previous),
    quotaLabel(request.next),
    reasonFingerprint(request.reason),
  ].join(":");
}

function assertQuotaCoversUsage(
  next: CloudWorkspaceQuotaLimits,
  usage: UsageRow,
): void {
  const current = {
    workspaces: Number(usage.workspaces),
    running: Number(usage.running),
    cpuMillicores: Number(usage.cpu_millicores),
    memoryMiB: Number(usage.memory_mib),
    storageMiB: Number(usage.storage_mib),
  };
  if (
    current.workspaces > next.maxWorkspaces ||
    current.running > next.maxRunningWorkspaces ||
    current.cpuMillicores > next.maxCpuMillicores ||
    current.memoryMiB > next.maxMemoryMiB ||
    current.storageMiB > next.maxStorageMiB
  ) {
    throw new CloudWorkspaceQuotaManagementError(
      "Requested cloud quota is below the Organization's current workspace usage",
    );
  }
}

export async function manageCloudWorkspaceQuota(
  pool: pg.Pool,
  request: ValidatedCloudWorkspaceQuotaRequest,
): Promise<CloudWorkspaceQuotaChangeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('app.system', 'on', true)");

    const privilege = await client.query<{
      principal: string;
      owns_quota: boolean;
      owns_evidence: boolean;
      can_insert_quota: boolean;
      can_update_quota: boolean;
      can_write_evidence: boolean;
    }>(
      `SELECT current_user AS principal,
              pg_get_userbyid(quota_table.relowner) = current_user AS owns_quota,
              pg_get_userbyid(evidence_table.relowner) = current_user AS owns_evidence,
              has_table_privilege(
                current_user, 'public.cloud_workspace_quotas', 'INSERT'
              ) AS can_insert_quota,
              has_table_privilege(
                current_user, 'public.cloud_workspace_quotas', 'UPDATE'
              ) AS can_update_quota,
              has_table_privilege(
                current_user, 'public.cloud_workspace_quota_changes', 'INSERT'
              ) AS can_write_evidence
       FROM pg_class quota_table
       CROSS JOIN pg_class evidence_table
       WHERE quota_table.oid = 'public.cloud_workspace_quotas'::regclass
         AND evidence_table.oid = 'public.cloud_workspace_quota_changes'::regclass`,
    );
    const owner = privilege.rows[0];
    if (
      !owner ||
      owner.principal === "zeros_app" ||
      !owner.owns_quota ||
      !owner.owns_evidence ||
      !owner.can_insert_quota ||
      !owner.can_update_quota ||
      !owner.can_write_evidence
    ) {
      throw new CloudWorkspaceQuotaManagementError(
        "Cloud quota changes require the database/migration owner; the application role is refused",
      );
    }

    const actorResult = await client.query<{
      id: string;
      auth_status: string;
      deleted_at: Date | string | null;
      staff_role: string | null;
    }>(
      `SELECT id, auth_status, deleted_at, staff_role
       FROM users WHERE id = $1 FOR SHARE`,
      [request.actorUserId],
    );
    const actor = actorResult.rows[0];
    if (
      !actor ||
      actor.auth_status !== "active" ||
      actor.deleted_at !== null ||
      actor.staff_role !== "platform_owner"
    ) {
      throw new CloudWorkspaceQuotaManagementError(
        "Cloud quota actor must be one active Zeros platform owner",
      );
    }

    const organizationResult = await client.query<{
      id: string;
      slug: string;
      is_personal: boolean;
      cloud_workspaces_allowed: boolean;
      deleted_at: Date | string | null;
    }>(
      `SELECT id, slug::text, is_personal, cloud_workspaces_allowed, deleted_at
       FROM organizations WHERE id = $1 FOR UPDATE`,
      [request.organizationId],
    );
    const organization = organizationResult.rows[0];
    if (!organization) {
      throw new CloudWorkspaceQuotaManagementError(
        "Cloud quota Organization was not found",
      );
    }
    if (organization.slug.toLowerCase() !== request.expectedOrganizationSlug) {
      throw new CloudWorkspaceQuotaManagementError(
        "Organization UUID does not match CONTROL_PLANE_CLOUD_QUOTA_EXPECTED_ORGANIZATION_SLUG",
      );
    }
    if (organization.is_personal) {
      throw new CloudWorkspaceQuotaManagementError(
        "Personal tenants cannot receive a cloud workspace quota",
      );
    }
    if (
      organization.deleted_at !== null ||
      !organization.cloud_workspaces_allowed
    ) {
      throw new CloudWorkspaceQuotaManagementError(
        "Cloud quota requires one active cloud-enabled Organization",
      );
    }

    const entitlement = await client.query<{ present: boolean }>(
      `SELECT true AS present
       FROM organization_entitlements
       WHERE org_id = $1
         AND status IN ('active', 'trialing')
         AND cloud_workspaces_allowed
         AND valid_from <= now()
         AND (valid_until IS NULL OR valid_until > now())`,
      [request.organizationId],
    );
    if (!entitlement.rows[0]?.present) {
      throw new CloudWorkspaceQuotaManagementError(
        "Cloud quota requires a current Organization cloud entitlement",
      );
    }

    const quotaResult = await client.query<QuotaRow>(
      `SELECT max_workspaces, max_running_workspaces, max_cpu_millicores,
              max_memory_mib, max_storage_mib
       FROM cloud_workspace_quotas WHERE org_id = $1 FOR UPDATE`,
      [request.organizationId],
    );
    const previous = quotaFromRow(quotaResult.rows[0]);
    // Match route admission: active candidates reserve their full shape, while
    // every known provider resource retains disk until verified deletion.
    const usageResult = await client.query<UsageRow>(
      `WITH workspace_usage AS (
         SELECT count(*) AS workspaces,
                count(*) FILTER (WHERE desired_state = 'running') AS running
         FROM cloud_workspaces
         WHERE org_id = $1 AND status <> 'deleted'
       ), generation_allocation AS (
         SELECT generation.cpu_millicores, generation.memory_mib,
                generation.storage_mib, workspace.desired_state,
                (
                  workspace.status <> 'deleted'
                  AND generation.generation = workspace.current_generation
                ) AS current_reserved,
                (
                  workspace.status <> 'deleted'
                  AND generation.generation <> workspace.current_generation
                  AND generation.retired_at IS NULL
                  AND transition.id IS NOT NULL
                ) AS candidate_reserved,
                (
                  binding.provider_resource_id IS NOT NULL
                  AND binding.deletion_verified_at IS NULL
                ) AS provider_storage_allocated
         FROM cloud_workspaces workspace
         JOIN cloud_workspace_generations generation
           ON generation.workspace_id = workspace.id
          AND generation.org_id = workspace.org_id
         LEFT JOIN cloud_workspace_provider_bindings binding
           ON binding.workspace_id = generation.workspace_id
          AND binding.generation = generation.generation
          AND binding.org_id = generation.org_id
         LEFT JOIN cloud_workspace_generation_transitions transition
           ON transition.workspace_id = generation.workspace_id
          AND transition.org_id = generation.org_id
          AND transition.candidate_generation = generation.generation
          AND transition.state IN (
            'draining', 'provisioning', 'setting_up', 'rolling_back'
          )
         WHERE workspace.org_id = $1
       ), generation_usage AS (
         SELECT coalesce(sum(cpu_millicores) FILTER (
                  WHERE (current_reserved AND desired_state = 'running')
                     OR candidate_reserved
                ), 0) AS cpu_millicores,
                coalesce(sum(memory_mib) FILTER (
                  WHERE (current_reserved AND desired_state = 'running')
                     OR candidate_reserved
                ), 0) AS memory_mib,
                coalesce(sum(storage_mib) FILTER (
                  WHERE current_reserved OR candidate_reserved
                     OR provider_storage_allocated
                ), 0) AS storage_mib
         FROM generation_allocation
       )
       SELECT workspace_usage.workspaces, workspace_usage.running,
              generation_usage.cpu_millicores, generation_usage.memory_mib,
              generation_usage.storage_mib
       FROM workspace_usage CROSS JOIN generation_usage`,
      [request.organizationId],
    );
    assertQuotaCoversUsage(request.next, usageResult.rows[0]!);

    const approval = cloudWorkspaceQuotaApprovalText(request, previous);
    if (quotasEqual(previous, request.next)) {
      if (request.execute) {
        throw new CloudWorkspaceQuotaManagementError(
          "Cloud quota is already at the requested value; generate a fresh plan",
        );
      }
      await client.query("ROLLBACK");
      return {
        state: "unchanged",
        organizationId: request.organizationId,
        actorUserId: request.actorUserId,
        previous,
        next: request.next,
        targetFingerprint: request.targetFingerprint,
        approval: null,
      };
    }

    if (!request.execute) {
      await client.query("ROLLBACK");
      return {
        state: "planned",
        organizationId: request.organizationId,
        actorUserId: request.actorUserId,
        previous,
        next: request.next,
        targetFingerprint: request.targetFingerprint,
        approval,
      };
    }
    if (request.approval !== approval) {
      throw new CloudWorkspaceQuotaManagementError(
        "CONTROL_PLANE_CLOUD_QUOTA_APPROVAL does not match the current target-bound plan",
      );
    }

    await client.query(
      `INSERT INTO cloud_workspace_quotas (
         org_id, max_workspaces, max_running_workspaces,
         max_cpu_millicores, max_memory_mib, max_storage_mib,
         updated_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (org_id) DO UPDATE
       SET max_workspaces = EXCLUDED.max_workspaces,
           max_running_workspaces = EXCLUDED.max_running_workspaces,
           max_cpu_millicores = EXCLUDED.max_cpu_millicores,
           max_memory_mib = EXCLUDED.max_memory_mib,
           max_storage_mib = EXCLUDED.max_storage_mib,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
      [
        request.organizationId,
        request.next.maxWorkspaces,
        request.next.maxRunningWorkspaces,
        request.next.maxCpuMillicores,
        request.next.maxMemoryMiB,
        request.next.maxStorageMiB,
        request.actorUserId,
      ],
    );
    await client.query(
      `INSERT INTO cloud_workspace_quota_changes (
         org_id, actor_user_id,
         previous_max_workspaces, previous_max_running_workspaces,
         previous_max_cpu_millicores, previous_max_memory_mib,
         previous_max_storage_mib,
         next_max_workspaces, next_max_running_workspaces,
         next_max_cpu_millicores, next_max_memory_mib, next_max_storage_mib,
         deployment_channel, target_fingerprint, database_principal, reason
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       )`,
      [
        request.organizationId,
        request.actorUserId,
        previous?.maxWorkspaces ?? null,
        previous?.maxRunningWorkspaces ?? null,
        previous?.maxCpuMillicores ?? null,
        previous?.maxMemoryMiB ?? null,
        previous?.maxStorageMiB ?? null,
        request.next.maxWorkspaces,
        request.next.maxRunningWorkspaces,
        request.next.maxCpuMillicores,
        request.next.maxMemoryMiB,
        request.next.maxStorageMiB,
        request.channel,
        request.targetFingerprint,
        owner.principal,
        request.reason,
      ],
    );
    await client.query("COMMIT");
    return {
      state: "changed",
      organizationId: request.organizationId,
      actorUserId: request.actorUserId,
      previous,
      next: request.next,
      targetFingerprint: request.targetFingerprint,
      approval: null,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new CloudWorkspaceQuotaManagementError("DATABASE_URL is required");
  }
  const request = validateCloudWorkspaceQuotaRequest({
    databaseUrl,
    channel: process.env.CONTROL_PLANE_CLOUD_QUOTA_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: process.argv.includes("--execute"),
    productionConfirmed:
      process.env.CONTROL_PLANE_CLOUD_QUOTA_PRODUCTION_CONFIRMED,
    approval: process.env.CONTROL_PLANE_CLOUD_QUOTA_APPROVAL,
    organizationId: process.env.CONTROL_PLANE_CLOUD_QUOTA_ORGANIZATION_ID,
    expectedOrganizationSlug:
      process.env.CONTROL_PLANE_CLOUD_QUOTA_EXPECTED_ORGANIZATION_SLUG,
    actorUserId: process.env.CONTROL_PLANE_CLOUD_QUOTA_ACTOR_USER_ID,
    maxWorkspaces: process.env.CONTROL_PLANE_CLOUD_QUOTA_MAX_WORKSPACES,
    maxRunningWorkspaces:
      process.env.CONTROL_PLANE_CLOUD_QUOTA_MAX_RUNNING_WORKSPACES,
    maxCpuMillicores: process.env.CONTROL_PLANE_CLOUD_QUOTA_MAX_CPU_MILLICORES,
    maxMemoryMiB: process.env.CONTROL_PLANE_CLOUD_QUOTA_MAX_MEMORY_MIB,
    maxStorageMiB: process.env.CONTROL_PLANE_CLOUD_QUOTA_MAX_STORAGE_MIB,
    reason: process.env.CONTROL_PLANE_CLOUD_QUOTA_REASON,
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await manageCloudWorkspaceQuota(pool, request);
    console.log(
      `[cloud-quota] state=${result.state} channel=${request.channel} ` +
        `target=${result.targetFingerprint} organization=${result.organizationId} ` +
        `actor=${result.actorUserId} previous=${quotaLabel(result.previous)} ` +
        `next=${quotaLabel(result.next)}`,
    );
    if (result.approval) {
      console.log(`[cloud-quota] approval=${result.approval}`);
    }
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runCli().catch((error) => {
    console.error(
      `[cloud-quota] failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    process.exitCode = 1;
  });
}
