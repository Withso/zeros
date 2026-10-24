import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudV2Computers } from "./computer.js";
import { createCloudV2Routes } from "./routes.js";
import { CloudV2Store } from "./store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("durable cloud create requests", () => {
  let pool: pg.Pool, store: CloudV2Store, computers: CloudV2Computers, org: string, creator: string, member: string, buildId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool); computers = new CloudV2Computers(pool);
    org = randomUUID(); creator = randomUUID(); member = randomUUID();
    for (const id of [creator, member]) await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [id, `${id}@example.test`]);
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Org',$3,false,true)`, [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [org, creator, member]);
    const build = await computers.enqueue(org, creator, { repositories: [{ repository: "example/project", branch: "master", setup: "pnpm install" }] });
    buildId = build.id;
    await computers.claim(); await computers.activate(build.id, "test-snapshot");
  });

  it("pins the snapshot and repository setup to one active build across later activations", async () => {
    expect(await store.activeComputer(org)).toEqual({ buildId, repositories: [{ repository: "example/project", defaultBranch: "master" }] });
    const response = await api()("pinned", { repository: "Example/Project" });
    expect(response.status).toBe(201);
    const { workspace } = await response.json();
    expect(workspace.computerBuildId).toBe(buildId);
    const next = await computers.enqueue(org, creator, { repositories: [{ repository: "example/project", branch: "main", setup: "pnpm run next-setup" }] });
    await computers.claim(); await computers.activate(next.id, "next-snapshot");
    expect(await store.computerSnapshot(org, workspace.computerBuildId)).toBe("test-snapshot");
    expect(await store.workspaceSetup(workspace.id)).toBe("pnpm install");
    expect(await store.computerSnapshot(randomUUID(), workspace.computerBuildId)).toBeNull();
    expect(await store.installedRepositories(org)).toEqual([{ repository: "example/project", defaultBranch: "main" }]);
    await pool.query("UPDATE cloud_v2_workspaces SET repository='example/another' WHERE id=$1", [workspace.id]);
    expect(await store.workspaceSetup(workspace.id)).toBeNull();
  });

  it("rejects a build replaced between selection and persistence, then accepts a retry against the new build", async () => {
    const selected = store.activeComputer.bind(store);
    vi.spyOn(store, "activeComputer").mockImplementationOnce(async id => {
      const original = await selected(id);
      const next = await computers.enqueue(org, creator, { repositories: [{ repository: "example/project", branch: "main", setup: "pnpm run next-setup" }] });
      await computers.claim(); await computers.activate(next.id, "next-snapshot");
      return original;
    });
    const first = await api()("changing-build");
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ error: { code: "cloud_computer_changed" } });
    expect(await store.list(org, creator)).toEqual([]);
    expect((await api()("changing-build")).status).toBe(201);
  });
  function api(userId = creator, storage = store) {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    app.route("/", createCloudV2Routes({ store: storage, computers, installedRepositories: id => storage.installedRepositories(id), bridgeBaseUrl: "wss://example.test" }));
    return (key: string, body: object = {}) => app.request("/v1/cloud-v2/workspaces", { method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ organizationId: org, repository: "example/project", ...body }) });
  }

  it("replays the original status and document after a committed create response was lost", async () => {
    const first = await api()("same-intent"); expect(first.status).toBe(201);
    const original = await first.json();
    await store.transition(original.workspace.id, ["creating"], "running");
    // A retry may hit another API process after the Computer has changed.
    await pool.query("UPDATE cloud_v2_computers SET snapshot_name=NULL WHERE org_id=$1", [org]);
    const retry = await api(creator, new CloudV2Store(pool))("same-intent");
    expect(retry.status).toBe(201); expect(await retry.json()).toEqual(original);
    expect(await store.list(org, creator)).toHaveLength(1);
  });

  it("serializes concurrent retries, and refuses a different payload with the same creator/key", async () => {
    const create = api();
    const [a, b] = await Promise.all([create("concurrent"), create("concurrent")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await a.json()).toEqual(await b.json());
    const changed = await create("concurrent", { name: "Another workspace" });
    expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: { code: "idempotency_conflict" } });
    expect(await store.list(org, creator)).toHaveLength(1);
  });

  it("scopes a key to the creator and rechecks membership before replaying", async () => {
    expect((await api()("shared-key")).status).toBe(201);
    expect((await api(member)("shared-key")).status).toBe(201);
    expect(await store.list(org, creator)).toHaveLength(1); expect(await store.list(org, member)).toHaveLength(1);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, member]);
    expect((await api(member)("shared-key")).status).toBe(404);
  });

  it("rolls back workspace creation if its durable response cannot be written", async () => {
    await pool.query(`CREATE FUNCTION fixture_reject_create_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture storage failure'; END $$;
      CREATE TRIGGER fixture_receipt BEFORE INSERT ON cloud_v2_create_requests FOR EACH ROW EXECUTE FUNCTION fixture_reject_create_receipt()`);
    expect((await api()("atomic")).status).toBe(500);
    expect(await store.list(org, creator)).toEqual([]);
    await pool.query("DROP TRIGGER fixture_receipt ON cloud_v2_create_requests; DROP FUNCTION fixture_reject_create_receipt()");
    expect((await api()("atomic")).status).toBe(201);
    expect(await store.list(org, creator)).toHaveLength(1);
  });
});
