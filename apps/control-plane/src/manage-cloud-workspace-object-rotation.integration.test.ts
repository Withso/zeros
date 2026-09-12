import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import {
  manageCloudWorkspaceObjectRotationRetry,
  validateCloudWorkspaceObjectRotationRetry,
} from "./manage-cloud-workspace-object-rotation.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

async function seedFailedRotation(
  pool: pg.Pool,
  organizationId: string,
): Promise<{ blobId: string; sourceObjectKey: string; targetObjectKey: string }> {
  const blobId = randomUUID();
  const sourceObjectKey = `workspace/v2/${organizationId}/${blobId}/k1`;
  const targetObjectKey = `workspace/v2/${organizationId}/${blobId}/k2`;
  await pool.query(
    `INSERT INTO workspace_blobs (
       id, org_id, plaintext_sha256, ciphertext_sha256, plaintext_bytes,
       ciphertext_bytes, object_key, encryption_key_version, nonce, auth_tag,
       state, available_at
     ) VALUES ($1, $2, $3, $4, 128, 128, $5, 1, $6, $7,
               'available', now())`,
    [
      blobId,
      organizationId,
      randomBytes(32),
      randomBytes(32),
      sourceObjectKey,
      randomBytes(12),
      randomBytes(16),
    ],
  );
  await pool.query(
    `INSERT INTO workspace_blob_rotation_jobs (
       blob_id, org_id, target_key_version, source_object_key,
       target_object_key, target_nonce, state, attempt_count, error_code,
       completed_at, reserved_bytes
     ) VALUES ($1, $2, 2, $3, $4, $5, 'failed', 10,
               'object_store_unavailable', now(), 0)`,
    [
      blobId,
      organizationId,
      sourceObjectKey,
      targetObjectKey,
      randomBytes(12),
    ],
  );
  await pool.query(
    `INSERT INTO workspace_blob_object_deletions (
       object_key, org_id, blob_id, reserved_bytes, attempt_count, revision,
       last_error_code, fenced_at
     ) VALUES ($1, $2, $3, 0, 1, 2, NULL, now())`,
    [targetObjectKey, organizationId, blobId],
  );
  return { blobId, sourceObjectKey, targetObjectKey };
}

d("owner-managed cloud-workspace object-rotation retry", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("plans, target-binds, retries exactly one terminal job, and appends evidence", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [fixture.userId],
    );
    const failed = await seedFailedRotation(pool, fixture.organizationId);
    const untouched = await seedFailedRotation(pool, fixture.organizationId);
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const base = {
      databaseUrl: databaseUrl!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      organizationId: fixture.organizationId,
      expectedOrganizationSlug: `durable-${fixture.organizationId}`,
      blobId: failed.blobId,
      targetKeyVersion: "2",
      actorUserId: fixture.userId,
      reason: "Retry this reviewed terminal Alpha object-key rotation.",
      objectKeysJson: JSON.stringify({ 1: key1, 2: key2 }),
      currentObjectKeyVersion: "2",
    } as const;

    const plan = await manageCloudWorkspaceObjectRotationRetry(
      pool,
      validateCloudWorkspaceObjectRotationRetry(base),
    );
    expect(plan).toMatchObject({
      state: "planned",
      organizationId: fixture.organizationId,
      blobId: failed.blobId,
      targetKeyVersion: 2,
      priorAttemptCount: 10,
      priorErrorCode: "object_store_unavailable",
      nextTargetFingerprint: null,
    });
    expect(plan.approval).toMatch(/^cloud-object-rotation-retry:v1:/);
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM cloud_workspace_object_rotation_retry_changes`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(
      manageCloudWorkspaceObjectRotationRetry(
        pool,
        validateCloudWorkspaceObjectRotationRetry({
          ...base,
          execute: true,
          approval: `${plan.approval}-wrong`,
        }),
      ),
    ).rejects.toThrow(/approval/i);

    await expect(
      manageCloudWorkspaceObjectRotationRetry(
        pool,
        validateCloudWorkspaceObjectRotationRetry({
          ...base,
          execute: true,
          approval: plan.approval!,
        }),
      ),
    ).resolves.toMatchObject({ state: "changed", approval: null });

    const jobs = await pool.query<{
      blob_id: string;
      state: string;
      attempt_count: number;
      error_code: string | null;
      source_object_key: string;
      target_object_key: string;
    }>(
      `SELECT blob_id, state, attempt_count, error_code, source_object_key,
              target_object_key
       FROM workspace_blob_rotation_jobs
       WHERE blob_id IN ($1, $2)
       ORDER BY blob_id`,
      [failed.blobId, untouched.blobId],
    );
    const changed = jobs.rows.find((row) => row.blob_id === failed.blobId)!;
    const unchanged = jobs.rows.find((row) => row.blob_id === untouched.blobId)!;
    expect(changed).toMatchObject({
      state: "queued",
      attempt_count: 0,
      error_code: null,
      source_object_key: failed.sourceObjectKey,
    });
    expect(changed.target_object_key).toMatch(/\/k2-retry-[0-9a-f]{32}$/);
    expect(changed.target_object_key).not.toBe(failed.targetObjectKey);
    expect(unchanged).toMatchObject({
      state: "failed",
      attempt_count: 10,
      error_code: "object_store_unavailable",
      target_object_key: untouched.targetObjectKey,
    });

    const evidence = await pool.query<{
      org_id: string;
      blob_id: string;
      actor_user_id: string;
      source_key_version: number;
      prior_attempt_count: number;
      prior_error_code: string;
      fence_revision: string | number;
      fence_fenced_at: Date;
      reason: string;
    }>(
      `SELECT org_id, blob_id, actor_user_id, source_key_version,
              prior_attempt_count, prior_error_code, fence_revision,
              fence_fenced_at, reason
       FROM cloud_workspace_object_rotation_retry_changes`,
    );
    expect(evidence.rows).toEqual([
      {
        org_id: fixture.organizationId,
        blob_id: failed.blobId,
        actor_user_id: fixture.userId,
        source_key_version: 1,
        prior_attempt_count: 10,
        prior_error_code: "object_store_unavailable",
        fence_revision: "2",
        fence_fenced_at: expect.any(Date),
        reason: base.reason,
      },
    ]);
    await expect(
      pool.query(
        `UPDATE cloud_workspace_object_rotation_retry_changes
         SET reason = reason WHERE blob_id = $1`,
        [failed.blobId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      manageCloudWorkspaceObjectRotationRetry(
        pool,
        validateCloudWorkspaceObjectRotationRetry({
          ...base,
          execute: true,
          approval: plan.approval!,
        }),
      ),
    ).rejects.toThrow(/failed rotation|terminal/i);
  });

  it("refuses an unfenced target and keeps retry evidence inaccessible to the app role", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [fixture.userId],
    );
    const failed = await seedFailedRotation(pool, fixture.organizationId);
    await pool.query(
      `UPDATE workspace_blob_object_deletions
       SET fenced_at = NULL, revision = revision + 1
       WHERE object_key = $1`,
      [failed.targetObjectKey],
    );
    const key1 = randomBytes(32).toString("base64url");
    const key2 = randomBytes(32).toString("base64url");
    const request = validateCloudWorkspaceObjectRotationRetry({
      databaseUrl: databaseUrl!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      organizationId: fixture.organizationId,
      expectedOrganizationSlug: `durable-${fixture.organizationId}`,
      blobId: failed.blobId,
      targetKeyVersion: "2",
      actorUserId: fixture.userId,
      reason: "Refuse retry until the exact failed target is durably fenced.",
      objectKeysJson: JSON.stringify({ 1: key1, 2: key2 }),
      currentObjectKeyVersion: "2",
    });
    await expect(
      manageCloudWorkspaceObjectRotationRetry(pool, request),
    ).rejects.toThrow(/durably fenced/i);
    await pool.query(
      `UPDATE workspace_blob_object_deletions
       SET fenced_at = now(), last_error_code = NULL
       WHERE object_key = $1`,
      [failed.targetObjectKey],
    );
    await pool.query(
      `UPDATE workspace_blob_rotation_jobs SET error_code = 'Legacy error!'
       WHERE blob_id = $1 AND target_key_version = 2`,
      [failed.blobId],
    );
    await expect(
      manageCloudWorkspaceObjectRotationRetry(pool, request),
    ).rejects.toThrow(/terminal.*failure/i);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE zeros_app");
      await client.query("SELECT set_config('app.system', 'on', true)");
      await expect(
        client.query(
          `SELECT * FROM cloud_workspace_object_rotation_retry_changes`,
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
