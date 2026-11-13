import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("team viewer membership authority", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL,max: 6 }); });
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  afterAll(async () => { await pool.end(); });
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;

  it.each(["session","membership","account","fingerprint","source","epoch"])("fences %s changes while metadata is read", async change => {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered=resolve; }), held = new Promise<void>(resolve => { release=resolve; });
    const documents = f.github.metadata.documents.bind(f.github.metadata);
    vi.spyOn(f.github.metadata, "documents").mockImplementationOnce(async (...args) => {
      const response = await documents(...args);
      entered(); await held;
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
    if (change === "fingerprint") {
      expect(result.status).toBe(200);
      expect((await result.json()).workspace.id).toBe(f.workspace.id);
    } else {
      expect([401,404,503]).toContain(result.status);
      expect((await result.json()).workspace).toBeUndefined();
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
  });

  it.each(["31 seconds", "9 minutes", "61 minutes"])("reads without refreshing a source answer aged %s", async age => {
    await f.github.source.viewer(f.organizationId, f.viewer.id, [{ repository: f.workspace.repository, repositoryId: "42" }]);
    f.fetcher.mockClear();
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=now()-$2::interval WHERE owner_user_id=$1", [f.viewer.id, age]);
    const proof = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    const connection = await f.sharing.events.presence.open(proof);
    expect((await f.call(path())).status).toBe(200);
    await expect(f.sharing.authority.assert(proof)).resolves.toMatchObject({ workspace: { id: f.workspace.id } });
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.sharing.events.presence.close(connection);
  });

  it("retains workspace admission and presence after a confirmed GitHub refusal", async () => {
    await f.github.source.viewer(f.organizationId, f.viewer.id, [{ repository: f.workspace.repository, repositoryId: "42" }]);
    const proof = await f.sharing.authority.admit(f.workspace.id,f.viewer);
    const connection = await f.sharing.events.presence.open(proof);
    await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=NULL,failure_status=404,
      failure_code='github_repository_not_found',retry_at=now()+interval '1 minute' WHERE owner_user_id=$1`,[f.viewer.id]);
    f.fetcher.mockClear();
    expect((await f.call(path())).status).toBe(200);
    expect((await f.call(path(),"GET",undefined,f.admin)).status).toBe(200);
    expect(await f.sharing.events.presence.snapshot(proof)).toMatchObject({ userIds: [f.viewer.id] });
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.sharing.events.presence.close(connection);
  });
});
