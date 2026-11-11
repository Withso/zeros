import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("team viewer source authority", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL,max: 6 }); });
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  afterAll(async () => { await pool.end(); });
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;

  it.each(["session","membership","account","fingerprint","source","epoch"])("fences %s changes while GitHub is awaited", async change => {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered=resolve; }), held = new Promise<void>(resolve => { release=resolve; });
    const fetcher = f.fetcher.getMockImplementation()!;
    let first = true;
    f.fetcher.mockImplementation(async (...args) => {
      const response = await fetcher(...args);
      if (first && new URL(String(args[0])).pathname === "/repositories/42") { first=false; entered(); await held; }
      return response;
    });
    const response = f.call(path()); await reached;
    try {
      if (change === "session") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[f.viewer.authentication.sessionId]);
      if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",[f.organizationId,f.viewer.id]);
      if (change === "account") await pool.query("UPDATE users SET auth_status='deleted',deleted_at=now() WHERE id=$1",[f.viewer.id]);
      if (change === "fingerprint") await pool.query("UPDATE cloud_github_selections SET generation=gen_random_uuid() WHERE org_id=$1 AND owner_user_id=$2",[f.organizationId,f.viewer.id]);
      if (change === "source") await pool.query("UPDATE cloud_v2_github_sources SET repository_id=43 WHERE workspace_id=$1",[f.workspace.id]);
      if (change === "epoch") await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1",[f.workspace.id]);
    } finally { release(); }
    const result = await response;
    expect([401,404,503]).toContain(result.status);
    expect((await result.json()).workspace).toBeUndefined();
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
  });

  it("refreshes fresh admission after thirty seconds but reuses an open viewer's positive for ten minutes", async () => {
    const proof = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    f.fetcher.mockClear();
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=now()-interval '31 seconds' WHERE owner_user_id=$1",[f.viewer.id]);
    expect((await f.call(path())).status).toBe(200);
    expect(f.fetcher).toHaveBeenCalled();
    const latest = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    const connection = await f.sharing.events.presence.open(latest);
    f.fetcher.mockClear();
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=now()-interval '9 minutes' WHERE owner_user_id=$1",[f.viewer.id]);
    expect((await f.call(path())).status).toBe(200);
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(f.sharing.authority.assert(proof)).rejects.toMatchObject({ status: 503 });
    await f.sharing.events.presence.close(connection);
  });

  it("bounds unknown-only continuation to the original hour and never extends fresh admission", async () => {
    const proof = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    const connection = await f.sharing.events.presence.open(proof);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=now()-interval '11 minutes' WHERE owner_user_id=$1",[f.viewer.id]);
    f.unavailable.add(f.viewer.id);
    expect((await f.call(path())).status).toBe(200);
    await vi.waitFor(async () => expect((await pool.query("SELECT failure_code FROM cloud_github_source_verifications WHERE owner_user_id=$1",[f.viewer.id])).rows[0].failure_code)
      .toBe("github_unavailable"),{ interval: 5 });
    expect((await f.call(path())).status).toBe(200);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=now()-interval '61 minutes' WHERE owner_user_id=$1",[f.viewer.id]);
    const expired = await f.call(path()); expect(expired.status).toBe(503); expect(expired.headers.get("Retry-After")).toBe("5");
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=now()-interval '11 minutes' WHERE owner_user_id=$1",[f.viewer.id]);
    await f.sharing.events.presence.close(connection);
    expect((await f.call(path())).status).toBe(503);
  });

  it("never lets continuation grace override a confirmed refusal", async () => {
    const proof = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    await f.sharing.events.presence.open(proof);
    await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=NULL,failure_status=404,
      failure_code='github_repository_not_found',retry_at=now()+interval '1 minute' WHERE owner_user_id=$1`,[f.viewer.id]);
    expect((await f.call(path())).status).toBe(404);
    expect((await f.call(path(),"GET",undefined,f.admin)).status).toBe(200);
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
  });
});
