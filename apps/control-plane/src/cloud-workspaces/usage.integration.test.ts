import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { DatabaseCloudWorkspacePaidAuthorityReconciler } from "./paid-authority.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import {
  CloudWorkspaceUsageError,
  DatabaseCloudWorkspaceUsageService,
} from "./usage.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("immutable cloud workspace usage ingestion", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  it("snapshots the server-owned billing epoch and replays an exact source event", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const service = new DatabaseCloudWorkspaceUsageService(pool, false);
    const input = {
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      meter: "agent_input_token" as const,
      quantity: "123.500000",
      sourceIdempotencyKey: `agent:${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      metadata: { model: "provider/model", runId: randomUUID() },
    };

    const first = await service.ingestEngine(input);
    const replay = await service.ingestEngine(input);
    expect(first).toMatchObject({
      billingOwnerUserId: fixture.userId,
      billingEpoch: 1,
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });

    const row = (
      await pool.query<{
        billing_owner_user_id: string;
        actor_user_id: string;
        quantity: string;
        provider_connection_version: string;
      }>(
        `SELECT billing_owner_user_id, actor_user_id, quantity,
                provider_connection_version
         FROM cloud_workspace_usage_events WHERE id = $1`,
        [first.usageEventId],
      )
    ).rows[0];
    expect(row).toEqual({
      billing_owner_user_id: fixture.userId,
      actor_user_id: fixture.userId,
      quantity: "123.500000",
      provider_connection_version: "1",
    });
  });

  it("rejects idempotency reuse with different billable input", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const service = new DatabaseCloudWorkspaceUsageService(pool, false);
    const sourceIdempotencyKey = `agent:${randomUUID()}`;
    const base = {
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      meter: "agent_invocation" as const,
      sourceIdempotencyKey,
      occurredAt: new Date().toISOString(),
      metadata: {},
    };
    await service.ingestEngine({ ...base, quantity: 1 });
    await expect(
      service.ingestEngine({ ...base, quantity: 2 }),
    ).rejects.toMatchObject<Partial<CloudWorkspaceUsageError>>({
      code: "idempotency_conflict",
    });
  });

  it("attributes delayed usage to the billing epoch active when it occurred", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const occurredAt = new Date(Date.now() - 1_000).toISOString();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE workspace_billing_epochs
         SET started_at = now() - interval '1 hour'
         WHERE workspace_id = $1 AND billing_epoch = 1`,
        [fixture.workspaceId],
      );
      await tx.query(
        `UPDATE organization_entitlements
         SET revision = revision + 1, updated_at = now()
         WHERE org_id = $1`,
        [fixture.organizationId],
      );
    });
    await new DatabaseCloudWorkspacePaidAuthorityReconciler(pool, {
      workosEnabled: false,
    }).runOnce();

    const ingested = await new DatabaseCloudWorkspaceUsageService(
      pool,
      false,
    ).ingestEngine({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      meter: "agent_invocation",
      quantity: 1,
      sourceIdempotencyKey: `agent:${randomUUID()}`,
      occurredAt,
      metadata: {},
    });
    expect(ingested.billingEpoch).toBe(1);
  });

  it("fails closed after the engine lease or paid WorkOS authority is revoked", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const service = new DatabaseCloudWorkspaceUsageService(pool, true);
    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspace_engine_instances
         SET state = 'revoked', revoked_at = now(), lease_expires_at = now()
         WHERE id = $1`,
        [fixture.engineInstanceId],
      ),
    );
    await expect(
      service.ingestEngine({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
        heartbeatToken: fixture.heartbeatToken,
        meter: "agent_invocation",
        quantity: 1,
        sourceIdempotencyKey: `agent:${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        metadata: {},
      }),
    ).rejects.toMatchObject<Partial<CloudWorkspaceUsageError>>({
      code: "engine_authority_rejected",
    });
  });
});
