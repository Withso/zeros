import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../migrate.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("cloud workspace operational health", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  it("exposes configuration posture and bounded reason codes without tenant data", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const service = new DatabaseCloudWorkspaceHealthService(pool, {
      setupExecutionEnabled: false,
      durabilityEnabled: true,
      outboxDeliveryEnabled: false,
    });
    await expect(service.read()).resolves.toEqual({
      enabled: true,
      setupExecution: "paused",
      durability: "enabled",
      outboxDelivery: "retained",
      operationalState: "healthy",
      reasons: [],
    });

    await pool.query(
      `INSERT INTO workspace_deletion_jobs (
         workspace_id, org_id, requested_by, idempotency_key,
         state, completed_at, error_code
       ) VALUES ($1, $2, $3, 'health-delete-test', 'failed', now(),
                 'provider_delete_failed')`,
      [fixture.workspaceId, fixture.organizationId, fixture.userId],
    );
    const degraded = await service.read();
    expect(degraded).toMatchObject({
      operationalState: "degraded",
      reasons: ["deletion_jobs_failed"],
    });
    expect(JSON.stringify(degraded)).not.toContain(fixture.workspaceId);
    expect(JSON.stringify(degraded)).not.toContain(fixture.organizationId);
  });

  it("ignores setup-owned lease signals while setup execution is paused", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query(
      `UPDATE cloud_workspace_engine_instances
       SET last_heartbeat_at = now() - interval '2 minutes',
           lease_expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [fixture.engineInstanceId],
    );
    await pool.query(
       `INSERT INTO cloud_workspace_setup_runs (
         workspace_id, generation, org_id, attempt, state, execution_fence,
         lease_owner, lease_expires_at, last_heartbeat_at, started_at
       ) VALUES ($1, 1, $2, 2, 'running', 1, 'paused-worker',
                 now() - interval '1 minute', now() - interval '2 minutes',
                 now() - interval '2 minutes')`,
      [fixture.workspaceId, fixture.organizationId],
    );

    const paused = new DatabaseCloudWorkspaceHealthService(pool, {
      setupExecutionEnabled: false,
      durabilityEnabled: false,
      outboxDeliveryEnabled: false,
    });
    await expect(paused.read()).resolves.toMatchObject({
      operationalState: "healthy",
      reasons: [],
    });

    const enabled = new DatabaseCloudWorkspaceHealthService(pool, {
      setupExecutionEnabled: true,
      durabilityEnabled: false,
      outboxDeliveryEnabled: false,
    });
    await expect(enabled.read()).resolves.toMatchObject({
      operationalState: "degraded",
      reasons: ["setup_lease_expired", "engine_lease_expired"],
    });
  });

  it("reports repeatedly failing detached-object deletion even between retries", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const objectKey =
      `workspace/v2/${fixture.organizationId}/detached-health-object/k1`;
    await pool.query(
      `INSERT INTO workspace_blob_object_deletions (
         object_key, org_id, blob_id, reserved_bytes, attempt_count,
         next_attempt_at, last_error_code
       ) VALUES ($1, $2, $3, 128, 3, now() + interval '5 minutes',
                 'object_store_delete_failed')`,
      [objectKey, fixture.organizationId, fixture.workspaceId],
    );
    const service = new DatabaseCloudWorkspaceHealthService(pool, {
      setupExecutionEnabled: false,
      durabilityEnabled: true,
      outboxDeliveryEnabled: false,
    });

    const degraded = await service.read();
    expect(degraded).toMatchObject({
      operationalState: "degraded",
      reasons: ["object_deletion_stalled"],
    });
    expect(JSON.stringify(degraded)).not.toContain(objectKey);
    expect(JSON.stringify(degraded)).not.toContain(fixture.organizationId);
  });

  it("reports a repeatedly failing published-source cleanup", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const blobId = "71717171-7171-4171-8171-717171717171";
    const sourceKey =
      `workspace/v2/${fixture.organizationId}/${blobId}/k1`;
    const targetKey =
      `workspace/v2/${fixture.organizationId}/${blobId}/k2`;
    await pool.query(
      `INSERT INTO workspace_blobs (
         id, org_id, plaintext_sha256, ciphertext_sha256, plaintext_bytes,
         ciphertext_bytes, object_key, encryption_key_version, nonce, auth_tag,
         state, available_at
       ) VALUES (
         $1, $2, decode(repeat('31', 32), 'hex'),
         decode(repeat('32', 32), 'hex'), 16, 16, $3, 2,
         decode(repeat('33', 12), 'hex'), decode(repeat('34', 16), 'hex'),
         'available', now()
       )`,
      [blobId, fixture.organizationId, targetKey],
    );
    await pool.query(
      `INSERT INTO workspace_blob_rotation_jobs (
         blob_id, org_id, target_key_version, source_object_key,
         target_object_key, state, attempt_count, error_code, reserved_bytes
       ) VALUES ($1, $2, 2, $3, $4, 'cleanup_pending', 3,
                 'object_store_delete_failed', 16)`,
      [blobId, fixture.organizationId, sourceKey, targetKey],
    );
    const service = new DatabaseCloudWorkspaceHealthService(pool, {
      setupExecutionEnabled: false,
      durabilityEnabled: true,
      outboxDeliveryEnabled: false,
    });

    await expect(service.read()).resolves.toMatchObject({
      operationalState: "degraded",
      reasons: ["object_rotation_failed"],
    });
  });
});
