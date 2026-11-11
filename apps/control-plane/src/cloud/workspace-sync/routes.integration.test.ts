import { randomUUID, verify } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { syncFixture, type SyncFixture } from "./test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("direct sync through the production composition and PostgreSQL", () => {
  let pool: pg.Pool, f: SyncFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 }); });
  beforeEach(async () => { f = await syncFixture(pool); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const clocks = () => pool.query("SELECT state,updated_at,active_at,stop_generation,access_epoch,login_revision FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId]).then(result => result.rows[0]);

  it("issues a scoped single-use grant without a body, activity, VM I/O or credentials for another purpose", async () => {
    const mac = await f.register();
    await f.call(`${f.path}/macs/${mac.device.deviceId}/connect`, "POST", undefined, mac.headers);
    const before = await clocks(), calls = f.fetcher.mock.calls.length;
    const response = await f.grant(mac.headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json();
    expect(Object.keys(value).sort()).toEqual(["expiresAt", "grant", "portAuth", "url"]);
    expect(value.url).toBe("https://worker.example.test/"); expect(value.portAuth).toBe(f.portAuth);
    const [version, body, signature] = value.grant.split("."), claims = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(verify(null, Buffer.from(`${version}.${body}`), f.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(claims).toEqual({ iss: "zeros-cp", aud: f.workspaceId, boot: f.boot, scope: "sync", sub: f.owner.id, dev: mac.device.deviceId,
      iat: expect.any(Number), exp: expect.any(Number), jti: expect.any(String) });
    expect(claims.exp - claims.iat).toBe(60); expect(value.expiresAt).toBe(new Date(claims.exp * 1000).toISOString());
    expect((await (await f.grant(mac.headers, {})).json()).grant).not.toBe(value.grant);
    const upper = await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId.toUpperCase()}/sync/grant`, "POST", undefined, mac.headers);
    expect(upper.status).toBe(200);
    expect(JSON.parse(Buffer.from((await upper.json()).grant.split(".")[1], "base64url").toString()).aud).toBe(f.workspaceId);
    expect(await clocks()).toEqual(before); expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });

  it("keeps the Mac flag passive and the released strict Mac reply compatible", async () => {
    const mac = await f.register(), macPath = `${f.path}/macs/${mac.device.deviceId}`;
    const legacyMac = z.object({ deviceId: z.string().uuid(), name: z.string(), connected: z.boolean(), active: z.boolean(),
      reachable: z.boolean(), expiresAt: z.string().datetime().nullable() }).strict();
    expect(legacyMac.safeParse((await (await f.call(`${macPath}/connect`, "POST", {}, mac.headers)).json()).mac).success).toBe(true);
    await f.cp.store.requestLifecycle(f.workspaceId, f.owner.id, "stop");
    await f.cp.store.transition(f.workspaceId, ["stopping"], "stopped");
    const before = await clocks();
    const response = await f.call(`${macPath}/sync`, "PUT", { syncing: true }, mac.headers);
    expect(response.status).toBe(200); expect((await response.json()).mac).toMatchObject({ syncing: true, connected: true });
    const list = async (headers = {}) => (await (await f.call(`${f.path}/macs`, "GET", undefined, headers)).json()).macs;
    expect((await list())[0]).not.toHaveProperty("syncing"); expect(legacyMac.safeParse((await list())[0]).success).toBe(true);
    expect((await list({ "x-zeros-sync": "1" }))[0].syncing).toBe(true);
    expect((await list({ "x-zeros-sync": "true" }))[0]).not.toHaveProperty("syncing");
    const disconnected = await f.call(`${macPath}/disconnect`, "POST", {}, { ...mac.headers, "x-zeros-sync": "1" });
    expect((await disconnected.json()).mac).toMatchObject({ syncing: false, connected: false });
    expect(await clocks()).toEqual(before);
  });

  async function connected() {
    const mac = await f.register();
    expect((await f.call(`${f.path}/macs/${mac.device.deviceId}/connect`, "POST", undefined, mac.headers)).status).toBe(200);
    return mac;
  }

  it("never exposes a route to another creator, organization, device or registration", async () => {
    const mac = await connected(), theirs = await f.register(randomUUID(), f.other);
    expect((await f.grant(theirs.headers)).status).toBe(404);
    expect((await f.grant({ ...mac.headers, "x-zeros-device-id": theirs.device.deviceId })).status).toBe(404);
    expect((await f.grant({ ...mac.headers, "x-zeros-device-registration": randomUUID() })).status).toBe(409);
    expect((await f.grant({ ...mac.headers, "x-zeros-device-instance": randomUUID() })).status).toBe(409);
    const org = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Other',$3,false,true)", [org, `org-${org}`, f.other.id]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, f.other.id]);
    const workspace = await f.store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: f.other.id, name: "Other",
      repository: "example/project", branch: "other", baseBranch: "main", computerBuildId: null });
    const response = await f.call(`/v1/cloud-v2/workspaces/${workspace.id}/sync/grant`, "POST", undefined, mac.headers);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it.each(["", "sync-v10"])("requires the current boot's exact feature advertisement: %s", async features => {
    const mac = await connected();
    expect((await f.hello(features)).status).toBe(200);
    const response = await f.grant(mac.headers);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("worker_update_required");
    expect((await f.hello()).status).toBe(200); expect((await f.grant(mac.headers)).status).toBe(200);
  });

  it("does not rewrite or lock an unchanged boot advertisement", async () => {
    const sync = f.cp.workers.workspaceSync!;
    for (const supported of [true, false]) {
      expect(await sync.advertise(f.token, f.boot, supported)).toBe(true);
      const before = (await pool.query("SELECT xmin::text FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows;
      expect(await sync.advertise(f.token, f.boot, supported)).toBe(true);
      expect((await pool.query("SELECT xmin::text FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows).toEqual(before);
      const tx = await pool.connect();
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      try { expect(await sync.advertise(f.token, f.boot, supported)).toBe(true); }
      finally { await tx.query("ROLLBACK"); tx.release(); }
    }
  });

  it("does not wake a stopped workspace or renew an expired Mac connection", async () => {
    const mac = await connected();
    await pool.query("UPDATE cloud_v2_connected_macs SET connected_at=now()-interval '13 hours',last_used_at=now()-interval '13 hours' WHERE workspace_id=$1", [f.workspaceId]);
    let response = await f.grant(mac.headers);
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("mac_not_connected");
    await f.call(`${f.path}/macs/${mac.device.deviceId}/connect`, "POST", undefined, mac.headers);
    await f.cp.store.requestLifecycle(f.workspaceId, f.owner.id, "stop");
    await f.cp.store.transition(f.workspaceId, ["stopping"], "stopped");
    const before = await clocks();
    response = await f.grant(mac.headers);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("cloud_workspace_not_running");
    expect(await clocks()).toEqual(before);
  });

  it("masks stale flags under N-1 disconnect/expiry writes and clears them on reconnect", async () => {
    const mac = await connected(), path = `${f.path}/macs/${mac.device.deviceId}`;
    const list = async () => (await (await f.call(`${f.path}/macs`, "GET", undefined, { "x-zeros-sync": "1" })).json()).macs[0];
    await f.call(`${path}/sync`, "PUT", { syncing: true }, mac.headers);
    await pool.query("UPDATE cloud_v2_connected_macs SET disconnected_at=clock_timestamp() WHERE workspace_id=$1", [f.workspaceId]);
    expect(await list()).toMatchObject({ syncing: false, connected: false });
    let response = await f.call(`${path}/connect`, "POST", undefined, { ...mac.headers, "x-zeros-sync": "1" });
    expect((await response.json()).mac).toMatchObject({ syncing: false, connected: true });
    await f.call(`${path}/sync`, "PUT", { syncing: true }, mac.headers);
    await pool.query("UPDATE cloud_v2_connected_macs SET connected_at=now()-interval '13 hours',last_used_at=now()-interval '13 hours' WHERE workspace_id=$1", [f.workspaceId]);
    expect(await list()).toMatchObject({ syncing: false, connected: false });
    response = await f.call(`${path}/connect`, "POST", undefined, { ...mac.headers, "x-zeros-sync": "1" });
    expect((await response.json()).mac).toMatchObject({ syncing: false, connected: true });
  });

  it("changes only this Mac's flag, avoids redundant writes, and needs no running VM", async () => {
    const mac = await connected(), other = await f.register(), path = `${f.path}/macs/${mac.device.deviceId}/sync`;
    expect((await f.call(`${f.path}/macs/${other.device.deviceId}/sync`, "PUT", { syncing: true }, mac.headers)).status).toBe(409);
    expect((await f.call(`${f.path}/macs/${other.device.deviceId}/sync`, "PUT", { syncing: true }, other.headers)).status).toBe(403);
    const before = await clocks();
    expect((await f.call(path, "PUT", { syncing: true }, mac.headers)).status).toBe(200);
    const version = (await pool.query("SELECT xmin::text,connected_at,last_used_at FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows;
    expect((await f.call(path, "PUT", { syncing: true }, mac.headers)).status).toBe(200);
    expect((await pool.query("SELECT xmin::text,connected_at,last_used_at FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual(version);
    expect(await clocks()).toEqual(before);
    expect((await f.call(`${f.path}/macs/${other.device.deviceId}/sync`, "PUT", { syncing: false }, other.headers)).status).toBe(200);
  });

  it("bounds and validates bodies and never accepts client-selected grant claims", async () => {
    const mac = await connected(), flag = `${f.path}/macs/${mac.device.deviceId}/sync`;
    expect((await f.grant(mac.headers, { boot: f.boot })).status).toBe(400);
    expect((await f.grant({}, {})).status).toBe(400);
    expect((await f.grant(mac.headers, { padding: "x".repeat(4096) })).status).toBe(413);
    for (const body of [undefined, {}, { syncing: 1 }, { syncing: true, deviceId: mac.device.deviceId }])
      expect((await f.call(flag, "PUT", body, mac.headers)).status).toBe(400);
    expect((await f.call(flag, "PUT", { padding: "x".repeat(256 * 1024) }, mac.headers)).status).toBe(413);
  });

  it.each(["envelope", "url"])("fails closed on an unreadable %s without returning a secret", async field => {
    const mac = await connected();
    if (field === "envelope") await pool.query("UPDATE cloud_v2_workspaces SET worker_port_token='{}'::jsonb WHERE id=$1", [f.workspaceId]);
    else await pool.query("UPDATE cloud_v2_workspaces SET worker_route_url='http://fixture.invalid/private?token=fixture' WHERE id=$1", [f.workspaceId]);
    const response = await f.grant(mac.headers);
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("cloud_sync_unavailable");
    expect((await f.cp.store.get(f.workspaceId, f.owner.id)).state).toBe("running");
  });

  it("limits grants per device across equivalent workspace UUID spellings and returns Retry-After", async () => {
    const mac = await connected();
    for (let i = 0; i < 12; i++) expect((await f.grant(mac.headers)).status).toBe(200);
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId.toUpperCase()}/sync/grant`, "POST", undefined, mac.headers);
    expect(response.status).toBe(429); expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits aggregate grants across a user's connected devices", async () => {
    const macs = [];
    for (let i = 0; i < 11; i++) macs.push(await connected());
    for (let i = 0; i < 120; i++) expect((await f.grant(macs[i % macs.length]!.headers)).status).toBe(200);
    const response = await f.grant(macs[0]!.headers);
    expect(response.status).toBe(429); expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits flag writes independently of grants", async () => {
    const mac = await connected(), path = `${f.path}/macs/${mac.device.deviceId}/sync`;
    for (let i = 0; i < 60; i++) expect((await f.call(path, "PUT", { syncing: true }, mac.headers)).status).toBe(200);
    const response = await f.call(path, "PUT", { syncing: true }, mac.headers);
    expect(response.status).toBe(429); expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await f.grant(mac.headers)).status).toBe(200);
  });

  it("takes no workspace mutation lock to issue a grant", async () => {
    const mac = await connected(), tx = await pool.connect();
    await tx.query("BEGIN");
    await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
    try { expect((await f.grant(mac.headers)).status).toBe(200); }
    finally { await tx.query("ROLLBACK"); tx.release(); }
  });
});
