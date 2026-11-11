import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sealPortToken } from "../worker-port-token.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("shared execution uses each member's source and devices", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("returns a boolean execution capability after a failed run clears its worker boot", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET state='failed',worker_boot_id=NULL,worker_token_hash=NULL WHERE id=$1", [f.workspace.id]);
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}`, "GET", undefined, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: { teamWriting: 1, canExecute: false, readOnly: true } });
  });

  it("uses a member's own GitHub connection without rewriting the workspace Creator", async () => {
    f.fetcher.mockClear();
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/github`, "POST", { op: "gh.repoAccess", params: {} }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    expect(f.fetcher.mock.calls.length).toBeGreaterThan(0);
    expect(f.fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === `Bearer synthetic-${f.viewer.id}`)).toBe(true);
    expect((await pool.query("SELECT creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].creator_user_id).toBe(f.creator.id);
  });

  it("refuses a GitHub reply from before a member left and rejoined", async () => {
    await f.cp.execution.deps.authority.admit(f.workspace.id, f.viewer.id);
    const fetcher = f.fetcher.getMockImplementation()!;
    let release!: () => void, reached!: () => void, held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    f.fetcher.mockImplementation(async (...args) => {
      const result = await fetcher(...args);
      if (!held && new Headers(args[1]?.headers).get("authorization") === `Bearer synthetic-${f.viewer.id}`) {
        held = true; reached(); await gate;
      }
      return result;
    });
    const responding = f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/github`, "POST", { op: "gh.repoAccess", params: {} }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    await entered;
    try {
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [f.organizationId, f.viewer.id]);
    } finally { release(); }
    const response = await responding;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "github_authorization_changed" } });
  });

  it("connects only the member's Mac, grants passive sync as that person and discovers it without provider I/O", async () => {
    const deviceId = randomUUID();
    const registration = await f.call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", { requestId: randomUUID(), name: "Member Mac", capabilities: ["local-commands-v1"] }, f.viewer);
    expect(registration.status).toBe(200); const { device } = await registration.json();
    const headers = { "X-Zeros-Device-Id": deviceId, "X-Zeros-Device-Registration": device.registrationId, "X-Zeros-Device-Instance": device.instanceId,
      "X-Zeros-Sync": "1", "X-Zeros-Sync-Wanted": "1", "X-Zeros-Team-Sharing": "1" };
    const macs = `/v1/cloud-v2/workspaces/${f.workspace.id}/macs`;
    expect((await f.call(`${macs}/${deviceId}/connect`, "POST", undefined, f.viewer, headers)).status).toBe(200);
    expect((await (await f.call(macs, "GET", undefined, f.viewer, headers)).json()).macs).toMatchObject([{ deviceId, connected: true }]);
    await pool.query("UPDATE cloud_v2_workspaces SET sync_boot_ids=ARRAY[$2::uuid],worker_route_url='https://fixture.example.test',worker_port_token=$3 WHERE id=$1",
      [f.workspace.id, f.boot, sealPortToken("synthetic-port-value", f.workspace.id, f.keys)]);
    const grant = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/sync/grant`, "POST", undefined, f.viewer, headers);
    expect(grant.status).toBe(200);
    const claims = JSON.parse(Buffer.from((await grant.json()).grant.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: f.viewer.id, dev: deviceId, scope: "sync" });
    f.fetcher.mockClear();
    const connections = await f.call(`/v1/cloud-v2/devices/${deviceId}/connections`, "GET", undefined, f.viewer, headers);
    expect(connections.status).toBe(200);
    expect((await connections.json()).connections).toMatchObject([{ workspaceId: f.workspace.id }]);
    expect(f.fetcher).not.toHaveBeenCalled();
    const other = await f.call(macs, "GET", undefined, f.creator, headers);
    expect(other.status).toBe(200); expect((await other.json()).macs).toEqual([]);
    expect((await f.call(`${macs}/${deviceId}/disconnect`, "POST", undefined, f.viewer, headers)).status).toBe(200);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/sync/grant`, "POST", undefined, f.viewer, headers)).status).toBe(403);
  });

  it("refuses a sync grant after the member leaves and rejoins during the final route read", async () => {
    const deviceId = randomUUID();
    const registration = await f.call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", { requestId: randomUUID(), name: "Member Mac", capabilities: ["local-commands-v1"] }, f.viewer);
    const { device } = await registration.json();
    const headers = { "X-Zeros-Device-Id": deviceId, "X-Zeros-Device-Registration": device.registrationId, "X-Zeros-Device-Instance": device.instanceId,
      "X-Zeros-Sync": "1", "X-Zeros-Team-Sharing": "1" };
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/macs/${deviceId}/connect`, "POST", undefined, f.viewer, headers)).status).toBe(200);
    await pool.query("UPDATE cloud_v2_workspaces SET sync_boot_ids=ARRAY[$2::uuid],worker_route_url='https://fixture.example.test',worker_port_token=$3 WHERE id=$1",
      [f.workspace.id, f.boot, sealPortToken("synthetic-port-value", f.workspace.id, f.keys)]);
    await f.cp.loginChanges.stop();
    const authority = f.cp.execution.deps.authority, original = authority.assert.bind(authority);
    let calls = 0;
    vi.spyOn(authority, "assert").mockImplementation(async (...args) => {
      const proof = await original(...args);
      if (++calls === 2) {
        await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
        await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [f.organizationId, f.viewer.id]);
      }
      return proof;
    });
    const result = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/sync/grant`, "POST", undefined, f.viewer, headers);
    expect(result.status).toBe(409);
    expect(await result.json()).not.toHaveProperty("grant");
  });
});
