// Cloud workspaces are `w-<n>` within their organization, permanently, and
// are "Untitled" until one of their chats is first named. These run the real
// migration 0224 trigger, the store and the by-number route on PostgreSQL.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { HttpError } from "../authz.js";
import { CloudV2Store, workspaceTitleFromChat } from "./store.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("cloud workspace numbers and titles", () => {
  let pool: pg.Pool;
  let store: CloudV2Store;
  let creator: string;
  let member: string;
  let org: string;
  let otherOrg: string;

  async function user(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'User')`, [id, `u-${id}@example.test`]);
    await grantTestPro(pool, id);
    return id;
  }

  async function organization(slug: string): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed)
      VALUES ($1, $2, 'Org', $3, false, true)`, [id, slug, creator]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [id, creator, member]);
    return id;
  }

  const create = (organizationId = org, creatorUserId = creator) => store.createWorkspace({
    id: randomUUID(), organizationId, creatorUserId, name: "zeros", repository: "withso/zeros",
    branch: `zeros/${randomUUID().slice(0, 8)}`, baseBranch: "main", computerBuildId: null,
  });

  function api(asUser: () => string) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { id: asUser(), accountRevision: 1, identity: { provider: "workos", subject: asUser() },
        authentication: { sessionId: null, tokenExpiresAt: null } } as never);
      await next();
    });
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: "internal" }, 500));
    app.route("/", createCloudV2Routes({ store, bridgeBaseUrl: "wss://api.example.test" } as CloudV2RouteDeps));
    return app;
  }

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool);
    creator = await user();
    member = await user();
    org = await organization("acme");
    otherOrg = await organization("globex");
  });

  it("numbers each organization's workspaces 1, 2, 3 and never reuses a number", async () => {
    const first = await create(), second = await create(), elsewhere = await create(otherOrg);
    expect([first.number, second.number, elsewhere.number]).toEqual([1, 2, 1]);
    expect(first.title).toBeNull();
    // Purging rows (deletion retention) never returns their numbers.
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id = ANY($1::uuid[])", [[first.id, second.id]]);
    expect((await create()).number).toBe(3);
  });

  it("gives concurrent creates in one organization distinct numbers", async () => {
    const created = await Promise.all(Array.from({ length: 6 }, () => create()));
    expect(created.map((workspace) => workspace.number).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("numbers a row written without a number (an older release) after an explicit one", async () => {
    await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, number)
      VALUES ($1, $2, $3, 'n', 'withso/zeros', 'b1', 'main', 'creating', 40)`, [randomUUID(), org, creator]);
    expect((await create()).number).toBe(41);
  });

  it("reads a workspace by its organization slug and number, for its creator only", async () => {
    const workspace = await create();
    expect(await store.getByNumber("acme", 1, creator)).toMatchObject({ id: workspace.id, number: 1 });
    await expect(store.getByNumber("acme", 1, member)).rejects.toMatchObject({ status: 404 });
    await expect(store.getByNumber("acme", 2, creator)).rejects.toMatchObject({ status: 404 });
    await expect(store.getByNumber("globex", 1, creator)).rejects.toMatchObject({ status: 404 });

    let caller = creator;
    const app = api(() => caller);
    const response = await app.request("/v1/cloud-v2/workspaces/by-number/ACME/1");
    expect(response.status).toBe(200);
    expect((await response.json()).workspace).toMatchObject({ id: workspace.id, organizationId: org, number: 1, title: null });
    for (const path of ["/v1/cloud-v2/workspaces/by-number/acme/0", "/v1/cloud-v2/workspaces/by-number/acme/01",
      "/v1/cloud-v2/workspaces/by-number/-acme/1", "/v1/cloud-v2/workspaces/by-number/acme/2147483648"])
      expect((await app.request(path)).status).toBe(404);
    caller = member;
    expect((await app.request("/v1/cloud-v2/workspaces/by-number/acme/1")).status).toBe(404);
  });

  it("is Untitled until a chat is first named, then keeps that name and moves its version", async () => {
    const workspace = await create();
    await store.writeHistory(workspace.id, { chats: [{ id: "c1", title: "Untitled", createdAt: 1 }, { id: "c2", title: "New chat", createdAt: 2 }] as never });
    expect((await store.get(workspace.id, creator)).title).toBeNull();
    await store.writeHistory(workspace.id, { chats: [
      { id: "t1", title: "zsh", kind: "terminal", createdAt: 0 },
      { id: "a1", title: "Archived", archived: true, createdAt: 0 },
    ] as never });
    expect((await store.get(workspace.id, creator)).title).toBeNull();

    const before = (await store.get(workspace.id, creator)).updatedAt;
    await store.writeHistory(workspace.id, { chats: [
      { id: "c2", title: "Later  chat", createdAt: 2 },
      { id: "c1", title: " Add canvas zoom ", createdAt: 1 },
    ] as never });
    const titled = await store.get(workspace.id, creator);
    expect(titled.title).toBe("Add canvas zoom");
    expect(Date.parse(titled.updatedAt)).toBeGreaterThan(Date.parse(before));

    await store.writeHistory(workspace.id, { chats: [{ id: "c1", title: "Renamed", createdAt: 1 }] as never });
    expect((await store.get(workspace.id, creator)).title).toBe("Add canvas zoom");
  });

  it("titles a chat row by the Local rule", () => {
    expect(workspaceTitleFromChat({ title: "  Fix   login  " })).toBe("Fix login");
    expect(workspaceTitleFromChat({ title: "Untitled" })).toBeNull();
    expect(workspaceTitleFromChat({ title: "x".repeat(300) })).toHaveLength(200);
    expect(workspaceTitleFromChat({ title: 7 })).toBeNull();
    expect(workspaceTitleFromChat(null)).toBeNull();
  });
});
