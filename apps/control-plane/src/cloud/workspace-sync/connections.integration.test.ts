import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { DeviceSyncConnectionsReplySchema } from "./contract.js";
import { syncFixture, type SyncFixture } from "./test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const optIn = { "x-zeros-sync-wanted": "1" };
type Mac = Awaited<ReturnType<SyncFixture["register"]>>;

suite("device-scoped sync discovery through the production router and PostgreSQL", () => {
  let pool: pg.Pool, f: SyncFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 }); });
  beforeEach(async () => { f = await syncFixture(pool); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const path = (deviceId: string) => `/v1/cloud-v2/devices/${deviceId}/connections`;
  const read = (mac: Mac, suffix = "", headers: Record<string, string> = optIn) =>
    f.call(`${path(mac.device.deviceId)}${suffix}`, "GET", undefined, { ...mac.headers, ...headers });
  async function connect(mac: Mac, workspaceId = f.workspaceId) {
    const response = await f.call(`/v1/cloud-v2/workspaces/${workspaceId}/macs/${mac.device.deviceId}/connect`, "POST", undefined, mac.headers);
    expect(response.status).toBe(200);
  }
  async function page(mac: Mac, suffix = "", headers?: Record<string, string>) {
    const response = await read(mac, suffix, headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json();
    expect(DeviceSyncConnectionsReplySchema.parse(value)).toEqual(value);
    return value;
  }
  async function workspace(creator = f.owner.id, organizationId = f.organizationId) {
    const created = await f.cp.store.createWorkspace({ id: randomUUID(), organizationId, creatorUserId: creator,
      name: "Another workspace", repository: "another/project", branch: "work", baseBranch: "main", computerBuildId: null });
    await f.cp.store.transition(created.id, ["creating"], "stopped");
    return created;
  }

  it("discovers wanted and unwanted connections without workspace ids and negotiates the self-report separately", async () => {
    const mac = await f.register(), another = await workspace();
    await connect(mac); await connect(mac, another.id);
    await pool.query("UPDATE cloud_v2_connected_macs SET sync_wanted=true,syncing=true WHERE workspace_id=$1", [f.workspaceId]);
    const number = (await pool.query("SELECT number FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0].number;
    const expected = [
      { workspaceId: f.workspaceId, repository: "example/project", number, name: "Fixture", syncWanted: true },
      { workspaceId: another.id, repository: "another/project", number: another.number, name: another.name, syncWanted: false },
    ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    expect(await page(mac)).toEqual({ connections: expected, nextCursor: null });
    expect(await page(mac, "", { ...optIn, "x-zeros-sync": "1" })).toEqual({
      connections: expected.map(row => ({ ...row, syncing: row.workspaceId === f.workspaceId })), nextCursor: null,
    });
    expect(await page(mac, "", { ...optIn, "x-zeros-sync": "true" })).toEqual({ connections: expected, nextCursor: null });
  });

  it("requires the exact new header and validates a single UUID cursor", async () => {
    const mac = await f.register();
    for (const headers of [{}, { "x-zeros-sync": "1" }, { "x-zeros-sync-wanted": "true" }, { "x-zeros-sync-wanted": "0" }]) {
      const response = await read(mac, "", headers);
      expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("invalid_request");
    }
    for (const suffix of ["?cursor=", "?cursor=broken", `?cursor=${randomUUID()}&cursor=${randomUUID()}`, "?cursor=%27%3BSELECT%201"]) {
      const response = await read(mac, suffix);
      expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("invalid_request");
    }
    expect(await page(mac)).toEqual({ connections: [], nextCursor: null });
    expect(await page(mac, `?cursor=${randomUUID()}`)).toEqual({ connections: [], nextCursor: null });
  });

  it("paginates by workspace UUID in fixed 200-row pages without duplicates or a caller-selected page size", async () => {
    const mac = await f.register();
    const ids = Array.from({ length: 401 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    await pool.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state)
      SELECT id,$2,$3,'Paged workspace','example/project','work','main','stopped' FROM unnest($1::uuid[]) id`,
    [ids, f.organizationId, f.owner.id]);
    await pool.query(`INSERT INTO cloud_v2_connected_macs(workspace_id,user_id,device_id,registration_id,sync_wanted)
      SELECT id,$2,$3,$4,false FROM unnest($1::uuid[]) id`, [ids, f.owner.id, mac.device.deviceId, mac.device.registrationId]);
    const queries = vi.spyOn(pg.Client.prototype, "query"), checkouts = vi.spyOn(pool, "connect");
    const seen: string[] = [];
    let cursor: string | null = null;
    for (const count of [200, 200, 1]) {
      const result = await page(mac, cursor ? `?cursor=${cursor}&limit=1000` : "?limit=1000");
      expect(result.connections).toHaveLength(count);
      const returned = result.connections.map((row: { workspaceId: string }) => row.workspaceId);
      expect(returned).toEqual([...returned].sort()); seen.push(...returned);
      expect(result.nextCursor).toBe(count === 200 ? returned.at(-1) : null);
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(ids); expect(new Set(seen).size).toBe(401);
    expect(checkouts).toHaveBeenCalledTimes(3);
    const [sql, values] = queries.mock.calls.find(args => typeof args[0] === "string" && args[0].includes("ORDER BY c.workspace_id"))!;
    queries.mockRestore(); checkouts.mockRestore();
    const plan = await withSystemTx(pool, async tx => (await tx.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)).rows[0]["QUERY PLAN"][0], { consistentRead: true });
    expect(plan.Plan["Actual Rows"]).toBe(201);
    const indexes: string[] = [], membershipReads: number[] = [];
    const visit = (node: any) => {
      if (node["Index Name"]) indexes.push(node["Index Name"]);
      if (node["Relation Name"] === "organization_members") membershipReads.push(node["Actual Loops"]);
      node.Plans?.forEach(visit);
    };
    visit(plan.Plan);
    console.info("[workspace-sync] discovery-cost", JSON.stringify({ connectedWorkspaces: ids.length, pageRows: 201,
      executionMs: plan["Execution Time"], sharedHitBlocks: plan.Plan["Shared Hit Blocks"], indexes, membershipReads }));
    expect(membershipReads.length).toBeGreaterThan(0);
    expect(Math.max(...membershipReads)).toBe(1);
  });

  it("projects bounded display metadata, nullable legacy numbers, and no credentials or local paths", async () => {
    const mac = await f.register(); await connect(mac);
    await pool.query("UPDATE cloud_v2_workspaces SET name=$2,title='A chat title',number=NULL WHERE id=$1", [f.workspaceId, "w".repeat(200)]);
    expect(await page(mac)).toEqual({ connections: [{ workspaceId: f.workspaceId, repository: "example/project",
      number: null, name: "w".repeat(120), syncWanted: false }], nextCursor: null });
  });

  it("lists only this person's exact device registration and the current Creator's connections", async () => {
    const mac = await f.register(), second = await f.register(), theirs = await f.register(randomUUID(), f.other);
    const otherWorkspace = await workspace(f.other.id);
    await connect(mac); await connect(second); await connect(theirs, otherWorkspace.id);
    await pool.query(`INSERT INTO cloud_v2_connected_macs(workspace_id,user_id,device_id,registration_id,sync_wanted)
      VALUES($1,$2,$3,$4,true)`, [otherWorkspace.id, f.owner.id, mac.device.deviceId, mac.device.registrationId]);
    const expected = (await page(mac)).connections;
    expect(expected).toHaveLength(1); expect(expected[0].workspaceId).toBe(f.workspaceId);
    expect((await page(second)).connections.map((row: { workspaceId: string }) => row.workspaceId)).toEqual([f.workspaceId]);
    expect((await page(theirs)).connections.map((row: { workspaceId: string }) => row.workspaceId)).toEqual([otherWorkspace.id]);
    expect((await f.call(path(mac.device.deviceId), "GET", undefined, { ...theirs.headers, ...optIn })).status).toBe(404);
    expect((await read(mac, "", { ...optIn, "x-test-actor": f.other.id })).status).toBe(404);
    await pool.query("UPDATE cloud_v2_connected_macs SET registration_id=$2 WHERE workspace_id=$1 AND device_id=$3", [f.workspaceId, randomUUID(), mac.device.deviceId]);
    expect(await page(mac)).toEqual({ connections: [], nextCursor: null });
  });

  it("discovers across eligible organizations and removes only the one whose membership ended", async () => {
    const mac = await f.register(), organizationId = randomUUID();
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Another organization',$3,false,true)`, [organizationId, `org-${organizationId}`, f.owner.id]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [organizationId, f.owner.id]);
    const another = await workspace(f.owner.id, organizationId); await connect(mac); await connect(mac, another.id);
    expect((await page(mac)).connections).toHaveLength(2);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [organizationId, f.owner.id]);
    expect((await page(mac)).connections.map((row: { workspaceId: string }) => row.workspaceId)).toEqual([f.workspaceId]);
  });

  it("hides connections when the current Creator is on Hold even though membership remains", async () => {
    const mac = await f.register(); await connect(mac);
    const freeMembers = Array.from({ length: 5 }, () => randomUUID());
    await pool.query("INSERT INTO users(id,email) SELECT id,id::text||'@example.test' FROM unnest($1::uuid[]) id", [freeMembers]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role,created_at) SELECT $1,id,'member',now()-interval '1 day' FROM unnest($2::uuid[]) id", [f.organizationId, freeMembers]);
    await pool.query("UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1", [f.owner.id]);
    expect((await pool.query("SELECT count(*)::int AS count FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.owner.id])).rows[0].count).toBe(1);
    expect(await page(mac)).toEqual({ connections: [], nextCursor: null });
  });

  it.each(["membership", "entitlement", "creator", "organization_deleted", "deleting"] as const)("omits connections after %s changes", async change => {
    const mac = await f.register(); await connect(mac);
    expect((await page(mac)).connections).toHaveLength(1);
    if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.owner.id]);
    else if (change === "entitlement") await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [f.organizationId]);
    else if (change === "creator") await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspaceId, f.other.id]);
    else if (change === "organization_deleted") await pool.query("UPDATE organizations SET deleted_at=clock_timestamp() WHERE id=$1", [f.organizationId]);
    else await f.cp.store.transition(f.workspaceId, ["running"], "deleting");
    expect(await page(mac)).toEqual({ connections: [], nextCursor: null });
  });

  it("applies connection expiry without expiring the latest sender and omits an explicit disconnect", async () => {
    const mac = await f.register(); await connect(mac);
    await pool.query("UPDATE cloud_v2_connected_macs SET connected_at=now()-interval '13 hours',last_used_at=now()-interval '13 hours' WHERE workspace_id=$1", [f.workspaceId]);
    expect(await page(mac)).toEqual({ connections: [], nextCursor: null });
    await pool.query("UPDATE cloud_v2_connected_macs SET is_latest_sender=true WHERE workspace_id=$1", [f.workspaceId]);
    expect((await page(mac)).connections).toHaveLength(1);
    expect((await f.call(`${f.path}/macs/${mac.device.deviceId}/disconnect`, "POST", undefined, mac.headers)).status).toBe(200);
    expect(await page(mac)).toEqual({ connections: [], nextCursor: null });
  });

  it("requires a desktop session, all three exact device headers, and this device's current instance", async () => {
    const mac = await f.register(); await connect(mac);
    expect((await f.call(path(mac.device.deviceId), "GET", undefined, optIn)).status).toBe(400);
    for (const field of ["x-zeros-device-registration", "x-zeros-device-instance"]) {
      const response = await read(mac, "", { ...optIn, [field]: randomUUID() });
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("device_registration_changed");
    }
    const next = await f.register(mac.device.deviceId);
    expect(next.device.registrationId).toBe(mac.device.registrationId);
    expect((await read(mac)).status).toBe(409); expect((await page(next)).connections).toHaveLength(1);
    f.owner.authentication.clientKind = "web";
    expect((await read(next)).status).toBe(401);
  });

  it.each(["token", "session", "account", "registration"] as const)("rechecks %s authority on the next page", async change => {
    const mac = await f.register(); await connect(mac);
    expect((await page(mac)).connections).toHaveLength(1);
    if (change === "token") f.owner.authentication.tokenExpiresAt = Math.floor(Date.now() / 1000) - 1;
    else if (change === "session") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]);
    else if (change === "account") await pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.owner.id]);
    else await pool.query("UPDATE local_command_devices SET registration_id=$3 WHERE user_id=$1 AND device_id=$2", [f.owner.id, mac.device.deviceId, randomUUID()]);
    expect((await read(mac, `?cursor=${f.workspaceId}`)).status).toBe(change === "registration" ? 409 : 401);
  });

  it("enforces 60 reads per minute per device, independently of another Mac's budget", async () => {
    const mac = await f.register("abcdefab-abcd-4abc-8abc-abcdef123456"), second = await f.register();
    for (let i = 0; i < 60; i++) expect((await read(mac)).status).toBe(200);
    const limited = await read(mac);
    expect(limited.status).toBe(429); expect((await limited.json()).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const uppercase = mac.device.deviceId.toUpperCase();
    expect(uppercase).not.toBe(mac.device.deviceId);
    expect((await read({ ...mac, device: { ...mac.device, deviceId: uppercase },
      headers: { ...mac.headers, "x-zeros-device-id": uppercase } })).status).toBe(429);
    expect((await read(second)).status).toBe(200);
  });

  it("reads stopped and archived workspaces without mutation locks, provider calls, or renewed activity", async () => {
    const mac = await f.register(); await connect(mac);
    await f.cp.store.requestLifecycle(f.workspaceId, f.owner.id, "stop");
    await f.cp.store.transition(f.workspaceId, ["stopping"], "stopped");
    await pool.query("UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp() WHERE id=$1", [f.workspaceId]);
    const clocks = async () => ({
      workspace: (await pool.query("SELECT xmin::text,state,updated_at,active_at,archived_at,stop_generation,access_epoch FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows,
      connection: (await pool.query("SELECT xmin::text,connected_at,last_used_at FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows,
      device: (await pool.query("SELECT xmin::text,reachable_until,updated_at FROM local_command_devices WHERE user_id=$1 AND device_id=$2", [f.owner.id, mac.device.deviceId])).rows,
    });
    const before = await clocks(), providerCalls = f.fetcher.mock.calls.length, tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      await tx.query("SELECT workspace_id FROM cloud_v2_connected_macs WHERE workspace_id=$1 FOR UPDATE", [f.workspaceId]);
      await tx.query("SELECT device_id FROM local_command_devices WHERE user_id=$1 FOR UPDATE", [f.owner.id]);
      expect((await page(mac)).connections).toHaveLength(1);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    expect(await clocks()).toEqual(before); expect(f.fetcher).toHaveBeenCalledTimes(providerCalls);
  });
});
