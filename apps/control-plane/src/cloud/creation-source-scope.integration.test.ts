import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Computers } from "./computer.js";
import { createCloudV2Routes } from "./routes.js";
import { CloudV2Store, cloudV2WorkspaceImage } from "./store.js";

const ids: Record<string, string> = { "example/project": "42", "example/docs": "43" };

describe("Cloud Computer image choice", () => {
  it("starts only a covering source scope from a v3 image, and prunes the other checkouts", () => {
    const recipe = { repositories: [{ repository: "Example/Project" }, { repository: "Example/Docs" }] };
    expect(cloudV2WorkspaceImage({ policy: 3, snapshot: "v3", recipe, scope: ["example/project", "example/docs"], repository: "example/project" }))
      .toEqual({ from: "v3", prune: ["Example/Docs"], checkout: true });
    expect(cloudV2WorkspaceImage({ policy: 3, snapshot: "v3", recipe, scope: ["example/project"], repository: "example/project" }))
      .toEqual({ from: null, prune: [], checkout: false });
    expect(cloudV2WorkspaceImage({ policy: 2, snapshot: "v2", recipe, scope: ["example/project"], repository: "example/project" }))
      .toEqual({ from: "v2", prune: [], checkout: false });
    expect(cloudV2WorkspaceImage({ policy: 3, snapshot: "v3", recipe: { repositories: [{ repository: 7 }] }, scope: ["example/project"], repository: "example/project" }))
      .toEqual({ from: null, prune: [], checkout: false });
    // A covering image without this workspace's own repository still needs it cloned.
    expect(cloudV2WorkspaceImage({ policy: 3, snapshot: "v3", recipe, scope: ["example/project", "example/docs", "example/other"], repository: "example/other" }))
      .toEqual({ from: "v3", prune: ["Example/Project", "Example/Docs"], checkout: false });
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("cloud create source scope", () => {
  let pool: pg.Pool, store: CloudV2Store, computers: CloudV2Computers, org: string, creator: string, unreadable: Set<string>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    unreadable = new Set();
    store = new CloudV2Store(pool);
    computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => {
      if (unreadable.has(target.repository.toLowerCase())) throw new HttpError(404, "github_repository_unavailable", "Unavailable");
      return { repository: target.repository, repositoryId: ids[target.repository.toLowerCase()]! };
    });
    org = randomUUID(); creator = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Org',$3,false,true)`, [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
  });

  async function activeBuild(policy: 2 | 3) {
    const build = await computers.enqueue(org, creator, { repositories: [
      { repository: "example/project", branch: "main" }, { repository: "example/docs", branch: "main" }] });
    await pool.query("UPDATE cloud_v2_computer_builds SET source_policy_version=$2 WHERE id=$1", [build.id, policy]);
    await computers.claim(); await computers.activate(build.id, `snapshot-v${policy}`);
    return build.id;
  }
  async function create() {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: creator } as never); await next(); });
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    app.route("/", createCloudV2Routes({ store, computers, installedRepositories: id => store.installedRepositories(id),
      authorizeBuildRepository: (o, u, b, r) => computers.resolveBuildRepository(o, u, b, r),
      remoteHead: vi.fn(async () => "a".repeat(40)), authorizeSource: async () => {}, bridgeBaseUrl: "wss://example.test" }));
    const response = await app.request("/v1/cloud-v2/workspaces", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: org, repository: "example/project" }) });
    expect(response.status).toBe(201);
    return (await response.json()).workspace.id as string;
  }
  const scope = async (id: string) => ({
    names: (await pool.query("SELECT source_repositories FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].source_repositories,
    ids: (await pool.query("SELECT source_repository,repository_id::text FROM cloud_v2_github_sources WHERE workspace_id=$1 ORDER BY 1", [id])).rows,
  });

  it("gives a creator who can read every v3 repository the whole scope and the kept image", async () => {
    await activeBuild(3);
    const id = await create();
    expect(await scope(id)).toEqual({ names: ["example/project", "example/docs"],
      ids: [{ source_repository: "example/docs", repository_id: "43" }, { source_repository: "example/project", repository_id: "42" }] });
    expect(await store.workspaceImage(id)).toEqual({ from: "snapshot-v3", prune: ["example/docs"], checkout: true });
  });

  it("keeps a creator without access to another v3 repository on the stock image with only their own source", async () => {
    await activeBuild(3);
    unreadable.add("example/docs");
    const id = await create();
    expect(await scope(id)).toEqual({ names: ["example/project"], ids: [{ source_repository: "example/project", repository_id: "42" }] });
    expect(await store.workspaceImage(id)).toEqual({ from: null, prune: [], checkout: false });
  });

  it("keeps v2 images source-free and narrow whatever the creator can read", async () => {
    await activeBuild(2);
    const id = await create();
    expect((await scope(id)).names).toEqual(["example/project"]);
    expect(await store.workspaceImage(id)).toEqual({ from: "snapshot-v2", prune: [], checkout: false });
  });

  it.each([
    ["covering", false, { from: "snapshot-v3", prune: ["example/docs"] }],
    ["narrow", true, { from: null }],
  ] as const)("restores a %s scope onto the image that rule allows", async (_name, narrow, expected) => {
    await activeBuild(3);
    if (narrow) unreadable.add("example/docs");
    const id = await create();
    await pool.query(`UPDATE cloud_v2_workspaces SET state='starting', boat_sandbox_id='bx_lost1',
      checkpoint_object=$2, checkpoint_key='{"sealed":"fixture"}', checkpoint_sha256=$3, checkpoint_bytes=100,
      checkpoint_saved_at=clock_timestamp() WHERE id=$1`, [id, `cloud-v2/checkpoints/${id}/${randomUUID()}.zck`, "a".repeat(64)]);
    const begun = await store.beginRestore(id, "bx_lost1", { attempt: randomUUID(), name: "zeros-restore", env: {} });
    expect(begun).toMatchObject({ create: expected });
    if (narrow) expect(begun && typeof begun === "object" ? begun.create.prune : undefined).toBeUndefined();
  });
});
