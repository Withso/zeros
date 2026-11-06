import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudEnvironments } from "./environment-store.js";
import { CloudV2Store } from "./store.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("environment report boot identity", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  afterAll(async () => { await pool.end(); });
  async function fixture() {
    const org = randomUUID(), owner = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [owner, `${owner}@example.test`]);
    await grantTestPro(pool, owner);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, owner]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, owner]);
    const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
    const environments = new CloudEnvironments(pool, keys, async () => ({ repositoryId: "42", assertCurrent: async () => {}, assertReadable: async () => {} }));
    const saved = await environments.patch(org, owner, "42", "fixture/repo", { expectedRevision: 0, variables: { APP_VALUE: "synthetic-only" } });
    const store = new CloudV2Store(pool), workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: owner,
      name: "workspace", repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    const token = await store.rotateWorkerToken(workspace.id), boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot);
    await environments.report(token, boot, { versionId: saved.versionId, sequence: 2, state: "ready" });
    const app = new Hono();
    app.onError((error, c) => error instanceof HttpError ? c.json({ code: error.code }, error.status) : c.json({ code: "internal" }, 500));
    app.route("/", createCloudV2WorkerRoutes({ store, config: async () => { throw new Error("Unexpected config"); },
      githubToken: async () => { throw new Error("Unexpected GitHub token"); }, runtimeSha256: "a".repeat(64),
      environmentReport: (worker, current, value) => environments.report(worker, current, value) }));
    const report = (bootId: string, body: unknown) => app.request("/v2/cloud/worker/environment", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-zeros-worker-boot": bootId, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { workspace, owner, store, saved, boot, report };
  }

  it("hints waiting relays once, on commit, when the ready report makes the workspace running", async () => {
    const listener = await pool.connect(), notices: string[] = [];
    try {
      listener.on("notification", notice => { if (notice.channel === "zeros_cloud_v2_ready") notices.push(notice.payload ?? ""); });
      await listener.query("LISTEN zeros_cloud_v2_ready");
      const f = await fixture();
      await vi.waitFor(() => expect(notices).toEqual([f.workspace.id]));
      expect((await f.report(f.boot, { versionId: f.saved.versionId, sequence: 2, state: "ready" })).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(notices).toEqual([f.workspace.id]);
    } finally { await listener.query("UNLISTEN *").catch(() => {}); listener.release(); }
  });

  it.each(["lowercase", "uppercase"])("a late failure cannot revoke ready for the %s spelling of the same authenticated boot", async spelling => {
    const f = await fixture(), boot = spelling === "uppercase" ? f.boot.toUpperCase() : f.boot;
    const response = await f.report(boot, { versionId: f.saved.versionId, sequence: 3, state: "failed", errorCode: "cloud_environment_path_conflict" });
    expect({ status: response.status, state: (await f.store.get(f.workspace.id, f.owner)).state }).toEqual({ status: 409, state: "running" });
  });
  it.each(["lowercase", "uppercase"])("a stale sequence cannot rewind the %s spelling of the same authenticated boot", async spelling => {
    const f = await fixture(), boot = spelling === "uppercase" ? f.boot.toUpperCase() : f.boot;
    const response = await f.report(boot, { versionId: f.saved.versionId, sequence: 1, state: "ready" });
    const row = (await pool.query("SELECT report_sequence::text FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [f.workspace.id])).rows[0];
    expect({ status: response.status, sequence: row.report_sequence }).toEqual({ status: 409, sequence: "2" });
  });

  it.each(["lowercase", "uppercase"])("replays a lost ready receipt for the %s spelling without advancing its sequence", async spelling => {
    const f = await fixture(), boot = spelling === "uppercase" ? f.boot.toUpperCase() : f.boot;
    const response = await f.report(boot, { versionId: f.saved.versionId, sequence: 2, state: "ready" });
    const row = (await pool.query("SELECT report_boot_id,ready_boot_id,report_sequence::text,report_state FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [f.workspace.id])).rows[0];
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sequence: 2 });
    expect(row).toEqual({ report_boot_id: f.boot, ready_boot_id: f.boot, report_sequence: "2", report_state: "ready" });
    expect((await f.store.get(f.workspace.id, f.owner)).state).toBe("running");
  });
});
