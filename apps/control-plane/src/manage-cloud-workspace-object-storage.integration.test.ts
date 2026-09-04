import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import { withSystemTx } from "./db.js";
import {
  manageCloudWorkspaceObjectStorage,
  validateCloudWorkspaceObjectStorageRequest,
} from "./manage-cloud-workspace-object-storage.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("owner-managed cloud-workspace object storage", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("plans, target-binds, audits, and refuses limits below durable usage", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [fixture.userId],
    );
    const base = {
      databaseUrl: databaseUrl!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      organizationId: fixture.organizationId,
      expectedOrganizationSlug: `durable-${fixture.organizationId}`,
      actorUserId: fixture.userId,
      maxOrganizationBytes: "1073741824",
      maxWorkspaceBytes: "536870912",
      reason: "Approve reviewed Alpha durable object-storage capacity.",
    } as const;

    const plan = await manageCloudWorkspaceObjectStorage(
      pool,
      validateCloudWorkspaceObjectStorageRequest(base),
    );
    expect(plan).toMatchObject({
      state: "planned",
      previous: {
        maxOrganizationBytes: 107_374_182_400,
        maxWorkspaceBytes: 10_737_418_240,
      },
    });
    await expect(
      manageCloudWorkspaceObjectStorage(
        pool,
        validateCloudWorkspaceObjectStorageRequest({
          ...base,
          execute: true,
          approval: `${plan.approval}-wrong`,
        }),
      ),
    ).rejects.toThrow(/approval/i);
    await expect(
      manageCloudWorkspaceObjectStorage(
        pool,
        validateCloudWorkspaceObjectStorageRequest({
          ...base,
          execute: true,
          approval: plan.approval!,
        }),
      ),
    ).resolves.toMatchObject({ state: "changed" });

    const evidence = await pool.query<{
      next_organization_bytes: string;
      next_workspace_bytes: string;
      reason: string;
    }>(
      `SELECT next_organization_bytes, next_workspace_bytes, reason
       FROM cloud_workspace_object_storage_limit_changes
       WHERE org_id = $1`,
      [fixture.organizationId],
    );
    expect(evidence.rows).toEqual([
      {
        next_organization_bytes: "1073741824",
        next_workspace_bytes: "536870912",
        reason: base.reason,
      },
    ]);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `UPDATE cloud_workspace_object_storage_limits
           SET max_workspace_bytes = max_workspace_bytes
           WHERE org_id = $1`,
          [fixture.organizationId],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);

    const blobId = randomUUID();
    await pool.query(
      `INSERT INTO workspace_blobs (
         id, org_id, plaintext_sha256, plaintext_bytes, object_key,
         encryption_key_version, nonce
       ) VALUES ($1, $2, $3, 128, $4, 1, $5)`,
      [
        blobId,
        fixture.organizationId,
        randomBytes(32),
        `workspace/v2/${fixture.organizationId}/${blobId}/k1`,
        randomBytes(12),
      ],
    );
    await pool.query(
      `INSERT INTO workspace_blob_storage_reservations (
         org_id, workspace_id, blob_id, reserved_bytes, state, expires_at
       ) VALUES ($1, $2, $3, 128, 'referenced', NULL)`,
      [fixture.organizationId, fixture.workspaceId, blobId],
    );
    await expect(
      manageCloudWorkspaceObjectStorage(
        pool,
        validateCloudWorkspaceObjectStorageRequest({
          ...base,
          maxOrganizationBytes: "127",
          maxWorkspaceBytes: "127",
        }),
      ),
    ).rejects.toThrow(/below current durable usage/i);
    await expect(
      pool.query(
        `UPDATE cloud_workspace_object_storage_limit_changes
         SET reason = reason WHERE org_id = $1`,
        [fixture.organizationId],
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it("does not deadlock an in-flight storage admission while planning a limit change", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [fixture.userId],
    );
    const admission = await pool.connect();
    const blobId = randomUUID();
    let plan: Promise<unknown> | null = null;
    try {
      await admission.query("BEGIN");
      await admission.query("SELECT set_config('app.system', 'on', true)");
      await admission.query(
        `SELECT id FROM organizations WHERE id = $1 FOR SHARE`,
        [fixture.organizationId],
      );
      await admission.query(
        `INSERT INTO workspace_blobs (
           id, org_id, plaintext_sha256, plaintext_bytes, object_key,
           encryption_key_version, nonce
         ) VALUES ($1, $2, $3, 128, $4, 1, $5)`,
        [
          blobId,
          fixture.organizationId,
          randomBytes(32),
          `workspace/v2/${fixture.organizationId}/${blobId}/k1`,
          randomBytes(12),
        ],
      );

      plan = manageCloudWorkspaceObjectStorage(
        pool,
        validateCloudWorkspaceObjectStorageRequest({
          databaseUrl: databaseUrl!,
          channel: "alpha",
          railwayEnvironmentName: "alpha",
          execute: false,
          productionConfirmed: undefined,
          approval: undefined,
          organizationId: fixture.organizationId,
          expectedOrganizationSlug: `durable-${fixture.organizationId}`,
          actorUserId: fixture.userId,
          maxOrganizationBytes: "1073741824",
          maxWorkspaceBytes: "536870912",
          reason: "Verify storage admission and operator lock ordering.",
        }),
      );
      void plan.catch(() => undefined);

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE pid <> pg_backend_pid() AND state = 'active'
             AND wait_event_type = 'Lock'
             AND query LIKE '%FROM organizations WHERE id = $1 FOR UPDATE%'`,
        );
        if ((waiting.rowCount ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (attempt === 99)
          throw new Error("operator did not reach Organization lock");
      }

      await admission.query(
        `SELECT reserve_workspace_blob_storage($1, $2, $3, true, 'uploading')`,
        [fixture.workspaceId, fixture.organizationId, blobId],
      );
      await admission.query("COMMIT");
      await expect(plan).resolves.toMatchObject({ state: "planned" });
    } finally {
      await admission.query("ROLLBACK").catch(() => undefined);
      await plan?.catch(() => undefined);
      admission.release();
    }
  });
});
