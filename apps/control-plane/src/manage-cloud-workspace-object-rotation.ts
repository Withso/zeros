// Guarded database-owner utility for retrying one exact terminal object-key
// rotation failure. The default is a read-only, target-bound plan. Execution
// requires the same database snapshot plus explicit approval and appends
// immutable owner-only evidence before the transaction commits.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

const CHANNELS = ["development", "alpha", "beta", "production"] as const;
const UUID = z.string().uuid();
const SLUG = z.string().trim().min(1).max(255);
const REASON = z.string().trim().min(16).max(512);
const KEY_VERSION = z.coerce.number().int().min(1).max(65_535);
const ENCODED_KEY = /^[A-Za-z0-9_-]{43}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{2,127}$/;

export interface CloudWorkspaceObjectRotationRetryInput {
  databaseUrl: string;
  channel: string | undefined;
  railwayEnvironmentName?: string | undefined;
  execute: boolean;
  productionConfirmed?: string | undefined;
  approval?: string | undefined;
  organizationId: string | undefined;
  expectedOrganizationSlug: string | undefined;
  blobId: string | undefined;
  targetKeyVersion: string | undefined;
  actorUserId: string | undefined;
  reason: string | undefined;
  objectKeyV1?: string | undefined;
  objectKeysJson?: string | undefined;
  currentObjectKeyVersion: string | undefined;
}

export interface ValidatedCloudWorkspaceObjectRotationRetry {
  databaseUrl: string;
  channel: (typeof CHANNELS)[number];
  execute: boolean;
  approval: string | null;
  organizationId: string;
  expectedOrganizationSlug: string;
  blobId: string;
  targetKeyVersion: number;
  actorUserId: string;
  reason: string;
  targetFingerprint: string;
  configuredKeyVersions: readonly number[];
}

export interface CloudWorkspaceObjectRotationRetryResult {
  state: "planned" | "changed";
  organizationId: string;
  blobId: string;
  targetKeyVersion: number;
  priorAttemptCount: number;
  priorErrorCode: string;
  snapshotFingerprint: string;
  targetFingerprint: string;
  nextTargetFingerprint: string | null;
  approval: string | null;
}

type RotationSnapshotRow = {
  state: string;
  attempt_count: number;
  error_code: string | null;
  completed_at: Date | string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  reserved_bytes: string | number;
  source_object_key: string;
  target_object_key: string;
  target_nonce: Buffer;
  blob_state: string;
  blob_object_key: string;
  blob_key_version: number;
  plaintext_bytes: string | number;
};

type DeletionFenceRow = {
  revision: string | number;
  reserved_bytes: string | number;
  fenced_at: Date | string | null;
  last_error_code: string | null;
};

export class CloudWorkspaceObjectRotationManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudWorkspaceObjectRotationManagementError";
  }
}

function databaseTarget(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new CloudWorkspaceObjectRotationManagementError(
      "Invalid object-rotation configuration: DATABASE_URL must be a PostgreSQL URL",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "Invalid object-rotation configuration: DATABASE_URL must identify one PostgreSQL database",
    );
  }
  return parsed;
}

function targetFingerprint(databaseUrl: string, channel: string): string {
  const parsed = databaseTarget(databaseUrl);
  return createHash("sha256")
    .update(
      [
        "zeros-control-plane-cloud-object-rotation-retry.v1",
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

function objectKeyFingerprint(objectKey: string): Buffer {
  return createHash("sha256").update(objectKey, "utf8").digest();
}

function assertEncodedKey(value: unknown, name: string): void {
  if (typeof value !== "string" || !ENCODED_KEY.test(value)) {
    throw new CloudWorkspaceObjectRotationManagementError(
      `${name} must be one canonical 32-byte base64url key`,
    );
  }
  const decoded = Buffer.from(value, "base64url");
  const canonical =
    decoded.length === 32 && decoded.toString("base64url") === value;
  decoded.fill(0);
  if (!canonical) {
    throw new CloudWorkspaceObjectRotationManagementError(
      `${name} must be one canonical 32-byte base64url key`,
    );
  }
}

function configuredKeyVersions(input: {
  objectKeyV1?: string | undefined;
  objectKeysJson?: string | undefined;
}): readonly number[] {
  const keys = new Map<number, string>();
  const encodedDocument = input.objectKeysJson?.trim();
  if (encodedDocument) {
    if (encodedDocument.length > 16 * 1024) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "CLOUD_WORKSPACE_OBJECT_KEYS_JSON must not exceed 16 KiB",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(encodedDocument);
    } catch {
      throw new CloudWorkspaceObjectRotationManagementError(
        "CLOUD_WORKSPACE_OBJECT_KEYS_JSON must be a JSON object",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "CLOUD_WORKSPACE_OBJECT_KEYS_JSON must be a JSON object",
      );
    }
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > 32) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "CLOUD_WORKSPACE_OBJECT_KEYS_JSON must contain 1 to 32 key versions",
      );
    }
    for (const [rawVersion, value] of entries) {
      if (!/^[1-9][0-9]{0,4}$/.test(rawVersion)) {
        throw new CloudWorkspaceObjectRotationManagementError(
          "CLOUD_WORKSPACE_OBJECT_KEYS_JSON contains an invalid key version",
        );
      }
      const version = Number(rawVersion);
      if (!Number.isSafeInteger(version) || version > 65_535) {
        throw new CloudWorkspaceObjectRotationManagementError(
          "CLOUD_WORKSPACE_OBJECT_KEYS_JSON contains an invalid key version",
        );
      }
      assertEncodedKey(value, `CLOUD_WORKSPACE_OBJECT_KEYS_JSON.${rawVersion}`);
      keys.set(version, value as string);
    }
  }
  const encodedV1 = input.objectKeyV1?.trim();
  if (encodedV1) {
    assertEncodedKey(encodedV1, "CLOUD_WORKSPACE_OBJECT_KEY_V1");
    const configuredV1 = keys.get(1);
    if (configuredV1 && configuredV1 !== encodedV1) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "Conflicting object key version 1",
      );
    }
    keys.set(1, encodedV1);
  }
  if (keys.size === 0) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "The cloud object encryption keyring is required",
    );
  }
  return [...keys.keys()].sort((left, right) => left - right);
}

export function validateCloudWorkspaceObjectRotationRetry(
  input: CloudWorkspaceObjectRotationRetryInput,
): ValidatedCloudWorkspaceObjectRotationRetry {
  const channel = input.channel?.trim().toLowerCase() ?? "";
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "CONTROL_PLANE_CLOUD_OBJECT_ROTATION_CHANNEL must be development, alpha, beta, or production",
    );
  }
  const railwayEnvironment = input.railwayEnvironmentName?.trim().toLowerCase();
  if (railwayEnvironment && railwayEnvironment !== channel) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "Object-rotation channel does not match RAILWAY_ENVIRONMENT_NAME",
    );
  }
  if (
    input.execute &&
    channel === "production" &&
    input.productionConfirmed !== "true"
  ) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "CONTROL_PLANE_CLOUD_OBJECT_ROTATION_PRODUCTION_CONFIRMED=true is required for production confirmation",
    );
  }
  const organizationId = UUID.safeParse(input.organizationId);
  const expectedOrganizationSlug = SLUG.safeParse(
    input.expectedOrganizationSlug,
  );
  const blobId = UUID.safeParse(input.blobId);
  const actorUserId = UUID.safeParse(input.actorUserId);
  const targetKeyVersion = KEY_VERSION.safeParse(input.targetKeyVersion);
  const currentKeyVersion = KEY_VERSION.safeParse(
    input.currentObjectKeyVersion,
  );
  const reason = REASON.safeParse(input.reason);
  if (!organizationId.success || !blobId.success || !actorUserId.success) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "Object-rotation Organization, blob, and actor must be exact UUIDs",
    );
  }
  if (!expectedOrganizationSlug.success) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "CONTROL_PLANE_CLOUD_OBJECT_ROTATION_EXPECTED_ORGANIZATION_SLUG is required",
    );
  }
  if (!targetKeyVersion.success || !currentKeyVersion.success) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "Object-rotation target and current key versions must be integers from 1 through 65535",
    );
  }
  if (targetKeyVersion.data !== currentKeyVersion.data) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "Object-rotation retry target must equal CLOUD_WORKSPACE_OBJECT_CURRENT_KEY_VERSION",
    );
  }
  if (!reason.success) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "CONTROL_PLANE_CLOUD_OBJECT_ROTATION_REASON must contain 16 to 512 characters",
    );
  }
  const versions = configuredKeyVersions(input);
  if (!versions.includes(targetKeyVersion.data)) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "The current object-rotation target key is absent from the configured keyring",
    );
  }
  return {
    databaseUrl: input.databaseUrl,
    channel: channel as ValidatedCloudWorkspaceObjectRotationRetry["channel"],
    execute: input.execute,
    approval: input.approval?.trim() || null,
    organizationId: organizationId.data,
    expectedOrganizationSlug: expectedOrganizationSlug.data.toLowerCase(),
    blobId: blobId.data,
    targetKeyVersion: targetKeyVersion.data,
    actorUserId: actorUserId.data,
    reason: reason.data,
    targetFingerprint: targetFingerprint(input.databaseUrl, channel),
    configuredKeyVersions: versions,
  };
}

function instant(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function rotationSnapshotFingerprint(
  job: RotationSnapshotRow,
  fence: DeletionFenceRow,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        job.state,
        job.attempt_count,
        job.error_code,
        instant(job.completed_at),
        job.lease_owner,
        instant(job.lease_expires_at),
        String(job.reserved_bytes),
        job.source_object_key,
        job.target_object_key,
        job.target_nonce.toString("hex"),
        job.blob_state,
        job.blob_object_key,
        job.blob_key_version,
        String(job.plaintext_bytes),
        String(fence.revision),
        String(fence.reserved_bytes),
        instant(fence.fenced_at),
        fence.last_error_code,
      ]),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

export function cloudWorkspaceObjectRotationRetryApprovalText(
  request: ValidatedCloudWorkspaceObjectRotationRetry,
  snapshotFingerprint: string,
): string {
  return [
    "cloud-object-rotation-retry",
    "v1",
    request.channel,
    request.targetFingerprint,
    request.organizationId,
    request.actorUserId,
    request.blobId,
    `k${request.targetKeyVersion}`,
    snapshotFingerprint,
    reasonFingerprint(request.reason),
  ].join(":");
}

function assertRetryableRotation(
  request: ValidatedCloudWorkspaceObjectRotationRetry,
  job: RotationSnapshotRow | undefined,
  fence: DeletionFenceRow | undefined,
): asserts job is RotationSnapshotRow {
  if (!job || !fence) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "The exact failed rotation and its durable target fence are required",
    );
  }
  if (
    job.state !== "failed" ||
    job.attempt_count < 1 ||
    !job.error_code ||
    !ERROR_CODE.test(job.error_code) ||
    job.completed_at === null ||
    job.lease_owner !== null ||
    job.lease_expires_at !== null ||
    Number(job.reserved_bytes) !== 0
  ) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "The exact rotation job is not a terminal, fully released failure",
    );
  }
  if (
    job.blob_state !== "available" ||
    job.blob_object_key !== job.source_object_key ||
    job.blob_key_version >= request.targetKeyVersion ||
    !request.configuredKeyVersions.includes(job.blob_key_version)
  ) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "The source blob is unavailable, changed, or missing its configured key",
    );
  }
  if (
    fence.fenced_at === null ||
    Number(fence.reserved_bytes) !== 0 ||
    fence.last_error_code !== null ||
    Number(fence.revision) < 1
  ) {
    throw new CloudWorkspaceObjectRotationManagementError(
      "The prior failed rotation target is not durably fenced",
    );
  }
}

export async function manageCloudWorkspaceObjectRotationRetry(
  pool: pg.Pool,
  request: ValidatedCloudWorkspaceObjectRotationRetry,
): Promise<CloudWorkspaceObjectRotationRetryResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('app.system', 'on', true)");

    const privilege = await client.query<{
      principal: string;
      owns_jobs: boolean;
      owns_evidence: boolean;
      can_update_jobs: boolean;
      can_write_evidence: boolean;
    }>(
      `SELECT current_user AS principal,
              pg_get_userbyid(jobs.relowner) = current_user AS owns_jobs,
              pg_get_userbyid(evidence.relowner) = current_user AS owns_evidence,
              has_table_privilege(current_user,
                'public.workspace_blob_rotation_jobs', 'UPDATE'
              ) AS can_update_jobs,
              has_table_privilege(current_user,
                'public.cloud_workspace_object_rotation_retry_changes', 'INSERT'
              ) AS can_write_evidence
       FROM pg_class jobs CROSS JOIN pg_class evidence
       WHERE jobs.oid = 'public.workspace_blob_rotation_jobs'::regclass
         AND evidence.oid =
           'public.cloud_workspace_object_rotation_retry_changes'::regclass`,
    );
    const owner = privilege.rows[0];
    if (
      !owner ||
      owner.principal === "zeros_app" ||
      !owner.owns_jobs ||
      !owner.owns_evidence ||
      !owner.can_update_jobs ||
      !owner.can_write_evidence
    ) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "Object-rotation retry requires the database/migration owner; the application role is refused",
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
      throw new CloudWorkspaceObjectRotationManagementError(
        "Object-rotation actor must be one active Zeros platform owner",
      );
    }

    const organization = (
      await client.query<{
        slug: string;
        is_personal: boolean;
        lifecycle_status: string;
        deleted_at: Date | string | null;
      }>(
        `SELECT slug::text, is_personal, lifecycle_status, deleted_at
         FROM organizations WHERE id = $1 FOR UPDATE`,
        [request.organizationId],
      )
    ).rows[0];
    if (
      !organization ||
      organization.slug.toLowerCase() !== request.expectedOrganizationSlug ||
      organization.is_personal ||
      organization.lifecycle_status !== "active" ||
      organization.deleted_at !== null
    ) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "Object-rotation target must be the exact active non-Personal Organization",
      );
    }

    const downgrade = await client.query(
      `SELECT 1 FROM workspace_blobs
       WHERE state = 'available' AND encryption_key_version > $1
       LIMIT 1`,
      [request.targetKeyVersion],
    );
    if (downgrade.rows[0]) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "The configured object key version would downgrade retained data",
      );
    }

    const job = (
      await client.query<RotationSnapshotRow>(
        `SELECT job.state, job.attempt_count, job.error_code,
                job.completed_at, job.lease_owner, job.lease_expires_at,
                job.reserved_bytes, job.source_object_key,
                job.target_object_key, job.target_nonce,
                blob.state AS blob_state, blob.object_key AS blob_object_key,
                blob.encryption_key_version AS blob_key_version,
                blob.plaintext_bytes
         FROM workspace_blob_rotation_jobs job
         JOIN workspace_blobs blob
           ON blob.id = job.blob_id AND blob.org_id = job.org_id
         WHERE job.org_id = $1 AND job.blob_id = $2
           AND job.target_key_version = $3
         FOR UPDATE OF job, blob`,
        [request.organizationId, request.blobId, request.targetKeyVersion],
      )
    ).rows[0];
    const fence = job
      ? (
          await client.query<DeletionFenceRow>(
            `SELECT revision, reserved_bytes, fenced_at, last_error_code
             FROM workspace_blob_object_deletions
             WHERE org_id = $1 AND blob_id = $2 AND object_key = $3
             FOR UPDATE`,
            [request.organizationId, request.blobId, job.target_object_key],
          )
        ).rows[0]
      : undefined;
    assertRetryableRotation(request, job, fence);
    const snapshotFingerprint = rotationSnapshotFingerprint(job, fence!);
    const approval = cloudWorkspaceObjectRotationRetryApprovalText(
      request,
      snapshotFingerprint,
    );
    const common = {
      organizationId: request.organizationId,
      blobId: request.blobId,
      targetKeyVersion: request.targetKeyVersion,
      priorAttemptCount: job.attempt_count,
      priorErrorCode: job.error_code!,
      snapshotFingerprint,
      targetFingerprint: request.targetFingerprint,
    };
    if (!request.execute) {
      await client.query("ROLLBACK");
      return {
        state: "planned",
        ...common,
        nextTargetFingerprint: null,
        approval,
      };
    }
    if (request.approval !== approval) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "CONTROL_PLANE_CLOUD_OBJECT_ROTATION_APPROVAL does not match the current target-bound plan",
      );
    }

    const changed = await client.query<{ target_object_key: string }>(
      `UPDATE workspace_blob_rotation_jobs
       SET state = 'queued', attempt_count = 0, error_code = NULL,
           completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
           source_object_key = $4,
           target_object_key =
             'workspace/v2/' || $1::uuid::text || '/' || $2::uuid::text ||
             '/k' || $3::integer::text || '-retry-' ||
             replace(gen_random_uuid()::text, '-', ''),
           target_nonce = gen_random_bytes(12)
       WHERE org_id = $1 AND blob_id = $2 AND target_key_version = $3
         AND state = 'failed' AND attempt_count = $5
         AND error_code = $6
         AND reserved_bytes = 0 AND source_object_key = $4
         AND target_object_key = $7 AND target_nonce = $8
         AND lease_owner IS NULL AND lease_expires_at IS NULL
       RETURNING target_object_key`,
      [
        request.organizationId,
        request.blobId,
        request.targetKeyVersion,
        job.blob_object_key,
        job.attempt_count,
        job.error_code,
        job.target_object_key,
        job.target_nonce,
      ],
    );
    if ((changed.rowCount ?? 0) !== 1) {
      throw new CloudWorkspaceObjectRotationManagementError(
        "Object-rotation retry plan became stale",
      );
    }
    const nextTarget = changed.rows[0]!.target_object_key;
    await client.query(
      `INSERT INTO cloud_workspace_object_rotation_retry_changes (
         org_id, blob_id, actor_user_id, target_key_version, source_key_version,
         prior_attempt_count, prior_error_code, prior_target_sha256,
         next_target_sha256, fence_revision, fence_fenced_at,
         job_snapshot_fingerprint, deployment_channel, target_fingerprint,
         database_principal, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16)`,
      [
        request.organizationId,
        request.blobId,
        request.actorUserId,
        request.targetKeyVersion,
        job.blob_key_version,
        job.attempt_count,
        job.error_code,
        objectKeyFingerprint(job.target_object_key),
        objectKeyFingerprint(nextTarget),
        Number(fence!.revision),
        fence!.fenced_at,
        snapshotFingerprint,
        request.channel,
        request.targetFingerprint,
        owner.principal,
        request.reason,
      ],
    );
    await client.query("COMMIT");
    return {
      state: "changed",
      ...common,
      nextTargetFingerprint: objectKeyFingerprint(nextTarget)
        .toString("hex")
        .slice(0, 16),
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
    throw new CloudWorkspaceObjectRotationManagementError(
      "DATABASE_URL is required",
    );
  }
  const request = validateCloudWorkspaceObjectRotationRetry({
    databaseUrl,
    channel: process.env.CONTROL_PLANE_CLOUD_OBJECT_ROTATION_CHANNEL,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    execute: process.argv.includes("--execute"),
    productionConfirmed:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_ROTATION_PRODUCTION_CONFIRMED,
    approval: process.env.CONTROL_PLANE_CLOUD_OBJECT_ROTATION_APPROVAL,
    organizationId:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_ROTATION_ORGANIZATION_ID,
    expectedOrganizationSlug:
      process.env
        .CONTROL_PLANE_CLOUD_OBJECT_ROTATION_EXPECTED_ORGANIZATION_SLUG,
    blobId: process.env.CONTROL_PLANE_CLOUD_OBJECT_ROTATION_BLOB_ID,
    targetKeyVersion:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_ROTATION_TARGET_KEY_VERSION,
    actorUserId:
      process.env.CONTROL_PLANE_CLOUD_OBJECT_ROTATION_ACTOR_USER_ID,
    reason: process.env.CONTROL_PLANE_CLOUD_OBJECT_ROTATION_REASON,
    objectKeyV1: process.env.CLOUD_WORKSPACE_OBJECT_KEY_V1,
    objectKeysJson: process.env.CLOUD_WORKSPACE_OBJECT_KEYS_JSON,
    currentObjectKeyVersion:
      process.env.CLOUD_WORKSPACE_OBJECT_CURRENT_KEY_VERSION,
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await manageCloudWorkspaceObjectRotationRetry(pool, request);
    console.log(
      `[cloud-object-rotation] state=${result.state} channel=${request.channel} ` +
        `target=${result.targetFingerprint} organization=${result.organizationId} ` +
        `blob=${result.blobId} keyVersion=${result.targetKeyVersion} ` +
        `snapshot=${result.snapshotFingerprint} attempts=${result.priorAttemptCount} ` +
        `error=${result.priorErrorCode}`,
    );
    if (result.nextTargetFingerprint) {
      console.log(
        `[cloud-object-rotation] nextTarget=${result.nextTargetFingerprint}`,
      );
    }
    if (result.approval) {
      console.log(`[cloud-object-rotation] approval=${result.approval}`);
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
      `[cloud-object-rotation] failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    process.exitCode = 1;
  });
}
