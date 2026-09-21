import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { runMigrations } from "../migrate.js";
import { withSystemTx, withUserTx } from "../db.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import type { CloudCommandEngineScope } from "./commands.js";
import { DatabaseCloudWorkspaceActionService } from "./action-receipts.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("durable cloud decision and steering receipts", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, scope: CloudCommandEngineScope, service: DatabaseCloudWorkspaceActionService;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool); fixture = await seedReadyCloudWorkspace(pool);
    scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
    service = new DatabaseCloudWorkspaceActionService({ pool });
  });
  const input = () => ({ kind: "begin", admissible: true, action: { operationId: randomUUID(), conversationId: "chat",
    executionId: "execution", kind: "permission", requestId: randomUUID(), payload: { response: { outcome: "cancelled" } } } });

  it("stores intent before delivery and binds all retries to identical content", async () => {
    const request = input(); const first = await service.request(scope, request);
    expect(first).toMatchObject({ state: "dispatching", replayed: false, outcome: null });
    expect(await service.request(scope, { ...request, admissible: false })).toMatchObject({ state: "dispatching", replayed: true, claimId: first.claimId });
    const result = { kind: "settle", operationId: first.operationId, claimId: first.claimId, outcome: "delivered", turnId: null };
    expect(await service.request(scope, result)).toMatchObject({ state: "settled", outcome: "delivered" });
    expect(await service.request(scope, result)).toMatchObject({ replayed: true });
    expect(await service.request(scope, { kind: "read", operationId: first.operationId })).toMatchObject({ state: "settled" });
    await expect(service.request(scope, { ...request, action: { ...request.action, payload: { changed: true } } })).rejects.toMatchObject({ code: "command_conflict" });
    await expect(service.request(scope, { ...result, outcome: "queued" })).rejects.toMatchObject({ code: "command_conflict" });
    await expect(service.request(scope, { ...input(), admissible: false })).rejects.toMatchObject({ code: "command_context_changed" });
  });
  it("serializes competing devices answering the same native request", async () => {
    const a = input(); const b = { ...a, action: { ...a.action, operationId: randomUUID() } };
    const results = await Promise.allSettled([service.request(scope, a), service.request(scope, b)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("never treats another engine's dispatching action as resendable", async () => {
    const begun = await service.request(scope, input());
    const oldId = randomUUID(), grantId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_endpoint_grants SELECT
        (jsonb_populate_record(NULL::cloud_workspace_endpoint_grants,to_jsonb(g)||jsonb_build_object('id',$2::text,'token_hash',$3::bytea))).*
        FROM cloud_workspace_endpoint_grants g WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)`,
      [scope.engineInstanceId, grantId, randomBytes(32)]);
      await tx.query(`INSERT INTO cloud_workspace_engine_instances SELECT
        (jsonb_populate_record(NULL::cloud_workspace_engine_instances,to_jsonb(e)||jsonb_build_object('id',$2::text,'registration_grant_id',$3::text,
        'bridge_token_hash',$4::bytea,'heartbeat_token_hash',$5::bytea,'state','revoked','revoked_at',now()))).*
        FROM cloud_workspace_engine_instances e WHERE id=$1`, [scope.engineInstanceId, oldId, grantId, randomBytes(32), randomBytes(32)]);
      await tx.query(`UPDATE cloud_workspace_action_receipts SET engine_instance_id=$2 WHERE workspace_id=$1`, [scope.workspaceId, oldId]);
    });
    expect(await service.request(scope, { kind: "read", operationId: begun.operationId })).toMatchObject({ state: "uncertain", outcome: "interrupted" });
    await expect(service.request(scope, { kind: "settle", operationId: begun.operationId, claimId: begun.claimId, outcome: "delivered", turnId: null })).rejects.toMatchObject({ code: "command_conflict" });
  });
  it("rejects stale authority, conceals receipts from ordinary SQL readers, and purges with their owner", async () => {
    const receipt = await service.request(scope, input());
    await expect(service.request({ ...scope, generation: 2 }, { kind: "read", operationId: receipt.operationId })).rejects.toThrow("authority");
    expect((await withUserTx(pool, fixture.userId, tx => tx.query("SELECT * FROM cloud_workspace_action_receipts"))).rows).toEqual([]);
    await withSystemTx(pool, tx => tx.query("DELETE FROM cloud_workspaces WHERE id=$1", [scope.workspaceId]));
    expect((await withSystemTx(pool, tx => tx.query("SELECT * FROM cloud_workspace_action_receipts"))).rows).toEqual([]);
  });
  it("rejects oversized or hostile payloads before retaining any intent", async () => {
    const request = input();
    await expect(service.request(scope, { ...request, action: { ...request.action, payload: { text: "x".repeat(200000) } } })).rejects.toMatchObject({ code: "command_limit" });
    await expect(service.request(scope, { ...request, action: { ...request.action, payload: JSON.parse('{"__proto__":{}}') } })).rejects.toMatchObject({ code: "invalid_command" });
    expect((await withSystemTx(pool, tx => tx.query("SELECT * FROM cloud_workspace_action_receipts"))).rows).toEqual([]);
  });
});
