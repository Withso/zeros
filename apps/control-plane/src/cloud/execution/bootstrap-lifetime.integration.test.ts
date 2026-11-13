import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";
import { withSystemTx } from "../../db.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("bootstrap authority through the real worker router", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.activate(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const config = () => f.worker("config", undefined, { method: "GET" });
  const bootstrap = async () => {
    const hello = await f.hello(); expect(hello.status).toBe(200);
    const id = (await hello.json()).config.bootstrapContextId as string;
    expect(id).toEqual(expect.any(String)); return id;
  };

  it("reverifies a source observation whose remaining lifetime was consumed by runtime installation", async () => {
    await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '29 seconds'
      WHERE org_id=$1 AND owner_user_id=$2`, [f.organizationId, f.creator.id]);
    const id = await bootstrap();
    const row = (await pool.query(`SELECT extract(epoch FROM (expires_at-created_at))*1000 AS lifetime
      FROM cloud_v2_execution_contexts WHERE id=$1`, [id])).rows[0];
    expect(Number(row.lifetime)).toBeGreaterThan(25_000);
    expect((await f.worker("bootstrap-lease", { contextId: id })).status).toBe(200);
  });

  it("replaces an expired never-delivered id on config retry and fences the original lease", async () => {
    const first = await bootstrap();
    expect((await pool.query("SELECT material FROM cloud_v2_execution_contexts WHERE id=$1", [first])).rows[0].material).toBeNull();
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first]);
    const response = await config(); expect(response.status).toBe(200);
    const next = (await response.json()).config.bootstrapContextId;
    expect(next).toEqual(expect.any(String)); expect(next).not.toBe(first);
    expect((await f.worker("bootstrap-lease", { contextId: first })).status).toBe(409);
    expect((await f.worker("bootstrap-lease", { contextId: next })).status).toBe(200);
  });

  it("replaces a never-delivered id after maintenance revoked it for expiry", async () => {
    const first = await bootstrap();
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first]);
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    expect((await pool.query("SELECT state,reason FROM cloud_v2_execution_contexts WHERE id=$1", [first])).rows[0])
      .toEqual({ state: "revoked", reason: "expired" });
    const reply = await config(); expect(reply.status).toBe(200);
    const next = (await reply.json()).config.bootstrapContextId;
    expect(next).toEqual(expect.any(String)); expect(next).not.toBe(first);
    expect((await f.worker("bootstrap-lease", { contextId: next })).status).toBe(200);
  });

  it("replaces an expired undelivered bootstrap after another member changes the source cache fingerprint", async () => {
    const first = await bootstrap();
    const before = (await pool.query("SELECT authority,source_fingerprint FROM cloud_v2_execution_contexts WHERE id=$1", [first])).rows[0];
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first]);
    await withSystemTx(pool, async tx => {
      await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.admin.id]);
      await tx.query("UPDATE organizations SET authorization_revision=authorization_revision+1 WHERE id=$1", [f.organizationId]);
    });
    const response = await config(); expect(response.status).toBe(200);
    const next = (await response.json()).config.bootstrapContextId;
    expect(next).not.toBe(first);
    const after = (await pool.query("SELECT authority,source_fingerprint FROM cloud_v2_execution_contexts WHERE id=$1", [next])).rows[0];
    expect(after.authority).toEqual(before.authority);
    expect(after.source_fingerprint).toBeNull();
    expect(before.source_fingerprint).toBeNull();
    expect((await f.worker("bootstrap-lease", { contextId: first })).status).toBe(409);
    expect((await f.worker("bootstrap-lease", { contextId: next })).status).toBe(200);
  });

  it("replaces an expired undelivered bootstrap independently of the initiator's GitHub selection", async () => {
    const first = await bootstrap();
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first]);
    const scope = { organizationId: f.organizationId, userId: f.creator.id, repositoryId: "42" };
    const connections = f.cp.execution.deps.authority.connections;
    await connections.save(scope, await connections.fingerprint(scope), { id: "12", login: "fixture" },
      { method: "pat", accessToken: `synthetic-${f.creator.id}`, expiresAt: null });
    const replacement = await config(); expect(replacement.status).toBe(200);
    const next = (await replacement.json()).config.bootstrapContextId;
    expect(next).not.toBe(first);
    expect((await f.worker("bootstrap-lease", { contextId: first })).status).toBe(409);
    expect((await f.worker("bootstrap-lease", { contextId: next })).status).toBe(200);
  });

  it("captures an older replica's material write and keeps the delivery receipt through erasure", async () => {
    const id = await bootstrap();
    await pool.query("UPDATE cloud_v2_execution_contexts SET material=$2 WHERE id=$1", [id, { synthetic: true }]);
    await pool.query("UPDATE cloud_v2_execution_contexts SET state='revoked',reason='expired',revoked_at=clock_timestamp() WHERE id=$1", [id]);
    expect((await pool.query("SELECT material,bootstrap_material_issued FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0])
      .toEqual({ material: null, bootstrap_material_issued: true });
    const reply = await config(); expect(reply.status).toBe(200);
    expect((await reply.json()).config).not.toHaveProperty("bootstrapContextId");
  });

  it("refuses unknown historical delivery instead of treating erased material as never delivered", async () => {
    const id = await bootstrap();
    await pool.query(`UPDATE cloud_v2_execution_contexts SET bootstrap_material_issued=NULL,state='revoked',reason='expired',
      revoked_at=clock_timestamp(),expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [id]);
    expect((await config()).status).toBe(409);
    expect((await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='bootstrap'", [f.workspace.id])).rows).toEqual([{ id }]);
  });

  it("requires the bootstrap material receipt before any GitHub token delivery", async () => {
    const id = await bootstrap();
    const issue = vi.spyOn(f.cp.execution.deps, "githubToken");
    expect((await f.worker("github-token", { purpose: "git", contextId: id })).status).toBe(409);
    expect(issue).not.toHaveBeenCalled();
    expect((await f.worker("bootstrap-lease", { contextId: id })).status).toBe(200);
    expect((await f.worker("github-token", { purpose: "git", contextId: id })).status).toBe(200);
    expect(issue).toHaveBeenCalledOnce();
  });

  it("does not persist an almost-expired proof after final authority work", async () => {
    const admit = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
    vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementation(async (...args) => {
      const proof = await admit(...args);
      return { ...proof, until: Date.now() + 1000 };
    });
    expect((await f.hello()).status).toBe(503);
    expect((await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it("fences a material request that was still generating while its undelivered context was replaced", async () => {
    const first = await bootstrap();
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const material = f.cp.execution.deps.material;
    vi.spyOn(f.cp.execution.deps, "material").mockImplementationOnce(async (...args) => {
      entered(); await held; return material(...args);
    });
    const pending = f.worker("bootstrap-lease", { contextId: first });
    try {
      await arrived;
      await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first]);
      const reply = await config(); expect(reply.status).toBe(200);
      const next = (await reply.json()).config.bootstrapContextId;
      expect(next).not.toBe(first);
      release(); expect((await pending).status).toBe(409);
      expect((await f.worker("bootstrap-lease", { contextId: next })).status).toBe(200);
    } finally { release(); await pending; }
  });

  it("skips a completed bootstrap on a worker restart in the same boot", async () => {
    const id = await bootstrap();
    expect((await f.worker("bootstrap-lease", { contextId: id })).status).toBe(200);
    expect((await f.worker(`execution-leases/${id}/retired`, { retirementId: randomUUID(), reason: "setup_done", processes: 0 })).status).toBe(200);
    const again = await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: "b".repeat(64) });
    expect(again.status).toBe(200); expect((await again.json()).config).not.toHaveProperty("bootstrapContextId");
    expect((await f.worker("bootstrap-lease", { contextId: id })).status).toBe(409);
    expect((await pool.query("SELECT state,material FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0]).toEqual({ state: "retired", material: null });
  });

  it("remembers delivery even after revocation erases the material", async () => {
    const id = await bootstrap();
    expect((await f.worker("bootstrap-lease", { contextId: id })).status).toBe(200);
    await pool.query(`UPDATE cloud_v2_execution_contexts SET state='revoked',reason='expired',revoked_at=clock_timestamp(),
      expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [id]);
    expect((await pool.query("SELECT material FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0].material).toBeNull();
    const response = await config(); expect(response.status).toBe(200);
    expect((await response.json()).config).not.toHaveProperty("bootstrapContextId");
    expect((await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='bootstrap'", [f.workspace.id])).rows).toEqual([{ id }]);
    expect((await f.worker("bootstrap-lease", { contextId: id })).status).toBe(409);
  });

  it("does not replace an undelivered bootstrap whose authority was explicitly revoked", async () => {
    const id = await bootstrap();
    await pool.query("UPDATE cloud_v2_execution_contexts SET state='revoked',reason='access_revoked',revoked_at=clock_timestamp() WHERE id=$1", [id]);
    const response = await config(); expect(response.status).toBe(409);
    expect((await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='bootstrap'", [f.workspace.id])).rows).toEqual([{ id }]);
  });

  it("keeps a pending live id stable across config retries", async () => {
    const id = await bootstrap();
    const response = await config(); expect(response.status).toBe(200);
    expect((await response.json()).config.bootstrapContextId).toBe(id);
    expect((await f.worker("bootstrap-lease", { contextId: id })).status).toBe(200);
  });

  it("converges concurrent expired-config retries on one fresh context", async () => {
    const first = await bootstrap();
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first]);
    const replies = await Promise.all([config(), config()]);
    expect(replies.map(reply => reply.status)).toEqual([200, 200]);
    const ids = await Promise.all(replies.map(async reply => (await reply.json()).config.bootstrapContextId));
    expect(ids[0]).not.toBe(first); expect(ids[1]).toBe(ids[0]);
    expect((await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='bootstrap'", [f.workspace.id])).rows)
      .toEqual([{ id: ids[0] }]);
  });
});
