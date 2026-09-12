// Guarded database-owner utility for the encrypted durable object volume.
// These byte limits are deliberately independent from provider sandbox disk
// quotas. The default is a read-only plan; execution requires exact approval
// text and writes immutable database-owner evidence.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

const CHANNELS = ["development", "alpha", "beta", "production"] as const;
const MAX_EXACT_BYTES = 9_007_199_254_740_991;
const UUID = z.string().uuid();
const SLUG = z.string().trim().min(1).max(255);
const REASON = z.string().trim().min(16).max(512);

export type CloudWorkspaceObjectStorageLimits = {
  maxOrganizationBytes: number;
  maxWorkspaceBytes: number;
};

export interface CloudWorkspaceObjectStorageRequestInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  productionConfirmed?: string | undefined;
  approval?: string | undefined;
  organizationId: string | undefined;
  expectedOrganizationSlug: string | undefined;
  actorUserId: string | undefined;
  maxOrganizationBytes: string | undefined;
  maxWorkspaceBytes: string | undefined;
  reason: string | undefined;
}

export interface ValidatedCloudWorkspaceObjectStorageRequest {
  databaseUrl: string;
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  organizationId: string;
  expectedOrganizationSlug: string;
  actorUserId: string;
  next: CloudWorkspaceObjectStorageLimits;
  reason: string;
  targetFingerprint: string;
}

export interface CloudWorkspaceObjectStorageChangeResult {
  state: "planned" | "changed" | "unchanged";
  organizationId: string;
  actorUserId: string;
  previous: CloudWorkspaceObjectStorageLimits | null;
  next: CloudWorkspaceObjectStorageLimits;
  targetFingerprint: string;
  approval: string | null;
}

type LimitRow = {
  max_organization_bytes: string | number;
  max_workspace_bytes: string | number;
};

export class CloudWorkspaceObjectStorageManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudWorkspaceObjectStorageManagementError";
  }
}

function databaseTarget(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new CloudWorkspaceObjectStorageManagementError(
      "Invalid object-storage configuration: DATABASE_URL must be a PostgreSQL URL",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "Invalid object-storage configuration: DATABASE_URL must identify one PostgreSQL database",
    );
  }
  return parsed;
}

function targetFingerprint(databaseUrl: string, channel: string): string {
  const parsed = databaseTarget(databaseUrl);
  return createHash("sha256")
    .update(
      [
        "zeros-control-plane-cloud-object-storage.v1",
        channel,
        parsed.hostname.toLowerCase(),
        parsed.port || "5432",
        parsed.pathname,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
}

function reasonFingerprint(reason: string): string {
  return createHash("sha256").update(reason, "utf8").digest("hex").slice(0, 12);
}

function exactBytes(raw: string | undefined, name: string): number {
  if (!raw || !/^[1-9][0-9]{0,15}$/.test(raw)) {
    throw new CloudWorkspaceObjectStorageManagementError(
      `${name} must be a positive exact byte count`,
    );
  }
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_EXACT_BYTES) {
    throw new CloudWorkspaceObjectStorageManagementError(
      `${name} must be at most ${MAX_EXACT_BYTES}`,
    );
  }
  return bytes;
}

function limitsFromRow(
  row: LimitRow | undefined,
): CloudWorkspaceObjectStorageLimits | null {
  if (!row) return null;
  return {
    maxOrganizationBytes: Number(row.max_organization_bytes),
    maxWorkspaceBytes: Number(row.max_workspace_bytes),
  };
}

function label(limits: CloudWorkspaceObjectStorageLimits | null): string {
  return limits
    ? `${limits.maxOrganizationBytes},${limits.maxWorkspaceBytes}`
    : "none";
}

export function validateCloudWorkspaceObjectStorageRequest(
  input: CloudWorkspaceObjectStorageRequestInput,
): ValidatedCloudWorkspaceObjectStorageRequest {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "CONTROL_PLANE_CLOUD_OBJECT_STORAGE_CHANNEL must be development, alpha, beta, or production",
    );
  }
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "Object-storage channel does not match RAILWAY_ENVIRONMENT_NAME",
    );
  }
  if (
    input.execute &&
    channel === "production" &&
    input.productionConfirmed !== "true"
  ) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "CONTROL_PLANE_CLOUD_OBJECT_STORAGE_PRODUCTION_CONFIRMED=true is required for production confirmation",
    );
  }
  const organizationId = UUID.safeParse(input.organizationId);
  const actorUserId = UUID.safeParse(input.actorUserId);
  const expectedOrganizationSlug = SLUG.safeParse(
    input.expectedOrganizationSlug,
  );
  const reason = REASON.safeParse(input.reason);
  if (!organizationId.success || !actorUserId.success) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "Object-storage Organization and actor must be exact UUIDs",
    );
  }
  if (!expectedOrganizationSlug.success) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "CONTROL_PLANE_CLOUD_OBJECT_STORAGE_EXPECTED_ORGANIZATION_SLUG is required",
    );
  }
  if (!reason.success) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "CONTROL_PLANE_CLOUD_OBJECT_STORAGE_REASON must contain 16 to 512 characters",
    );
  }
  const next = {
    maxOrganizationBytes: exactBytes(
      input.maxOrganizationBytes,
      "CONTROL_PLANE_CLOUD_OBJECT_STORAGE_MAX_ORGANIZATION_BYTES",
    ),
    maxWorkspaceBytes: exactBytes(
      input.maxWorkspaceBytes,
      "CONTROL_PLANE_CLOUD_OBJECT_STORAGE_MAX_WORKSPACE_BYTES",
    ),
  };
  if (next.maxWorkspaceBytes > next.maxOrganizationBytes) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "Workspace object-storage limit must not exceed the Organization object-storage limit",
    );
  }
  return {
    databaseUrl: input.databaseUrl,
    channel: channel as ValidatedCloudWorkspaceObjectStorageRequest["channel"],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    organizationId: organizationId.data,
    expectedOrganizationSlug: expectedOrganizationSlug.data.toLowerCase(),
    actorUserId: actorUserId.data,
    next,
    reason: reason.data,
    targetFingerprint: targetFingerprint(input.databaseUrl, channel),
  };
}

export function cloudWorkspaceObjectStorageApprovalText(
  request: ValidatedCloudWorkspaceObjectStorageRequest,
  previous: CloudWorkspaceObjectStorageLimits | null,
): string {
  return [
    "cloud-object-storage",
    request.channel,
    request.targetFingerprint,
    request.organizationId,
    request.actorUserId,
    label(previous),
    label(request.next),
    reasonFingerprint(request.reason),
  ].join(":");
}

export async function manageCloudWorkspaceObjectStorage(
  pool: pg.Pool,
  request: ValidatedCloudWorkspaceObjectStorageRequest,
): Promise<CloudWorkspaceObjectStorageChangeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('app.system', 'on', true)");

    const privilege = await client.query<{
      principal: string;
      owns_limits: boolean;
      owns_evidence: boolean;
      can_insert_limits: boolean;
      can_update_limits: boolean;
      can_write_evidence: boolean;
    }>(
      `SELECT current_user AS principal,
              pg_get_userbyid(limits.relowner) = current_user AS owns_limits,
              pg_get_userbyid(evidence.relowner) = current_user AS owns_evidence,
              has_table_privilege(current_user,
                'public.cloud_workspace_object_storage_limits', 'INSERT'
              ) AS can_insert_limits,
              has_table_privilege(current_user,
                'public.cloud_workspace_object_storage_limits', 'UPDATE'
              ) AS can_update_limits,
              has_table_privilege(current_user,
                'public.cloud_workspace_object_storage_limit_changes', 'INSERT'
              ) AS can_write_evidence
       FROM pg_class limits CROSS JOIN pg_class evidence
       WHERE limits.oid =
               'public.cloud_workspace_object_storage_limits'::regclass
         AND evidence.oid =
               'public.cloud_workspace_object_storage_limit_changes'::regclass`,
    );
    const owner = privilege.rows[0];
    if (
      !owner ||
      owner.principal === "zeros_app" ||
      !owner.owns_limits ||
      !owner.owns_evidence ||
      !owner.can_insert_limits ||
      !owner.can_update_limits ||
      !owner.can_write_evidence
    ) {
      throw new CloudWorkspaceObjectStorageManagementError(
        "Object-storage changes require the database/migration owner; the application role is refused",
      );
    }

    const actor = (
      await client.query<{
        auth_status: string;
        deleted_at: Date | string | null;
        staff_role: string | null;
      }>(
        `SELECT auth_status, deleted_at, staff_role
         FROM users WHERE id = $1 FOR SHARE`,
        [request.actorUserId],
      )
    ).rows[0];
    if (
      !actor ||
      actor.auth_status !== "active" ||
      actor.deleted_at !== null ||
      actor.staff_role !== "platform_owner"
    ) {
      throw new CloudWorkspaceObjectStorageManagementError(
        "Object-storage actor must be one active Zeros platform owner",
      );
    }

    const organization = (
      await client.query<{
        slug: string;
        is_personal: boolean;
        cloud_workspaces_allowed: boolean;
        deleted_at: Date | string | null;
      }>(
        `SELECT slug::text, is_personal, cloud_workspaces_allowed, deleted_at
         FROM organizations WHERE id = $1 FOR UPDATE`,
        [request.organizationId],
      )
    ).rows[0];
    if (
      !organization ||
      organization.slug.toLowerCase() !== request.expectedOrganizationSlug ||
      organization.is_personal ||
      organization.deleted_at !== null ||
      !organization.cloud_workspaces_allowed
    ) {
      throw new CloudWorkspaceObjectStorageManagementError(
        "Object-storage target must be the exact active cloud-enabled Organization",
      );
    }
    const entitled = await client.query(
      `SELECT 1 FROM organization_entitlements
       WHERE org_id = $1 AND status IN ('active', 'trialing')
         AND cloud_workspaces_allowed AND valid_from <= now()
         AND (valid_until IS NULL OR valid_until > now())`,
      [request.organizationId],
    );
    if ((entitled.rowCount ?? 0) !== 1) {
      throw new CloudWorkspaceObjectStorageManagementError(
        "Object-storage limits require a current Organization cloud entitlement",
      );
    }

    // Runtime admission can already hold Organization/FK row locks when it
    // enters the shared advisory boundary. Keep that same row-before-advisory
    // order here so an operator plan cannot form a lock cycle with an upload.
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('workspace-object-storage:' || $1::text, 0)
       )`,
      [request.organizationId],
    );

    const current = await client.query<LimitRow>(
      `SELECT max_organization_bytes, max_workspace_bytes
       FROM cloud_workspace_object_storage_limits WHERE org_id = $1`,
      [request.organizationId],
    );
    const previous = limitsFromRow(current.rows[0]);
    const usage = (
      await client.query<{
        organization_bytes: string | number;
        largest_workspace_bytes: string | number;
      }>(
        `SELECT
           coalesce((
             SELECT sum(blob.plaintext_bytes)
             FROM workspace_blobs blob
             WHERE blob.org_id = $1 AND blob.state IN (
               'pending_upload', 'available', 'quarantined', 'deleting'
             )
           ), 0) + coalesce((
             SELECT sum(job.reserved_bytes)
             FROM workspace_blob_rotation_jobs job
             WHERE job.org_id = $1
           ), 0) + coalesce((
             SELECT sum(deletion.reserved_bytes)
             FROM workspace_blob_object_deletions deletion
             WHERE deletion.org_id = $1
           ), 0) AS organization_bytes,
           coalesce((
             SELECT max(workspace_bytes) FROM (
               SELECT sum(reservation.reserved_bytes) AS workspace_bytes
               FROM workspace_blob_storage_reservations reservation
               WHERE reservation.org_id = $1
               GROUP BY reservation.workspace_id
             ) usage_by_workspace
           ), 0) AS largest_workspace_bytes`,
        [request.organizationId],
      )
    ).rows[0]!;
    if (
      Number(usage.organization_bytes) > request.next.maxOrganizationBytes ||
      Number(usage.largest_workspace_bytes) > request.next.maxWorkspaceBytes
    ) {
      throw new CloudWorkspaceObjectStorageManagementError(
        "Requested object-storage limits are below current durable usage or reservations",
      );
    }

    const approval = cloudWorkspaceObjectStorageApprovalText(request, previous);
    const unchanged =
      previous !== null &&
      previous.maxOrganizationBytes === request.next.maxOrganizationBytes &&
      previous.maxWorkspaceBytes === request.next.maxWorkspaceBytes;
    if (unchanged) {
      if (request.execute) {
        throw new CloudWorkspaceObjectStorageManagementError(
          "Object-storage limits already match; generate a fresh plan",
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
      throw new CloudWorkspaceObjectStorageManagementError(
        "CONTROL_PLANE_CLOUD_OBJECT_STORAGE_APPROVAL does not match the current target-bound plan",
      );
    }

    await client.query(
      `INSERT INTO cloud_workspace_object_storage_limits (
         org_id, max_organization_bytes, max_workspace_bytes, updated_by,
         updated_at
       ) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (org_id) DO UPDATE
       SET max_organization_bytes = EXCLUDED.max_organization_bytes,
           max_workspace_bytes = EXCLUDED.max_workspace_bytes,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
      [
        request.organizationId,
        request.next.maxOrganizationBytes,
        request.next.maxWorkspaceBytes,
        request.actorUserId,
      ],
    );
    await client.query(
      `INSERT INTO cloud_workspace_object_storage_limit_changes (
         org_id, actor_user_id, previous_organization_bytes,
         previous_workspace_bytes, next_organization_bytes,
         next_workspace_bytes, deployment_channel, target_fingerprint,
         database_principal, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        request.organizationId,
        request.actorUserId,
        previous?.maxOrganizationBytes ?? null,
        previous?.maxWorkspaceBytes ?? null,
        request.next.maxOrganizationBytes,
        request.next.maxWorkspaceBytes,
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new CloudWorkspaceObjectStorageManagementError(
      "DATABASE_URL is required",
    );
  }
  const request = validateCloudWorkspaceObjectStorageRequest({
    databaseUrl,
    channel: process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: process.argv.includes("--execute"),
    productionConfirmed:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_PRODUCTION_CONFIRMED,
    approval: process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_APPROVAL,
    organizationId:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_ORGANIZATION_ID,
    expectedOrganizationSlug:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_EXPECTED_ORGANIZATION_SLUG,
    actorUserId: process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_ACTOR_USER_ID,
    maxOrganizationBytes:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_MAX_ORGANIZATION_BYTES,
    maxWorkspaceBytes:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_MAX_WORKSPACE_BYTES,
    reason: process.env.CONTROL_PLANE_CLOUD_OBJECT_STORAGE_REASON,
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await manageCloudWorkspaceObjectStorage(pool, request);
    console.log(
      `[cloud-object-storage] state=${result.state} channel=${request.channel} ` +
        `target=${result.targetFingerprint} organization=${result.organizationId} ` +
        `actor=${result.actorUserId} previous=${label(result.previous)} ` +
        `next=${label(result.next)}`,
    );
    if (result.approval) {
      console.log(`[cloud-object-storage] approval=${result.approval}`);
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
      `[cloud-object-storage] failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    process.exitCode = 1;
  });
}
