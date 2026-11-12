import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { sealPortToken } from "../worker-port-token.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("active direct sync authority", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool); await f.activate();
    await f.cp.store.setWorkerRoute(f.workspace.id, "bx_fixture1234", "https://worker.example.test/",
      sealPortToken("synthetic-sync-port-token", f.workspace.id, f.keys));
    expect((await f.hello(`${f.features},sync-v1,sync-context-v1`)).status).toBe(200);
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const mac = async (user = f.viewer) => {
    const deviceId = randomUUID();
    const response = await f.call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", {
      requestId: randomUUID(), name: "Fixture Mac", capabilities: ["local-commands-v1"],
    }, user);
    expect(response.status).toBe(200);
    const { device } = await response.json();
    const headers = { "x-zeros-device-id": deviceId, "x-zeros-device-registration": device.registrationId,
      "x-zeros-device-instance": device.instanceId };
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/macs/${deviceId}/connect`, "POST", {}, user, headers)).status).toBe(200);
    return { user, device, headers };
  };
  const grant = async (device: Awaited<ReturnType<typeof mac>>) => f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/sync/grant`, "POST", {}, device.user, device.headers);
  const claims = async (response: Response) => {
    expect(response.status).toBe(200);
    const reply = await response.json();
    return JSON.parse(Buffer.from(reply.grant.split(".")[1], "base64url").toString());
  };

  it("requires sync-context-v1 on the exact activated boot", async () => {
    expect((await f.hello(`${f.features},sync-v1`)).status).toBe(200);
    const response = await grant(await mac());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "worker_update_required" } });
  });

  it("issues one credential-free handle per live device binding and keeps reads passive", async () => {
    const device = await mac();
    const before = (await pool.query("SELECT active_at,updated_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    const first = await claims(await grant(device)), second = await claims(await grant(device));
    expect(Object.keys(first).sort()).toEqual(["aud", "boot", "ctx", "dev", "exp", "iat", "iss", "jti", "scope", "sub"]);
    expect(first).toMatchObject({ aud: f.workspace.id, boot: f.boot, sub: f.viewer.id, dev: device.device.deviceId, scope: "sync" });
    expect(first.exp - first.iat).toBe(60);
    expect(second.ctx).toBe(first.ctx); expect(second.jti).not.toBe(first.jti);
    const row = (await pool.query("SELECT * FROM cloud_v2_execution_contexts WHERE id=$1", [first.ctx])).rows[0];
    expect(row).toMatchObject({ kind: "client", user_id: f.viewer.id, material: null, operation: null,
      sync_device_id: device.device.deviceId, sync_registration_id: device.device.registrationId, sync_instance_id: device.device.instanceId });
    expect(row.client_token_expires_at.getTime()).toBe((second.iat + 570) * 1000);
    const renewed = await f.worker("execution-leases/renew", { contextIds: [first.ctx] });
    expect(await renewed.json()).toEqual({ leases: [{ contextId: first.ctx, expiresAt: expect.any(Number) }] });
    await expect(f.cp.execution.clients.forward(f.workspace.id, first.ctx, { type: "WORKSPACE_REQUEST", id: "write", op: "file.write" }))
      .rejects.toMatchObject({ code: "actor_changed" });
    expect((await pool.query("SELECT active_at,updated_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0]).toEqual(before);
  });

  it("reverifies a cached source tail before issuing a sync handle", async () => {
    const device = await mac();
    await f.cp.execution.deps.authority.admit(f.workspace.id, f.viewer.id);
    await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '21 seconds'
      WHERE org_id=$1 AND owner_user_id=$2`, [f.organizationId, f.viewer.id]);
    const signed = await claims(await grant(device));
    const row = (await pool.query(`SELECT extract(epoch FROM(expires_at-created_at))*1000 AS lifetime
      FROM cloud_v2_execution_contexts WHERE id=$1`, [signed.ctx])).rows[0];
    expect(Number(row.lifetime)).toBeGreaterThanOrEqual(25_000);
  });

  it("renews a still-live sync handle before reissuing its grant", async () => {
    const device = await mac(), first = await claims(await grant(device));
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()+interval '9 seconds' WHERE id=$1", [first.ctx]);
    const next = await claims(await grant(device));
    expect(next.ctx).toBe(first.ctx);
    const row = (await pool.query(`SELECT extract(epoch FROM(expires_at-clock_timestamp()))*1000 AS remaining
      FROM cloud_v2_execution_contexts WHERE id=$1`, [next.ctx])).rows[0];
    expect(Number(row.remaining)).toBeGreaterThanOrEqual(25_000);
  });

  it("refuses a short final proof without issuing a sync handle", async () => {
    const device = await mac(), admit = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
    vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementationOnce(async (...args) => ({ ...(await admit(...args)), until: Date.now() + 9000 }));
    const refused = await grant(device);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "agent_credentials_unavailable" } });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND sync_device_id IS NOT NULL", [f.workspace.id])).rowCount).toBe(0);
  });

  it("rolls back a sync handle if final grant checks consume the issuance floor", async () => {
    const device = await mac(), issue = f.cp.execution.sync.grant.bind(f.cp.execution.sync);
    vi.spyOn(f.cp.execution.sync, "grant").mockImplementationOnce(async (...args) => {
      const context = await issue(...args);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
      return context;
    });
    const refused = await grant(device);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "agent_credentials_unavailable" } });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND sync_device_id IS NOT NULL", [f.workspace.id])).rowCount).toBe(0);
  });

  it("refuses an already minted grant before its first read after member loss while a peer renews", async () => {
    const removed = await mac(), peer = await mac(f.creator);
    const first = await claims(await grant(removed)), second = await claims(await grant(peer));
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    const response = await f.worker("execution-leases/renew", { contextIds: [first.ctx, second.ctx] });
    expect((await response.json()).leases).toEqual(expect.arrayContaining([
      { contextId: first.ctx, refused: "access_revoked" }, { contextId: second.ctx, expiresAt: expect.any(Number) },
    ]));
    const denied = await grant(removed);
    expect([403, 404]).toContain(denied.status);
    if (denied.status === 403) expect(await denied.json()).toMatchObject({ error: { code: "member_access_revoked" } });
  });

  it("never revives a context across a Mac disconnect and reconnect", async () => {
    const device = await mac(), first = await claims(await grant(device));
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/macs/${device.device.deviceId}/disconnect`, "POST", {}, device.user, device.headers)).status).toBe(200);
    const refused = await f.worker("execution-leases/renew", { contextIds: [first.ctx] });
    expect(await refused.json()).toEqual({ leases: [{ contextId: first.ctx, refused: "access_revoked" }] });
    const missing = await grant(device);
    expect(missing.status).toBe(403); expect(await missing.json()).toMatchObject({ error: { code: "mac_not_connected" } });
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/macs/${device.device.deviceId}/connect`, "POST", {}, device.user, device.headers)).status).toBe(200);
    expect((await claims(await grant(device))).ctx).not.toBe(first.ctx);
  });

  it("cuts an N-1 writer's removed sync handle without depending on its workspace visibility", async () => {
    await f.cp.loginChanges.stop();
    const removed = await mac(), peer = await mac(f.creator);
    const first = await claims(await grant(removed)), second = await claims(await grant(peer));
    const old = await pool.connect();
    try {
      await old.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await old.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rowCount).toBe(0);
      await old.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
      await old.query("COMMIT");
    } finally { await old.query("ROLLBACK"); old.release(); }
    const response = await f.worker("execution-leases/renew", { contextIds: [first.ctx, second.ctx] });
    expect((await response.json()).leases).toEqual(expect.arrayContaining([
      { contextId: first.ctx, refused: "access_revoked" }, { contextId: second.ctx, expiresAt: expect.any(Number) },
    ]));
    expect([403, 404]).toContain((await grant(removed)).status);
  });
});
