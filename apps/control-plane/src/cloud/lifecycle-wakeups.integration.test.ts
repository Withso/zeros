import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CLOUD_V2_LIFECYCLE_CHANNEL } from "./lifecycle.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("cloud lifecycle wake-ups", () => {
  let pool: pg.Pool, listener: pg.Client, store: CloudV2Store, workspace: CloudV2Workspace, notices: number;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool);
    const creator = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Org',$3,false,true)`, [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await listener.connect();
    notices = 0;
    listener.on("notification", notice => { if (notice.channel === CLOUD_V2_LIFECYCLE_CHANNEL) notices++; });
    await listener.query(`LISTEN ${CLOUD_V2_LIFECYCLE_CHANNEL}`);
    workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator,
      repository: "example/project", branch: "topic", baseBranch: "main", name: "Project", computerBuildId: null });
  });
  afterEach(async () => listener?.end());
  // A round trip on the listener's own connection delivers anything already committed.
  const settled = async () => { await listener.query("SELECT 1"); return notices; };

  it("notifies when a workspace enters a lifecycle state, and only then", async () => {
    await vi.waitFor(async () => expect(await settled()).toBe(1));
    await store.acceptWorkerHello(await store.rotateWorkerToken(workspace.id), randomUUID());
    expect(await settled()).toBe(1);
    await store.transition(workspace.id, ["running"], "stopping");
    await vi.waitFor(async () => expect(await settled()).toBe(2));
    await store.transition(workspace.id, ["stopping"], "stopped");
    expect(await settled()).toBe(2);
    await store.transition(workspace.id, ["stopped"], "starting");
    await vi.waitFor(async () => expect(await settled()).toBe(3));
  });

  it("reports when the next lifecycle row falls due", async () => {
    expect(await store.nextLifecycleDue()).toBe(0);
    await store.defer(workspace.id, "creating", 30_000);
    const deferred = await store.nextLifecycleDue();
    expect(deferred).toBeGreaterThan(25_000);
    expect(deferred).toBeLessThanOrEqual(30_000);
    await store.acceptWorkerHello(await store.rotateWorkerToken(workspace.id), randomUUID());
    expect(await store.nextLifecycleDue()).toBeNull();
  });

  it("wakes the lifecycle for prompt wake requests and Computer build changes", async () => {
    const { rows } = await pool.query<{ table: string; name: string }>(
      `SELECT c.relname AS table, t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid WHERE p.proname = 'notify_cloud_v2_lifecycle' ORDER BY 1, 2`);
    expect(rows).toEqual([
      { table: "cloud_v2_computer_builds", name: "zz_cloud_v2_lifecycle_builds" },
      { table: "cloud_v2_prompt_outbox", name: "zz_cloud_v2_lifecycle_prompt_wake" },
      { table: "cloud_v2_workspaces", name: "zz_cloud_v2_lifecycle_insert" },
      { table: "cloud_v2_workspaces", name: "zz_cloud_v2_lifecycle_state" },
    ]);
  });
});
