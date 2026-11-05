import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Store } from "./store.js";
import { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import { RuntimeAdoption } from "./runtime-adoption.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("independent successive runtime handoff authority", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());

  async function fixture(rolledBack = false) {
    const creator = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    const store = new CloudV2Store(pool), handoffs = new RuntimeHandoffStore(pool);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator,
      name: "Runtime", repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await store.rotateWorkerToken(workspace.id), originalBoot = randomUUID();
    await store.beginWorkerHello(token, originalBoot); await store.acceptWorkerHello(token, originalBoot);
    await handoffs.recordRuntime(token, originalBoot, "a".repeat(64));
    const revision = (await store.workerSession(token, originalBoot))!.loginRevision;
    const first = (await handoffs.prepare(token, originalBoot, { target: "b".repeat(64), instanceId: randomUUID(), revision, generation: 7 }))!;
    expect(await handoffs.commit(token, originalBoot, first.id, revision, 7, first.target_sha256)).toBe(true);
    await handoffs.activate(token, first.id);
    if (rolledBack) expect(await handoffs.rollback(first.id)).not.toBeNull();
    const boot = rolledBack ? first.rollback_boot_id : first.next_boot_id;
    expect(await handoffs.promote(token, first.id, boot)).toBe(true);
    await handoffs.complete(first.id);
    const desired = "c".repeat(64);
    const adoption = new RuntimeAdoption({ handoffs, store, compute: { execLong: async () => ({ exitCode: 0, stdout: "", timedOut: false }) },
      authorizeSource: async () => {}, runtimeForWorkspace: async () => ({ sha256: desired, url: async () => "https://fixture.example.test/runtime" }) });
    const app = new Hono();
    app.onError((error, c) => c.json({ code: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    app.route("/", createCloudV2WorkerRoutes({ store, runtimeSha256: desired, runtimeUpdates: adoption, runtimeHandoffs: handoffs,
      githubToken: async () => ({ token: "synthetic-github", expiresAt: Date.now() + 60000 }),
      config: async () => ({ t: "config", loginRevision: await store.loginRevision(workspace.id) ?? "0",
        workspace: { id: workspace.id, organizationId: org, repository: "fixture/repo", checkoutPath: "/home/user/fixture/repo", branch: "workspace/one", baseBranch: "main" }, agents: {} }) }));
    const configuration = (id: string | undefined, currentBoot = boot) => app.request("/v2/cloud/worker/config", { headers: {
      authorization: `Bearer ${token}`, "x-zeros-worker-boot": currentBoot, "x-zeros-worker-features": "runtime-update-v1",
      ...(id ? { "x-zeros-runtime-handoff": id } : {}) } });
    return { handoffs, store, adoption, configuration, token, boot, originalBoot, revision, first, workspace, desired };
  }

  it.each([false, true])("keeps a published boot's configuration usable after a later aborted update (prior rollback=%s)", async rolledBack => {
    const f = await fixture(rolledBack);
    try {
      expect((await f.configuration(f.first.id)).status).toBe(200);
      const second = (await f.handoffs.prepare(f.token, f.boot, { target: f.desired, instanceId: f.first.instance_id, revision: f.revision, generation: 14 }))!;
      expect(second).not.toBeNull();
      expect(second.id).not.toBe(f.first.id);
      expect(await f.handoffs.cancel(f.token, second.id, f.boot)).toBe(true);
      expect(await f.store.workerSession(f.token, f.boot)).not.toBeNull();
      expect((await f.configuration(undefined)).status).toBe(200);
      expect((await f.configuration(f.first.id)).status).toBe(200);
    } finally { f.adoption.close(); }
  });

  it("refuses the retired original boot even with the completed handoff identifier", async () => {
    const f = await fixture();
    try {
      expect((await f.configuration(f.first.id)).status).toBe(200);
      expect((await f.configuration(f.first.id, f.originalBoot)).status).toBe(401);
      expect((await f.configuration(undefined, f.originalBoot)).status).toBe(401);
    } finally { f.adoption.close(); }
  });

  it("does not require private handoff evidence for an ordinary current boot", async () => {
    const f = await fixture();
    try {
      const second = (await f.handoffs.prepare(f.token, f.boot, { target: f.desired, instanceId: f.first.instance_id, revision: f.revision, generation: 14 }))!;
      expect(await f.handoffs.cancel(f.token, second.id, f.boot)).toBe(true);
      expect((await f.configuration(undefined)).status).toBe(200);
    } finally { f.adoption.close(); }
  });
});
