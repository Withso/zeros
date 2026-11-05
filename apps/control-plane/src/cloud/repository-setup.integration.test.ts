import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Computers } from "./computer.js";
import { createCloudGithubServices } from "./github-composition.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("repository setup selection through restore", () => {
  let pool: pg.Pool, store: CloudV2Store, computers: CloudV2Computers;
  let org: string, user: string, repositoryId: string;
  let services: ReturnType<typeof createCloudGithubServices>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    org = randomUUID(); user = randomUUID(); repositoryId = "42";
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Setup fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Setup fixture',$3,false,true)", [org, `setup-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    store = new CloudV2Store(pool);
    computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId }));
    services = createCloudGithubServices(pool, null, { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } }, store);
  });
  async function build(selection: { setup?: string; setupScript?: string }) {
    const build = await computers.enqueue(org, user, { repositories: [{ repository: "fixture/repo", ...selection }] });
    await computers.claim(); await computers.activate(build.id, `fixture-${build.id}`);
    return build.id;
  }
  async function workspace(selection: { setup?: string; setupScript?: string }) {
    const computerBuildId = await build(selection);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: user, name: "Setup",
      repository: "fixture/repo", branch: "topic", baseBranch: "main", computerBuildId });
    await pool.query(`UPDATE cloud_v2_workspaces SET state='starting', checkpoint_object=$2, checkpoint_key='{}'::jsonb,
      checkpoint_sha256=$3, checkpoint_bytes=1, checkpoint_saved_at=clock_timestamp() WHERE id=$1`,
      [workspace.id, `cloud-v2/checkpoints/${org}/${workspace.id}.zck`, "a".repeat(64)]);
    return store.get(workspace.id, user);
  }
  async function restore(workspace: CloudV2Workspace, lost: string | null = null) {
    const attempt = randomUUID();
    const restored = await store.beginRestore(workspace.id, lost, { attempt, name: `fixture-${attempt}`, env: {} });
    expect(restored).not.toBeNull(); expect(restored).not.toBe("no_computer");
    return { workspace: await store.get(workspace.id, user), attempt, restored };
  }
  it.each([
    { setup: "echo original", setupScript: "fixture-setup/original.sh" },
    { setup: "echo original" },
    {},
  ])("keeps the original selection %j when the same repository selects another script", async selection => {
    const original = await workspace(selection);
    const before = await services.workspaceSetup(original, computers);
    expect(before).toEqual(Object.keys(selection).length ? selection : null);
    await build({ setup: "echo replacement", setupScript: "fixture-setup/replacement.sh" });
    const current = await restore(original);
    expect(current.workspace.computerBuildId).not.toBe(original.computerBuildId);
    expect(await services.workspaceSetup(current.workspace, computers)).toEqual(before);
  });
  it("retains the first selection through two replacement disks", async () => {
    const original = await workspace({ setup: "echo original", setupScript: "fixture-setup/first.sh" });
    const before = await services.workspaceSetup(original, computers);
    await build({ setup: "echo second", setupScript: "fixture-setup/second.sh" });
    const first = await restore(original);
    await store.replaceSandbox(original.id, first.attempt, "bx_setup001", new Date());
    await store.finishRestore(original.id, "bx_setup001");
    await build({ setup: "echo third", setupScript: "fixture-setup/third.sh" });
    const second = await restore(first.workspace, "bx_setup001");
    expect(await services.workspaceSetup(second.workspace, computers)).toEqual(before);
  });
  it("never takes a reused name's replacement source", async () => {
    const original = await workspace({ setup: "echo original", setupScript: "fixture-setup/original.sh" });
    await computers.saveRecipe(org, user, [], 0);
    repositoryId = "99";
    await build({ setup: "echo replacement", setupScript: "fixture-setup/replacement.sh" });
    const current = await restore(original);
    expect(await services.workspaceSetup(current.workspace, computers)).toBeNull();
    expect((await services.identities.primary(current.workspace)).repositoryId).toBe("42");
  });
  it("keeps setup pins internal to the restore journal", async () => {
    const original = await workspace({ setupScript: "fixture-setup/original.sh" });
    await build({ setupScript: "fixture-setup/replacement.sh" });
    const current = await restore(original);
    expect(current.restored).toEqual({ attempt: current.attempt, create: {
      from: expect.any(String), name: `fixture-${current.attempt}`, env: {}, requestedAt: expect.any(String),
    } });
    const journal = (await pool.query("SELECT restore_create FROM cloud_v2_workspaces WHERE id=$1", [original.id])).rows[0].restore_create;
    expect(journal.setupBuildId).toBe(original.computerBuildId);
    const live = (await store.claimPending(10, 1000)).find(value => value.id === original.id);
    expect(live?.restoreCreate).toEqual((current.restored as { create: unknown }).create);
  });
  it("refuses a selected script on an old restore journal without a proven original pin", async () => {
    const original = await workspace({ setupScript: "fixture-setup/original.sh" });
    await pool.query("UPDATE cloud_v2_workspaces SET restore_create=$2::jsonb WHERE id=$1", [original.id,
      JSON.stringify({ from: "old-snapshot", name: "old-restore", env: {}, requestedAt: new Date().toISOString() })]);
    await expect(services.workspaceSetup(original, computers)).rejects.toMatchObject({ code: "cloud_repository_setup_review_required" });
    await build({ setupScript: "fixture-setup/replacement.sh" });
    const current = await restore(original);
    await expect(services.workspaceSetup(current.workspace, computers)).rejects.toMatchObject({ code: "cloud_repository_setup_review_required" });
  });
  it("preserves an explicitly empty original pin and refuses malformed pins", async () => {
    const original = await workspace({ setupScript: "fixture-setup/current.sh" });
    await pool.query("UPDATE cloud_v2_workspaces SET restore_create=$2::jsonb WHERE id=$1", [original.id, JSON.stringify({ setupBuildId: null })]);
    expect(await services.workspaceSetup(original, computers)).toBeNull();
    await build({ setupScript: "fixture-setup/replacement.sh" });
    const current = await restore(original);
    expect(await services.workspaceSetup(current.workspace, computers)).toBeNull();
    await pool.query("UPDATE cloud_v2_workspaces SET restore_create=$2::jsonb WHERE id=$1", [original.id, JSON.stringify({ setupBuildId: "not-a-build" })]);
    await expect(services.workspaceSetup(current.workspace, computers)).rejects.toMatchObject({ code: "cloud_repository_setup_review_required" });
  });
});
