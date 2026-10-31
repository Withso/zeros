import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Store } from "./store.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("cloud workspaces and Pro organization seats", () => {
  let pool: pg.Pool;
  let store: CloudV2Store;
  let org: string;
  let creator: string;
  let free: string[];

  async function user(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'User')`, [id, `u-${id}@example.test`]);
    return id;
  }

  const join = (userId: string, hoursAgo: number, role = "member") => pool.query(
    `INSERT INTO organization_members (org_id, user_id, role, created_at)
     VALUES ($1, $2, $3, now() - make_interval(hours => $4))`, [org, userId, role, hoursAgo]);

  const lapse = (userId: string) => pool.query(
    "UPDATE account_entitlements SET status = 'cancelled', cloud_workspaces_allowed = false, updated_at = now() WHERE user_id = $1",
    [userId]);

  const create = (creatorUserId = creator) => store.createWorkspace({
    id: randomUUID(), organizationId: org, creatorUserId, name: "zeros", repository: "withso/zeros",
    branch: "zeros/w", baseBranch: "main", computerBuildId: null,
  });

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool);
    const owner = await user();
    creator = await user();
    await grantTestPro(pool, owner, creator);
    org = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed)
      VALUES ($1, $2, 'Org', $3, false, true)`, [org, `org-${org}`, owner]);
    await join(owner, 200, "owner");
    await join(creator, 150);
    free = [];
    for (let n = 1; n <= 5; n++) { const id = await user(); await join(id, 100 - n); free.push(id); }
  });

  it("takes a workspace from a creator on Hold on every path until a seat opens", async () => {
    const workspace = await create();
    await store.transition(workspace.id, ["creating"], "running");
    const token = await store.rotateWorkerToken(workspace.id);
    await store.acceptWorkerHello(token, randomUUID());
    const proxy = await store.issueToken({ workspaceId: workspace.id, kind: "proxy", userId: null, ttlMs: 60_000 });

    await lapse(creator);
    await expect(store.get(workspace.id, creator)).rejects.toMatchObject({ status: 403, code: "organization_member_on_hold" });
    await expect(store.requestLifecycle(workspace.id, creator, "stop")).rejects.toMatchObject({ code: "organization_member_on_hold" });
    await expect(store.get(workspace.id, free[1]!)).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await store.byWorkerToken(token)).toBeNull();
    expect(await store.verifyProxyToken(proxy.token)).toBeNull();
    await expect(create()).rejects.toMatchObject({ code: "organization_member_on_hold" });

    await pool.query("DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2", [org, free[0]]);
    expect((await store.get(workspace.id, creator)).state).toBe("running");
    expect(await store.byWorkerToken(token)).not.toBeNull();
    expect(await store.verifyProxyToken(proxy.token)).not.toBeNull();
  });

  it("lets a member without Pro use a workspace but not create one", async () => {
    await pool.query("DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2", [org, free[0]]);
    const workspace = await create();
    await lapse(creator);
    expect((await store.get(workspace.id, creator)).id).toBe(workspace.id);
    await expect(create()).rejects.toMatchObject({ status: 403, code: "pro_required" });
    await expect(create(free[1])).rejects.toMatchObject({ status: 403, code: "pro_required" });
  });
});
