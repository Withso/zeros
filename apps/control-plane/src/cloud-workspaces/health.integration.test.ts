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
});
