// Environment files of the repositories after the first of a workspace of
// several (creator path): each pinned like the first, delivered under its own
// repository, reported on its own pin, released and pruned with the workspace.
// Shared execution never receives them.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudEnvironments, pinCloudRepositoryEnvironments } from "./environment-store.js";
import { CloudGithubPrStore } from "./github-pr-store.js";
import { CloudV2Store } from "./store.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("environment files of later repositories", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  afterAll(async () => { await pool.end(); });

  async function fixture() {
    const org = randomUUID(), owner = randomUUID(), other = randomUUID();
    for (const user of [owner, other]) {
      await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [user, `${user}@example.test`]);
      await grantTestPro(pool, user);
    }
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, owner]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [org, owner, other]);
    const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
    const ids: Record<string, string> = { "fixture/repo": "42", "fixture/web": "43" };
    const environments = new CloudEnvironments(pool, keys, async (_org, _user, repository) => ({ repositoryId: ids[repository]!, assertCurrent: async () => {}, assertReadable: async () => {} }));
    const first = await environments.patch(org, owner, "42", "fixture/repo", { expectedRevision: 0, variables: { FIRST_VALUE: "synthetic-first" } });
    const web = await environments.patch(org, owner, "43", "fixture/web", { expectedRevision: 0, variables: { WEB_VALUE: "synthetic-web" } });
    // Another member's own environment for the same repository: never anyone else's.
    await environments.patch(org, other, "43", "fixture/web", { expectedRevision: 0, variables: { OTHER_VALUE: "synthetic-other" } });
    const store = new CloudV2Store(pool), workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: owner,
      name: "workspace", repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET checkout_path='zeros-app/repo', folder='zeros-app' WHERE id=$1", [workspace.id]);
    await pool.query(`INSERT INTO cloud_v2_workspace_repositories (workspace_id, position, repository, folder, branch, base_branch)
      VALUES ($1, 1, 'fixture/web', 'web', 'workspace/one', 'main')`, [workspace.id]);
    await pool.query("INSERT INTO cloud_v2_github_sources (workspace_id, source_repository, repository_id) VALUES ($1, 'fixture/web', 43)", [workspace.id]);
    await withSystemTx(pool, tx => pinCloudRepositoryEnvironments(tx, workspace, ["43"]));
    const token = await store.rotateWorkerToken(workspace.id), boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot);
    await environments.report(token, boot, { versionId: first.versionId!, sequence: 1, state: "ready" });
    const app = new Hono();
    app.onError((error, c) => error instanceof HttpError ? c.json({ code: error.code }, error.status) : c.json({ code: "internal" }, 500));
    app.route("/", createCloudV2WorkerRoutes({ store, config: async () => { throw new Error("Unexpected config"); },
      githubToken: async () => { throw new Error("Unexpected GitHub token"); }, runtimeSha256: "a".repeat(64),
      repositoryEnvironmentReport: (worker, current, repository, value) => environments.reportRepository(worker, current, repository, value) }));
    const report = (body: unknown, features = "workspace-repositories-v1") => app.request("/v2/cloud/worker/repository-environment", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot, "x-zeros-worker-features": features, "content-type": "application/json" }, body: JSON.stringify(body) });
    const resolve = async () => withSystemTx(pool, async tx => environments.resolveRepositories(await store.get(workspace.id, owner), tx));
    const pins = async () => (await pool.query("SELECT workspace_id, repository_id::text, report_state, report_error FROM cloud_workspace_environment_repository_pins WHERE workspace_id=$1",
      [workspace.id])).rows;
    const document = async () => (await new CloudGithubPrStore(pool).documents([await store.get(workspace.id, owner)]))[0]!;
    return { workspace, owner, other, store, environments, first, web, report, resolve, pins, document };
  }

  it("delivers the creator's pinned version for a later repository, under its own repository", async () => {
    const f = await fixture();
    const resolved = await f.resolve();
    expect([...resolved.keys()]).toEqual(["43"]);
    expect(resolved.get("43")).toMatchObject({ versionId: f.web.versionId, repositoryId: "43", variables: { WEB_VALUE: "synthetic-web" } });
    expect(JSON.stringify(resolved.get("43"))).not.toContain("synthetic-first");
    expect(JSON.stringify(resolved.get("43"))).not.toContain("synthetic-other");
  });

  it("records a later repository's report on its own pin only: the workspace stays running on a failure", async () => {
    const f = await fixture();
    const failed = await f.report({ repository: "Fixture/Web", report: { versionId: f.web.versionId, sequence: 1, state: "failed", errorCode: "cloud_environment_path_conflict" } });
    expect(failed.status).toBe(200);
    expect(await f.pins()).toEqual([{ workspace_id: f.workspace.id, repository_id: "43", report_state: "failed", report_error: "cloud_environment_path_conflict" }]);
    expect((await f.store.get(f.workspace.id, f.owner)).state).toBe("running");
    expect((await f.document()).repositories!.map(entry => entry.environment)).toEqual([undefined, { state: "failed", errorCode: "cloud_environment_path_conflict" }]);
    expect((await pool.query("SELECT report_state FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [f.workspace.id])).rows[0].report_state).toBe("ready");
    // Another version, the first repository by name, an unknown name, or an unnegotiated worker: refused.
    expect((await f.report({ repository: "fixture/web", report: { versionId: f.first.versionId, sequence: 2, state: "ready" } })).status).toBe(401);
    expect((await f.report({ repository: "fixture/repo", report: { versionId: f.first.versionId, sequence: 2, state: "ready" } })).status).toBe(401);
    expect((await f.report({ repository: "fixture/other", report: { versionId: f.web.versionId, sequence: 2, state: "ready" } })).status).toBe(401);
    expect((await f.report({ repository: "fixture/web", report: { versionId: f.web.versionId, sequence: 2, state: "ready" } }, "")).status).toBe(404);
  });

  it("never delivers a later repository's creator files in shared execution", async () => {
    const f = await fixture();
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id=$1", [f.workspace.id]);
    expect((await pool.query("SELECT execution_mode FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].execution_mode).toBe("active");
    expect([...(await f.resolve()).keys()]).toEqual([]);
    // Said on that repository: not available in shared workspaces yet.
    expect((await f.document()).repositories!.map(entry => entry.environment)).toEqual([undefined, { state: "unavailable" }]);
  });

  it("keeps a pinned version from being pruned, and releases it with the deleted workspace", async () => {
    const f = await fixture();
    await f.environments.patch(f.workspace.organizationId, f.owner, "43", "fixture/web", { expectedRevision: 1, variables: { WEB_VALUE: "synthetic-later" } });
    await f.environments.prune();
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions WHERE id=$1", [f.web.versionId])).rowCount).toBe(1);
    await pool.query("UPDATE cloud_v2_workspaces SET state='deleted' WHERE id=$1", [f.workspace.id]);
    await f.environments.prune();
    expect(await f.pins()).toEqual([]);
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions WHERE id=$1", [f.web.versionId])).rowCount).toBe(0);
  });
});
