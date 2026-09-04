import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { runMigrations } from "../migrate.js";
import {
  CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH,
  CloudWorkspaceEngineClientAdmissionError,
  DatabaseCloudWorkspaceEngineClientAdmissionService,
} from "./engine-client-admission.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

describe("cloud workspace engine client admission failures", () => {
  it("preserves unexpected infrastructure failures as retryable transport errors", async () => {
    const unavailable = new Error("database temporarily unavailable");
    const pool = {
      connect: vi.fn(async () => {
        throw unavailable;
      }),
    } as unknown as pg.Pool;
    const service = new DatabaseCloudWorkspaceEngineClientAdmissionService({
      pool,
      endpoint: `https://api.example.test${CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH}`,
      enginePort: 39_393,
      workosEnabled: false,
    });

    await expect(
      service.consume({
        token: `zws_${"A".repeat(43)}`,
        heartbeatToken: `zwh_${"B".repeat(43)}`,
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        generation: 1,
        engineInstanceId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toBe(unavailable);
  });
});

d("cloud workspace engine client admission", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let service: DatabaseCloudWorkspaceEngineClientAdmissionService;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudWorkspaceEngineClientAdmissionService({
      pool,
      endpoint: `https://api.example.test${CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH}`,
      enginePort: 39_393,
      ttlSeconds: 60,
      workosEnabled: false,
    });
  });

  const issue = () =>
    service.issue({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
    });

  it("binds a one-use capability to the exact live engine and authority epoch", async () => {
    const document = await issue();
    expect(document).toMatchObject({
      version: 1,
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      authorityEpoch: 1,
      engineInstanceId: fixture.engineInstanceId,
      remotePort: 39_393,
    });
    expect(document.grantToken).toMatch(/^zws_[A-Za-z0-9_-]{43}$/);
    const stored = await pool.query<{
      token_hash: Buffer;
      authority_epoch: string | number;
      engine_instance_id: string;
    }>(
      `SELECT token_hash, authority_epoch, engine_instance_id
       FROM cloud_workspace_endpoint_grants
       WHERE purpose = 'engine-connect' AND consumed_at IS NULL
         AND revoked_at IS NULL`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(
      stored.rows[0]!.token_hash.equals(
        createHash("sha256").update(document.grantToken).digest(),
      ),
    ).toBe(true);
    expect(Number(stored.rows[0]!.authority_epoch)).toBe(1);
    expect(stored.rows[0]!.engine_instance_id).toBe(fixture.engineInstanceId);

    const admitted = await service.consume({
      token: document.grantToken,
      heartbeatToken: fixture.heartbeatToken,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
    });
    expect(admitted).toMatchObject({
      admitted: true,
      authorityEpoch: 1,
      accountUserId: fixture.userId,
    });
    await expect(
      service.consume({
        token: document.grantToken,
        heartbeatToken: fixture.heartbeatToken,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
      }),
    ).rejects.toMatchObject<Partial<CloudWorkspaceEngineClientAdmissionError>>({
      code: "engine_client_admission_rejected",
    });
  });

  it("rolls back consumption on bad engine proof and rejects an old authority epoch", async () => {
    const first = await issue();
    await expect(
      service.consume({
        token: first.grantToken,
        heartbeatToken: `zwh_${"A".repeat(43)}`,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
      }),
    ).rejects.toMatchObject({ code: "engine_client_admission_rejected" });
    await expect(
      service.consume({
        token: first.grantToken,
        heartbeatToken: fixture.heartbeatToken,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
      }),
    ).resolves.toMatchObject({ admitted: true });

    const stale = await issue();
    await pool.query(
      `UPDATE cloud_workspaces
       SET authority_epoch = authority_epoch + 1
       WHERE id = $1`,
      [fixture.workspaceId],
    );
    await expect(
      service.consume({
        token: stale.grantToken,
        heartbeatToken: fixture.heartbeatToken,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        generation: 1,
        engineInstanceId: fixture.engineInstanceId,
      }),
    ).rejects.toMatchObject({ code: "engine_client_admission_rejected" });
  });
});
