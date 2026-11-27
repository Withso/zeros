import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationPool, withSystemTx } from "../../apps/control-plane/src/db";
import { resetMigratedTestDatabase } from "../../apps/control-plane/src/test-database";
import { grantTestPro } from "../../apps/control-plane/src/test-pro";
import { CloudV2Computers } from "../../apps/control-plane/src/cloud/computer";
import { CloudV2Store } from "../../apps/control-plane/src/cloud/store";
import { RuntimeHandoffStore } from "../../apps/control-plane/src/cloud/runtime-handoff-store";
import { readRuntimeReferences } from "./runtime-archive-retention";

describe.skipIf(!process.env.TEST_DATABASE_URL)("runtime archive references against the migrated schema", () => {
  let pool: ReturnType<typeof createMigrationPool>;
  beforeAll(() => { pool = createMigrationPool(process.env.TEST_DATABASE_URL!, { role: "none", maxConnections: 4 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  // The application role is subject to row security, as the release role is; a superuser would bypass it.
  const asApplication = { connect: async () => {
    const client = await pool.connect(); await client.query("SET ROLE zeros_app");
    return { query: client.query.bind(client), release: () => { void client.query("RESET ROLE").finally(() => client.release()); } };
  } };

  it("reads live workspace, handoff and build references through row security, and drops a deleted workspace's", async () => {
    expect(await readRuntimeReferences(asApplication)).toEqual([]);
    const user = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Retention fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Retention fixture',$3,false,true)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    const store = new CloudV2Store(pool), handoffs = new RuntimeHandoffStore(pool);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: user, name: "Fixture", repository: "fixture/repo",
      sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot); await handoffs.recordRuntime(token, boot, "a".repeat(64));
    const revision = (await store.workerSession(token, boot))!.loginRevision;
    await handoffs.prepare(token, boot, { target: "b".repeat(64), instanceId: randomUUID(), revision, generation: 1 });
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    await computers.enqueue(org, user, { repositories: [{ repository: "fixture/repo" }] }, { runtimeSha256: "c".repeat(64) });
    expect(await readRuntimeReferences(asApplication)).toEqual(["a".repeat(64), "b".repeat(64), "c".repeat(64)]);

    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_computer_builds SET state='cancelled' WHERE org_id=$1", [org]));
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_worker_runtime_handoffs SET state='cancelled' WHERE workspace_id=$1", [workspace.id]));
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET state='deleted' WHERE id=$1", [workspace.id]));
    expect(await readRuntimeReferences(asApplication)).toEqual([]);
  });
});
