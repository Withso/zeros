import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations } from "../migrate.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";
import { DatabaseCloudRuntimeAccessAdmissionService } from "./runtime-access-admission.js";
import {withSystemTx} from "../db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("runtime access admission", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let service: DatabaseCloudRuntimeAccessAdmissionService;
  let grantId: string;
  const token = `zwp_${"A".repeat(43)}`;
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
    service = new DatabaseCloudRuntimeAccessAdmissionService({
      pool,
      workosEnabled: false,
    });
    grantId = randomUUID();
    await pool.query(
      `INSERT INTO cloud_workspace_client_access_grants (
      id, workspace_id, org_id, generation, account_user_id, kind, remote_port,
      provider_resource_id, token_hash, state, expires_at, idempotency_key,
      request_sha256, preview_proxy_label, issued_at, requested_expires_at
    ) VALUES ($1,$2,$3,1,$4,'preview',3000,$5,$6,'active',now()+interval '1 minute',
      $1::uuid::text, $7, $8, now(), now()+interval '1 minute')`,
      [
        grantId,
        fixture.workspaceId,
        fixture.organizationId,
        fixture.userId,
        `sandbox-${fixture.workspaceId}`,
        createHash("sha256").update(token).digest(),
        Buffer.alloc(32, 1),
        "b".repeat(32),
      ],
    );
    await withSystemTx(pool,tx=>tx.query("UPDATE cloud_workspace_client_access_grants SET actor_fingerprint=cloud_workspace_actor_fingerprint(workspace_id,account_user_id) WHERE id=$1",[grantId]));
  });
  const input = () => ({
    workspaceId: fixture.workspaceId,
    organizationId: fixture.organizationId,
    generation: 1,
    engineInstanceId: fixture.engineInstanceId,
    heartbeatToken: fixture.heartbeatToken,
    token,
  });

  it("requires both current engine authority and a live user grant on every request", async () => {
    const admitted = await service.admit(input());
    expect(admitted).toMatchObject({
      version: 1,
      admitted: true,
      kind: "preview",
      remotePort: 3000,
      grantId,
      accountUserId: fixture.userId,
      authorityEpoch: 1,
    });
    expect(admitted.expiresAtMs).toBeGreaterThan(Date.now());
    expect(admitted).not.toHaveProperty("leaseDurationMs");
    await expect(service.admit({ ...input(), relativeLease: true })).resolves.toMatchObject({ leaseDurationMs: 10_000 });
    expect(JSON.stringify(admitted)).not.toContain(token);
    await expect(service.admit(input())).resolves.toMatchObject({ grantId });
    await pool.query(
      "UPDATE cloud_workspace_client_access_grants SET state = 'revoked', revoked_at = now() WHERE id = $1",
      [grantId],
    );
    await expect(service.admit(input())).rejects.toMatchObject({
      code: "runtime_access_rejected",
    });
  });

  it("rejects wrong engine, bearer, generation and owner without changing the grant", async () => {
    for (const change of [
      { heartbeatToken: `zwh_${"C".repeat(43)}` },
      { token: `zwp_${"C".repeat(43)}` },
      { generation: 2 },
      { engineInstanceId: randomUUID() },
      { organizationId: randomUUID() },
      { token: `zws_${"A".repeat(43)}` },
    ])
      await expect(
        service.admit({ ...input(), ...change }),
      ).rejects.toMatchObject({ code: "runtime_access_rejected" });
    await expect(service.admit(input())).resolves.toMatchObject({ grantId });
    await pool.query(
      "UPDATE cloud_workspaces SET desired_state = 'stopped' WHERE id = $1",
      [fixture.workspaceId],
    );
    await expect(service.admit(input())).rejects.toMatchObject({
      code: "runtime_access_rejected",
    });
  });

  it("denies expired access and revoked provider connections", async () => {
    await pool.query(
      "UPDATE cloud_workspace_client_access_grants SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 second' WHERE id = $1",
      [grantId],
    );
    await expect(service.admit(input())).rejects.toMatchObject({
      code: "runtime_access_rejected",
    });
    await pool.query(
      "UPDATE cloud_workspace_client_access_grants SET expires_at = now() + interval '1 minute' WHERE id = $1",
      [grantId],
    );
    await pool.query(
      "UPDATE provider_connections SET state = 'revoked', revoked_at = now() WHERE id IN (SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id = $1)",
      [fixture.workspaceId],
    );
    await expect(service.admit(input())).rejects.toMatchObject({
      code: "runtime_access_rejected",
    });
  });

  it("does not redeem legacy provider SSH credentials as native workload access", async () => {
    const legacyToken = `zsh_${"T".repeat(43)}`;
    await pool.query(
      `UPDATE cloud_workspace_client_access_grants SET kind = 'ssh', remote_port = NULL,
       preview_proxy_label = NULL, token_hash = $2 WHERE id = $1`,
      [grantId, createHash("sha256").update(legacyToken).digest()],
    );
    await expect(service.admit({ ...input(), token: legacyToken })).rejects.toMatchObject({ code: "runtime_access_rejected" });
  });
});
