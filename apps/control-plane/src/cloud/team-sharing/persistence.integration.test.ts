import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../../db.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("team follows, pins, provenance and paging", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL,max: 6 }); });
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  afterAll(async () => { await pool.end(); });
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;

  it("makes follow and pin replays inert and scopes them to the signed-in person", async () => {
    for (let n=0;n<2;n++) {
      expect(await (await f.call(`${path()}/follow`,"POST")).json()).toEqual({ following: true });
      expect(await (await f.call(`${path()}/pin`,"POST",{})).json()).toEqual({ pinned: true });
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspace_followers")).rows[0].n).toBe(1);
    const own = await (await f.call(path())).json(), other = await (await f.call(path(),"GET",undefined,f.admin)).json();
    expect(own.workspace).toMatchObject({ following: true,pinned: true,followerIds: [f.viewer.id],followerCount: 1 });
    expect(other.workspace).toMatchObject({ following: false,pinned: false,followerIds: [f.viewer.id],followerCount: 1 });
    expect(await (await f.call(`${path()}/unfollow`,"POST",undefined,f.admin)).json()).toEqual({ following: false });
    expect((await f.call(`${path()}/pin`,"POST",{ userId: f.creator.id })).status).toBe(400);
    expect((await f.call(`${path()}/follow`,"POST",undefined,f.creator)).status).toBe(409);
    expect((await f.call(`${path()}/unfollow`,"POST",undefined,f.creator)).status).toBe(200);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.own.id}/pin`,"POST")).status).toBe(200);
    expect(await (await f.call(`${path()}/followers`)).json()).toMatchObject({ userIds: [f.viewer.id],nextCursor: null });
    await f.call(`${path()}/unfollow`,"POST"); await f.call(`${path()}/unpin`,"POST");
    expect((await (await f.call(path())).json()).workspace).toMatchObject({ following: false,pinned: false,followerIds: [],followerCount: 0 });
  });

  it("applies filters and binds opaque keyset cursors to the person and filters", async () => {
    await f.call(`${path()}/follow`,"POST"); await f.call(`${path()}/pin`,"POST");
    const list = async (query = "",user = f.viewer) => (await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}${query}`,"GET",undefined,user)).json();
    expect((await list("&mine=1")).workspaces.map((row: { id: string }) => row.id)).toEqual([f.own.id]);
    for (const query of ["&following=1","&pinned=1",`&creator=${f.creator.id}`])
      expect((await list(query)).workspaces.map((row: { id: string }) => row.id)).toEqual([f.workspace.id]);
    expect((await list("&repositoryId=43")).workspaces).toEqual([]);
    const page = await list("&limit=1"); expect(page.workspaces).toHaveLength(1); expect(page.nextCursor).toEqual(expect.any(String));
    const next = await list(`&limit=1&cursor=${page.nextCursor}`); expect(next.workspaces).toHaveLength(1); expect(next.nextCursor).toBeNull();
    expect(new Set([page.workspaces[0].id,next.workspaces[0].id])).toEqual(new Set([f.own.id,f.workspace.id]));
    expect((await list(`&cursor=${page.nextCursor}&mine=1`)).error.code).toBe("invalid_request");
    expect((await list(`&cursor=${page.nextCursor}`,f.admin)).error.code).toBe("invalid_request");
    expect((await list(`&creator=${f.creator.id}&mine=1`)).error.code).toBe("invalid_request");
    await f.call(`${path()}/archive`,"POST",undefined,f.admin);
    expect((await list()).workspaces.map((row: { id: string }) => row.id)).toEqual([f.own.id]);
    expect((await list("&archived=only")).workspaces.map((row: { id: string }) => row.id)).toEqual([f.workspace.id]);
    expect((await list("&archived=include")).workspaces).toHaveLength(2);
  });

  it("bounds follow/pin requests with a shared user/organization budget", async () => {
    for (let n=0;n<60;n++) expect((await f.call(`${path()}/${n%2 ? "pin" : "follow"}`,"POST")).status).toBe(200);
    const refused = await f.call(`${path()}/follow`,"POST");
    expect(refused.status).toBe(429); expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await f.call(`${path()}/follow`,"POST",undefined,f.admin)).status).toBe(200);
  },15_000);

  it("enforces tenant foreign keys and system-only RLS, and cascades membership erasure", async () => {
    await f.call(`${path()}/follow`,"POST"); await f.call(`${path()}/pin`,"POST");
    for (const table of ["cloud_v2_workspace_followers","cloud_v2_workspace_pins","cloud_v2_workspace_presence"]) {
      expect(await withUserTx(pool,f.viewer.id,async tx => (await tx.query(`SELECT * FROM ${table}`)).rowCount)).toBe(0);
      expect((await pool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",[table])).rows[0])
        .toEqual({ relrowsecurity: true,relforcerowsecurity: true });
    }
    await expect(withSystemTx(pool,tx => tx.query("INSERT INTO cloud_v2_workspace_followers(workspace_id,org_id,user_id) VALUES($1,$2,$3)",
      [f.workspace.id,randomUUID(),f.admin.id]))).rejects.toMatchObject({ code: "23503" });
    await expect(withUserTx(pool,f.admin.id,tx => tx.query("INSERT INTO cloud_v2_workspace_followers(workspace_id,org_id,user_id) VALUES($1,$2,$3)",
      [f.workspace.id,f.organizationId,f.admin.id]))).rejects.toMatchObject({ code: "42501" });
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",[f.organizationId,f.viewer.id]);
    for (const table of ["cloud_v2_workspace_followers","cloud_v2_workspace_pins"]) expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
    expect((await f.call(path())).status).toBe(404);
  });

  it("fills N-1 inserts and protects original Creator through updates and user erasure", async () => {
    const original = await f.actor();
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[f.organizationId,original.id]);
    const id = randomUUID();
    await withSystemTx(pool,tx => tx.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state)
      VALUES($1,$2,$3,'N-1','example/project','n-1','main','stopped')`,[id,f.organizationId,original.id]));
    expect((await pool.query("SELECT created_by_user_id FROM cloud_v2_workspaces WHERE id=$1",[id])).rows[0].created_by_user_id).toBe(original.id);
    for (const replacement of [null,f.creator.id]) await expect(withSystemTx(pool,tx => tx.query("UPDATE cloud_v2_workspaces SET created_by_user_id=$2 WHERE id=$1",[id,replacement])))
      .rejects.toMatchObject({ message: "original creator is immutable" });
    await withSystemTx(pool,tx => tx.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2,name='N-1 update' WHERE id=$1",[id,f.creator.id]));
    await pool.query("DELETE FROM users WHERE id=$1",[original.id]);
    expect((await pool.query("SELECT created_by_user_id,creator_user_id FROM cloud_v2_workspaces WHERE id=$1",[id])).rows[0])
      .toMatchObject({ created_by_user_id: null,creator_user_id: f.creator.id });
    await expect(withSystemTx(pool,tx => tx.query("UPDATE cloud_v2_workspaces SET created_by_user_id=$2 WHERE id=$1",[id,f.creator.id]))).rejects.toThrow();
  });
});
