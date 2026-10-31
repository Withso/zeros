import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import type { CloudV2Compute } from "./boat.js";
import { CloudV2ComputerBuilder, CloudV2Computers, cloudV2SnapshotName } from "./computer.js";
import { CloudProviderError } from "./provider-error.js";
import { CloudV2Store } from "./store.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const commit = "a".repeat(40);
const fixtureRepositoryId = (repository: string) => BigInt(`0x${createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 12)}`).toString();
const resolveRepository: CloudV2ComputerSourceResolver = async (_org, _user, target) => ({
  repository: target.repository, repositoryId: target.repositoryId ?? fixtureRepositoryId(target.repository),
});

d("cloud v2 Cloud Computer builds", () => {
  let pool: pg.Pool;
  let computers: CloudV2Computers;
  let org: string;
  let admin: string;
  let member: string;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    computers = new CloudV2Computers(pool, pool, resolveRepository);
    [admin, member] = [randomUUID(), randomUUID()];
    for (const id of [admin, member]) await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')`, [id, `u-${id}@example.test`]);
    await grantTestPro(pool, admin, member);
    org = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)`,
      [org, `org-${org}`, admin]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [org, admin, member]);
  });

  const recipe = { repositories: [{ repository: "withso/zeros", setup: "pnpm install" }] };
  const runtime = { sha256: "b".repeat(64), url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" };

  function compute(): CloudV2Compute {
    return {
      create: vi.fn(async () => ({ sandboxId: "bx_build1" })),
      resume: vi.fn(async () => {}),
      extendLease: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      exec: vi.fn(async (_id: string, command: string) => ({ exitCode: 0, stdout: command.includes("rev-parse") ? `Cloning\n${commit}\n` : "installed", timedOut: false })),
      execLong: vi.fn(async (_id: string, command: string) => ({ exitCode: 0, stdout: command.includes("rev-parse") ? `Cloning\nzeros-build-branch=master\n${commit}\n` : "installed", timedOut: false })),
      saveSnapshot: vi.fn(async () => {}),
      deleteSnapshot: vi.fn(async () => {}),
    };
  }

  it("lets only owners and admins build, one build at a time", async () => {
    await expect(computers.requireAdmin(org, member)).rejects.toMatchObject({ status: 403 });
    await computers.requireAdmin(org, admin);
    const first = await computers.enqueue(org, admin, recipe);
    expect(first.version).toBe(1);
    await expect(computers.enqueue(org, admin, recipe)).rejects.toMatchObject({ code: "computer_build_in_progress" });
  });

  it.each(["save", "discard", "enqueue", "configured", "reactivate", "automatic"] as const)(
    "rechecks the administrator after an organization lock wait (%s)", async operation => {
      await pool.query("UPDATE organization_members SET role='owner' WHERE org_id=$1 AND user_id=$2", [org, member]);
      const previous = await computers.enqueue(org, admin, recipe, { configure: true });
      await computers.claim();
      await computers.activate(previous.id, "security-role-fixture");
      await computers.requireAdmin(org, admin);
      const blocker = await pool.connect();
      let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [org]);
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const actions = {
          save: () => computers.saveRecipe(org, admin, [{ repository: "example/new" }], 1),
          discard: () => computers.discardRecipe(org, admin, 1),
          enqueue: () => computers.enqueue(org, admin, recipe),
          configured: () => computers.buildConfigured(org, admin, 1),
          reactivate: () => computers.reactivate(org, admin, previous.id),
          automatic: () => computers.enqueueAutomatic(org, previous.id, "runtime", runtime.sha256),
        };
        pending = actions[operation]().then(value => ({ value }), error => ({ error }));
        await vi.waitFor(async () => {
          expect((await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount).toBeGreaterThan(0);
        });
        await blocker.query("UPDATE organization_members SET role='member',authorization_revision=authorization_revision+1 WHERE org_id=$1 AND user_id=$2", [org, admin]);
        await blocker.query("COMMIT");
        if (operation === "automatic") expect(await pending).toEqual({ value: null });
        else expect(await pending).toMatchObject({ error: { status: 403 } });
        const overview = await computers.overview(org);
        expect(overview.recipeRevision).toBe(1);
        expect(overview.builds).toHaveLength(1);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        await pending;
      }
    },
  );

  it("allows ordinary members to read the Computer's repositories", async () => {
    await expect(computers.requireMember(org, member)).resolves.toBeUndefined();
    await expect(computers.requireMember(org, randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it("does not run a queued build after its creator loses administration", async () => {
    const boat = compute(), cloneToken = vi.fn(async () => "synthetic");
    await computers.enqueue(org, admin, recipe);
    await pool.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [org, admin]);
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken });
    await builder.tick();
    expect(boat.create).not.toHaveBeenCalled();
    expect(cloneToken).not.toHaveBeenCalled();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "cancelled", errorCode: "computer_admin_access_lost" });
  });

  it("does not activate a build when its creator is demoted during setup", async () => {
    const boat = compute();
    vi.mocked(boat.execLong).mockImplementation(async (_id, command) => {
      if (command.includes("pnpm install"))
        await pool.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [org, admin]);
      return { exitCode: 0, stdout: command.includes("rev-parse") ? `zeros-build-branch=master\n${commit}\n` : "installed", timedOut: false };
    });
    const job = await computers.enqueue(org, admin, recipe);
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "synthetic" });
    await builder.tick();
    expect((await computers.overview(org)).activeBuildId).toBeNull();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "cancelled", errorCode: "computer_admin_access_lost" });
    expect(boat.deleteSnapshot).toHaveBeenCalledWith(cloudV2SnapshotName("alpha", org, job.version));
  });

  it("keeps exact source IDs on clean builds and refuses inherited legacy log scope", async () => {
    const old = await computers.enqueue(org, admin, { repositories: [{ repository: "example/removed" }] });
    await computers.claim(); await computers.activate(old.id, "legacy-log-source");
    const current = await computers.enqueue(org, admin, recipe);
    await computers.claim(); await computers.activate(current.id, "current-log-source");
    expect(await computers.logRepositories(org, current.id)).toEqual([{ repository: "withso/zeros", repositoryId: fixtureRepositoryId("withso/zeros") }]);
    await pool.query("UPDATE cloud_v2_computer_builds SET source_policy_version=1 WHERE id=$1", [current.id]);
    await expect(computers.logRepositories(org, current.id)).rejects.toMatchObject({ code: "cloud_source_review_required" });
  });

  it.each(["disabled", "deleted"])("hides a %s organization from members", async state => {
    const column = { disabled: "cloud_workspaces_allowed = false", deleted: "deleted_at = now()" }[state]!;
    await pool.query(`UPDATE organizations SET ${column} WHERE id = $1`, [org]);
    await expect(computers.requireMember(org, member)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps Personal organizations outside cloud even when the user is a member", async () => {
    const personal = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed)
      VALUES ($1, $2, 'Personal', $3, true, false)`, [personal, `personal-${personal}`, member]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [personal, member]);
    await expect(computers.requireMember(personal, member)).rejects.toMatchObject({ status: 404 });
  });

  it("builds, pins commits, goes live as the one named snapshot and retires the previous one", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    const first = await computers.enqueue(org, admin, recipe);
    await builder.tick();
    // Builds start from Boat's stock image and cache the current runtime first.
    expect(boat.create).toHaveBeenCalledWith({ key: first.id, name: `zeros-alpha-build-${first.id.slice(0, 8)}`, env: {} });
    expect(vi.mocked(boat.exec).mock.calls[0]![1]).toContain(`/opt/zeros/runtime/${"b".repeat(64)}`);
    let overview = await computers.overview(org);
    expect(overview.snapshotName).toBe(cloudV2SnapshotName("alpha", org, 1));
    expect(overview.builds[0]).toMatchObject({ state: "succeeded", version: 1 });
    expect(overview.builds[0]!.recipe.repositories[0]).toMatchObject({ commit, branch: "master" });
    expect(await new CloudV2Store(pool).installedRepositories(org)).toEqual([{ repository: "withso/zeros", defaultBranch: "master" }]);
    const cloneCommand = vi.mocked(boat.execLong).mock.calls[0]![1];
    expect(cloneCommand).not.toContain("ghs_token");
    expect(cloneCommand).not.toContain(Buffer.from("x-access-token:ghs_token").toString("base64"));
    // A named snapshot is an independent copy: the builder goes as soon as it is ready.
    expect(boat.saveSnapshot).toHaveBeenCalledWith("bx_build1", cloudV2SnapshotName("alpha", org, 1));
    // Shared images must be captured before any repository or setup script can
    // leave source, caches, history, or copied artifacts anywhere on the disk.
    expect(vi.mocked(boat.saveSnapshot).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(boat.execLong).mock.invocationCallOrder[0]!);
    expect(boat.delete).toHaveBeenCalledWith("bx_build1");
    expect(boat.stop).not.toHaveBeenCalled();

    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await computers.reactivate(org, admin, overview.builds[0]!.id);
    await builder.tick();
    expect(vi.mocked(boat.create).mock.calls.every(([request]) => !request.from)).toBe(true);
    overview = await computers.overview(org);
    expect(overview.snapshotName).toBe(cloudV2SnapshotName("alpha", org, 2));
    expect(overview.builds[0]!.recipe).toMatchObject({ rebuiltFrom: 1 });
    expect(overview.builds[0]!.recipe.repositories[0]!.commit).toBe(commit);
    // The pinned build's branch hint is settled before HEAD is detached at its commit.
    const rebuildClone = vi.mocked(boat.execLong).mock.calls.find(([, command]) => command.includes("checkout --detach"))![1];
    expect(rebuildClone.indexOf("zeros_build_branch=")).toBeGreaterThan(0);
    expect(rebuildClone.indexOf("zeros_build_branch=")).toBeLessThan(rebuildClone.indexOf("checkout --detach"));
    expect(boat.deleteSnapshot).toHaveBeenCalledWith(cloudV2SnapshotName("alpha", org, 1));
    expect(boat.delete).toHaveBeenLastCalledWith("bx_build2");
    expect(overview.builds[1]).toMatchObject({ state: "succeeded", snapshotId: null });
  });

  it("uses only the observed branch, never a tag or commit ref, as the default", async () => {
    const store = new CloudV2Store(pool);
    expect(await store.installedRepositories(org)).toBeNull();
    const queued = await computers.enqueue(org, admin, { repositories: [
      { repository: "example/explicit", ref: "release/stable", branch: "master" },
      { repository: "example/cloned", branch: "master" },
      { repository: "example/legacy", ref: "v1.2.3" },
    ] });
    await computers.claim();
    expect(await store.installedRepositories(org)).toBeNull();
    await computers.activate(queued.id, "test-snapshot");
    expect(await store.installedRepositories(org)).toEqual([
      { repository: "example/explicit", defaultBranch: "master" },
      { repository: "example/cloned", defaultBranch: "master" },
      { repository: "example/legacy", defaultBranch: null },
    ]);
  });

  it("uses its local namespace for builds and for snapshot cleanup after a lost name", async () => {
    const boat = compute(), localOwner = "a".repeat(24);
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "development", localOwner, runtime, cloneToken: async () => "fixture" });
    const job = await computers.enqueue(org, admin, recipe);
    await builder.tick();
    const name = cloudV2SnapshotName("development", org, 1, localOwner);
    expect(boat.saveSnapshot).toHaveBeenCalledWith("bx_build1", name);
    expect(boat.create).toHaveBeenCalledWith(expect.objectContaining({ name: `zeros-local-${localOwner}-build-${job.id.slice(0, 8)}` }));
    expect((await computers.overview(org)).snapshotName).toBe(name);
    await pool.query("UPDATE cloud_v2_computers SET active_build_id=NULL,snapshot_name=NULL WHERE org_id=$1", [org]);
    await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id=NULL,cleanup_requested_at=now() WHERE id=$1", [job.id]);
    await builder.cleanup();
    expect(boat.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(name);
    expect((await pool.query("SELECT snapshot_deleted_at FROM cloud_v2_computer_builds WHERE id=$1", [job.id])).rows[0].snapshot_deleted_at).not.toBeNull();
  });

  it.each(["tag", "commit"])("records a verified remote branch when the Computer is pinned to a %s", async source => {
    const root = await mkdtemp(join(tmpdir(), "zeros-computer-branch-"));
    const run = promisify(execFile);
    const origin = join(root, "origin");
    try {
      await run("git", ["init", "--initial-branch=master", origin]);
      await writeFile(join(origin, "README.md"), "fixture\n");
      await run("git", ["-C", origin, "add", "README.md"]);
      await run("git", ["-C", origin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
      await run("git", ["-C", origin, "tag", "v1.2.3"]);
      const pinnedCommit = (await run("git", ["-C", origin, "rev-parse", "HEAD"])).stdout.trim();
      const boat = compute();
      vi.mocked(boat.execLong).mockImplementation(async (_id, command, _timeout, input) => {
        const local = command.replaceAll("https://github.com/example/project.git", origin)
          .replaceAll("/home/user", join(root, "checkouts"));
        const child = run("bash", ["-c", local]);
        child.child.stdin?.end(input);
        const result = await child;
        return { exitCode: 0, stdout: result.stdout, timedOut: false };
      });
      const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "fixture" });
      await computers.enqueue(org, admin, { repositories: [{ repository: "example/project",
        ...(source === "tag" ? { ref: "v1.2.3" } : { commit: pinnedCommit }) }] });
      await builder.tick();
      const overview = await computers.overview(org);
      expect(overview.builds[0]).toMatchObject({ state: "succeeded", recipe: { repositories: [{ branch: "master", commit: pinnedCommit }] } });
      expect(await new CloudV2Store(pool).installedRepositories(org)).toEqual([{ repository: "example/project", defaultBranch: "master" }]);
      // The disposable builder verifies that the recorded branch can be used.
      await run("git", ["-C", join(root, "checkouts/example/project"), "switch", "-c", "zeros/created", "origin/master"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records a failed setup without touching the live snapshot", async () => {
    const boat = compute();
    vi.mocked(boat.execLong).mockResolvedValueOnce({ exitCode: 0, stdout: commit, timedOut: false })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "ERR! missing", timedOut: false });
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    const build = await computers.enqueue(org, admin, recipe);
    await builder.tick();
    const overview = await computers.overview(org);
    expect(overview.snapshotName).toBeNull();
    expect(overview.builds[0]).toMatchObject({ state: "failed", errorCode: "computer_setup_failed" });
    expect(await computers.log(org, build.id)).toContain("ERR! missing");
    expect(boat.saveSnapshot).toHaveBeenCalledOnce();
    expect(boat.deleteSnapshot).toHaveBeenCalled();
    expect(boat.delete).toHaveBeenCalledWith("bx_build1");
  });

  it("fails a build whose server stopped mid-build, removes its builder and accepts a new build", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    const lost = await computers.enqueue(org, admin, recipe);
    await computers.claim();
    await computers.update(lost.id, { builderSandboxId: "bx_lost1" });
    await pool.query(`UPDATE cloud_v2_computer_builds SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [lost.id]);
    await expect(computers.enqueue(org, admin, recipe)).rejects.toMatchObject({ code: "computer_build_in_progress" });
    await builder.tick();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ id: lost.id, state: "failed", errorCode: "computer_build_interrupted" });
    expect(boat.delete).toHaveBeenCalledWith("bx_lost1");
    expect((await computers.enqueue(org, admin, recipe)).version).toBe(2);
  });

  it("retains a replaced snapshot's identity until Boat confirms deletion, then retries", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "fixture" });
    const first = await computers.enqueue(org, admin, recipe); await builder.tick();
    vi.mocked(boat.deleteSnapshot).mockRejectedValue(new Error("temporary failure"));
    await computers.enqueue(org, admin, recipe); await builder.tick();
    expect((await computers.overview(org)).builds.find(build => build.id === first.id)?.snapshotId)
      .toBe(cloudV2SnapshotName("alpha", org, 1));
    vi.mocked(boat.deleteSnapshot).mockResolvedValue(undefined);
    await builder.cleanup();
    expect((await computers.overview(org)).builds.find(build => build.id === first.id)?.snapshotId).toBeNull();
    expect((await computers.overview(org)).snapshotName).toBe(cloudV2SnapshotName("alpha", org, 2));
  });
  it("keeps the configured repositories as an organization setting that a build makes live", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    let overview = await computers.overview(org);
    expect(overview).toMatchObject({ recipe: { repositories: [] }, recipeRevision: 0, activeBuildId: null });
    await expect(computers.buildConfigured(org, admin, 0)).rejects.toMatchObject({ code: "computer_recipe_empty" });
    await computers.saveRecipe(org, admin, [{ repository: "withso/zeros", setup: "pnpm install" }], 0);
    await expect(computers.saveRecipe(org, admin, [], 0)).rejects.toMatchObject({ code: "computer_recipe_changed" });
    await expect(computers.buildConfigured(org, admin, 0)).rejects.toMatchObject({ code: "computer_recipe_changed" });
    await expect(computers.saveRecipe(org, admin, [{ repository: "withso/zeros" }, { repository: "WITHSO/zeros" }], 1)).rejects.toThrow();
    const first = await computers.buildConfigured(org, admin, 1);
    expect(first).toMatchObject({ reason: "manual", baseSnapshot: null, recipe: { repositories: [{ repository: "withso/zeros", setup: "pnpm install" }] } });
    await builder.tick();
    overview = await computers.overview(org);
    expect(overview.activeBuildId).toBe(first.id);
    expect(overview.builds[0]).toMatchObject({ state: "succeeded", runtimeSha256: "b".repeat(64) });
    // Build outputs (commit, branch) never enter the editable recipe.
    expect(overview.recipe.repositories).toEqual([{ repository: "withso/zeros", setup: "pnpm install" }]);
    // An added repository stays beside the installed one until it is removed.
    await computers.saveRecipe(org, admin, [...overview.recipe.repositories, { repository: "withso/zeros-dev-fixture" }], overview.recipeRevision);
    overview = await computers.overview(org);
    expect(overview.recipe.repositories.map(row => row.repository)).toEqual(["withso/zeros", "withso/zeros-dev-fixture"]);
    expect(await new CloudV2Store(pool).installedRepositories(org)).toEqual([{ repository: "withso/zeros", defaultBranch: "master" }]);
    const discarded = await computers.discardRecipe(org, admin, overview.recipeRevision);
    expect(discarded.recipe.repositories).toEqual([{ repository: "withso/zeros", setup: "pnpm install" }]);
    expect((await computers.overview(org)).recipe.repositories).toEqual(discarded.recipe.repositories);
  });

  it("makes an older build's repositories the configured ones when it is activated again", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    const first = await computers.enqueue(org, admin, recipe, { configure: true }); await builder.tick();
    let overview = await computers.overview(org);
    await computers.saveRecipe(org, admin, [{ repository: "withso/other" }], overview.recipeRevision);
    await computers.buildConfigured(org, admin, overview.recipeRevision + 1); await builder.tick();
    await computers.reactivate(org, admin, first.id); await builder.tick();
    overview = await computers.overview(org);
    expect(overview.builds[0]).toMatchObject({ reason: "reactivate", state: "succeeded", recipe: { rebuiltFrom: 1 } });
    expect(overview.recipe.repositories).toEqual([{ repository: "withso/zeros", setup: "pnpm install" }]);
  });

  it("rebuilds from stock so removed repositories and copied artifacts cannot survive", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    await computers.enqueue(org, admin, { repositories: [{ repository: "withso/zeros" }, { repository: "withso/old" }] });
    await builder.tick();
    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    const second = await computers.enqueue(org, admin, { repositories: [{ repository: "withso/zeros" }, { repository: "withso/new" }] });
    expect(second.baseSnapshot).toBe(cloudV2SnapshotName("alpha", org, 1));
    await builder.tick();
    expect(boat.create).toHaveBeenLastCalledWith({ key: second.id,
      name: `zeros-alpha-build-${second.id.slice(0, 8)}`, env: {} });
    expect(vi.mocked(boat.exec).mock.calls.some(([, command]) => command.includes("rm -rf -- "))).toBe(false);
    expect((await computers.overview(org)).builds[0]).toMatchObject({ id: second.id, state: "succeeded" });
  });

  it("validates current source and setup on fresh disposable builders with a real Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-computer-refresh-"));
    const run = promisify(execFile);
    const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args]);
    const origin = (name: string) => join(root, "origins", name);
    try {
      for (const name of ["kept", "added", "dropped"]) {
        await run("git", ["init", "--initial-branch=master", origin(name)]);
        await writeFile(join(origin(name), ".gitignore"), "node_modules/\n");
        await writeFile(join(origin(name), "README.md"), `${name}\n`);
        await git(origin(name), "add", ".");
        await git(origin(name), "commit", "-m", "first");
      }
      const local = (command: string) => {
        let text = command.replaceAll("/home/user", join(root, "checkouts"));
        for (const name of ["kept", "added", "dropped"]) text = text.replaceAll(`https://github.com/example/${name}.git`, origin(name));
        return text;
      };
      const boat = compute();
      const shell = async (_id: string, command: string, _timeout?: number, input?: string) => {
        const child = run("bash", ["-c", local(command)]);
        child.child.stdin?.end(input);
        const result = await child;
        return { exitCode: 0, stdout: result.stdout, timedOut: false };
      };
      vi.mocked(boat.execLong).mockImplementation(shell);
      vi.mocked(boat.exec).mockImplementation(async (id, command) => command.includes("rm -rf -- ") ? shell(id, command)
        : { exitCode: 0, stdout: "installed", timedOut: false });
      const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "fixture" });
      const setup = "mkdir -p node_modules && echo installed >> node_modules/marker";
      await computers.enqueue(org, admin, { repositories: [{ repository: "example/kept", setup }, { repository: "example/dropped" }] });
      await builder.tick();
      await writeFile(join(origin("kept"), "README.md"), "kept, second\n");
      await git(origin("kept"), "commit", "-am", "second");
      const head = (await run("git", ["-C", origin("kept"), "rev-parse", "HEAD"])).stdout.trim();
      // Each build gets a new stock disk; old caches never enter a shared image.
      await rm(join(root, "checkouts"), { recursive: true, force: true });
      await computers.enqueue(org, admin, { repositories: [{ repository: "example/kept", setup }, { repository: "example/added" }] });
      await builder.tick();
      const overview = await computers.overview(org);
      expect(overview.builds[0]).toMatchObject({ state: "succeeded", recipe: { repositories: [
        { repository: "example/kept", branch: "master", commit: head }, { repository: "example/added", branch: "master" },
      ] } });
      const checkouts = join(root, "checkouts/example");
      expect((await run("cat", [join(checkouts, "kept/node_modules/marker")])).stdout).toBe("installed\n");
      expect((await run("cat", [join(checkouts, "kept/README.md")])).stdout).toBe("kept, second\n");
      expect((await run("ls", [checkouts])).stdout.split("\n").filter(Boolean)).toEqual(["added", "kept"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it("rebuilds a clean image on runtime changes, verifies the pinned recipe, and backs off failures", async () => {
    const boat = compute();
    await computers.enqueue(org, admin, recipe);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
    vi.mocked(boat.execLong).mockClear();
    const next = { sha256: "c".repeat(64), url: runtime.url };
    let now = Date.now();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime: next, cloneToken: async () => "ghs_token", now: () => now });
    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await builder.scheduleRefreshes(); await builder.tick();
    let overview = await computers.overview(org);
    expect(overview.builds[0]).toMatchObject({ reason: "runtime", state: "succeeded", runtimeSha256: "c".repeat(64),
      baseSnapshot: cloudV2SnapshotName("alpha", org, 1), recipe: { repositories: [{ repository: "withso/zeros", commit, branch: "master" }] } });
    expect(boat.execLong).toHaveBeenCalledTimes(2);
    expect(vi.mocked(boat.exec).mock.calls.some(([, command]) => command.includes(`/opt/zeros/runtime/${"c".repeat(64)}`))).toBe(true);

    // A refresh that keeps failing is retried later, not on every scan.
    const failing = { sha256: "d".repeat(64), url: runtime.url };
    const retrying = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime: failing, cloneToken: async () => "ghs_token", now: () => now });
    vi.mocked(boat.exec).mockResolvedValueOnce({ exitCode: 1, stdout: "", timedOut: false });
    await retrying.scheduleRefreshes(); await retrying.tick();
    overview = await computers.overview(org);
    expect(overview.builds[0]).toMatchObject({ reason: "runtime", state: "failed", runtimeSha256: "d".repeat(64) });
    now += 11 * 60_000;
    await retrying.scheduleRefreshes(); await retrying.tick();
    expect((await computers.overview(org)).builds[0]!.id).toBe(overview.builds[0]!.id);
  });

  it("refreshes the runtime of a live snapshot built before builds recorded their runtime", async () => {
    const boat = compute();
    await computers.enqueue(org, admin, recipe);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
    // Builds from before migration 0204 have no recorded runtime.
    await pool.query(`UPDATE cloud_v2_computer_builds SET runtime_sha256 = NULL WHERE org_id = $1`, [org]);
    vi.mocked(boat.execLong).mockClear();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await builder.scheduleRefreshes(); await builder.tick();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ reason: "runtime", state: "succeeded", runtimeSha256: runtime.sha256,
      recipe: { repositories: [{ repository: "withso/zeros", commit, branch: "master" }] } });
    expect(boat.execLong).toHaveBeenCalledTimes(2);
    // Recorded now, so the same pin is not refreshed again.
    expect(await computers.refreshCandidates(runtime.sha256)).toEqual([]);
  });

  it("installs the runtime a refresh was queued for, even when a process on another pin runs it", async () => {
    const boat = compute();
    await computers.enqueue(org, admin, recipe);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
    // A process on the new pin queues the refresh; one still on the old pin, during a redeploy, picks it up.
    await computers.enqueueAutomatic(org, (await computers.overview(org)).activeBuildId!, "runtime", "c".repeat(64));
    const url = vi.fn(async (sha256?: string) => `https://r2.example.test/${sha256}.tar.gz?sig=1`);
    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime: { sha256: runtime.sha256, url }, cloneToken: async () => "ghs_token" }).tick();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ reason: "runtime", state: "succeeded", runtimeSha256: "c".repeat(64) });
    expect(url).toHaveBeenCalledWith("c".repeat(64));
    expect(vi.mocked(boat.exec).mock.calls.some(([, command]) => command.includes(`/opt/zeros/runtime/${"c".repeat(64)}`))).toBe(true);
  });

  it("keeps the worker pool's query slots free while a build and a cleanup each hold their lock", async () => {
    // Cloud v2 runs on a two-slot worker pool; build locks come from their own pool.
    const worker = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, connectionTimeoutMillis: 1_000 });
    const locks = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, connectionTimeoutMillis: 1_000 });
    try {
      const separate = new CloudV2Computers(worker, locks, resolveRepository);
      await separate.withBuildLock(randomUUID(), async () => {
        await separate.withBuildLock(randomUUID(), async () => {
          // The lifecycle and the build's own queries still get a connection.
          await expect(Promise.all([separate.cleanupCandidates(), separate.cleanupCandidates()])).resolves.toHaveLength(2);
        });
      });
    } finally { await Promise.all([worker.end(), locks.end()]); }
  });

  it("refreshes once a day while the organization uses cloud, only when a branch moved", async () => {
    const boat = compute();
    await computers.enqueue(org, admin, recipe);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
    await pool.query(`UPDATE cloud_v2_computer_builds SET created_at = now() - interval '25 hours', finished_at = now() - interval '25 hours' WHERE org_id = $1`, [org]);
    let now = Date.now(), head: string | null = commit;
    const remoteHead = vi.fn(async () => head);
    const builder = () => new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token", remoteHead, now: () => now });
    // No recent cloud use: nothing to keep fresh.
    await builder().scheduleRefreshes();
    expect(remoteHead).not.toHaveBeenCalled();
    await new CloudV2Store(pool).createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: admin, name: "w",
      repository: "withso/zeros", branch: "zeros/w", baseBranch: "master", computerBuildId: null });
    const unchanged = builder();
    await unchanged.scheduleRefreshes();
    expect(remoteHead).toHaveBeenCalledWith(org, admin, { repository: "withso/zeros", repositoryId: fixtureRepositoryId("withso/zeros") }, "master");
    expect((await computers.overview(org)).builds).toHaveLength(1);
    // Checked and unchanged: not asked again until tomorrow, by any process.
    now += 11 * 60_000; await builder().scheduleRefreshes();
    expect(remoteHead).toHaveBeenCalledTimes(1);
    await pool.query(`UPDATE cloud_v2_computers SET refresh_next_at = now() - interval '1 minute' WHERE org_id = $1`, [org]);
    // GitHub not answering is not "unchanged": it is asked again after an hour, not a day.
    head = null; now += 11 * 60_000;
    const unknown = builder();
    await unknown.scheduleRefreshes(); now += 11 * 60_000; await unknown.scheduleRefreshes();
    expect(remoteHead).toHaveBeenCalledTimes(2);
    const next = (await pool.query(`SELECT refresh_next_at - now() AS wait FROM cloud_v2_computers WHERE org_id = $1`, [org])).rows[0].wait;
    expect(next.hours ?? 0).toBe(0);
    await pool.query(`UPDATE cloud_v2_computers SET refresh_next_at = now() - interval '1 minute' WHERE org_id = $1`, [org]);
    head = "c".repeat(40); now += 11 * 60_000;
    await unknown.scheduleRefreshes();
    const queued = (await computers.overview(org)).builds[0]!;
    expect(queued).toMatchObject({ reason: "refresh", state: "queued", baseSnapshot: cloudV2SnapshotName("alpha", org, 1),
      recipe: { repositories: [{ repository: "withso/zeros", setup: "pnpm install" }] } });
  });

  it("does not refresh an earlier build an admin activated again, except for a new runtime", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    const first = await computers.enqueue(org, admin, recipe); await builder.tick();
    await computers.reactivate(org, admin, first.id); await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
    await pool.query(`UPDATE cloud_v2_computer_builds SET created_at = now() - interval '25 hours', finished_at = now() - interval '25 hours' WHERE org_id = $1`, [org]);
    await new CloudV2Store(pool).createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: admin, name: "w",
      repository: "withso/zeros", branch: "zeros/w", baseBranch: "master", computerBuildId: null });
    const remoteHead = vi.fn(async () => "c".repeat(40));
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token", remoteHead }).scheduleRefreshes();
    expect(remoteHead).not.toHaveBeenCalled();
    expect((await computers.overview(org)).builds).toHaveLength(2);
  });

  it("does not infer a missing live snapshot from a failed stock-image creation", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    await computers.enqueue(org, admin, recipe); await builder.tick();
    vi.mocked(boat.create).mockRejectedValueOnce(new CloudProviderError("provider_not_found", "Boat API request did not succeed", false, { httpStatus: 404 }));
    const second = await computers.enqueue(org, admin, recipe); await builder.tick();
    let overview = await computers.overview(org);
    expect(overview.builds[0]).toMatchObject({ id: second.id, state: "failed", errorCode: "provider_not_found" });
    expect(overview.snapshotName).toBe(cloudV2SnapshotName("alpha", org, 1));
    expect((await pool.query("SELECT builder_create_pending FROM cloud_v2_computer_builds WHERE id = $1", [second.id])).rows[0].builder_create_pending).toBe(true);
    const third = await computers.enqueue(org, admin, recipe);
    expect(third.baseSnapshot).toBe(cloudV2SnapshotName("alpha", org, 1));
    await builder.tick();
    expect(boat.create).toHaveBeenLastCalledWith({ key: third.id, name: `zeros-alpha-build-${third.id.slice(0, 8)}`, env: {} });
    overview = await computers.overview(org);
    expect(overview).toMatchObject({ activeBuildId: third.id, snapshotName: cloudV2SnapshotName("alpha", org, 3) });
  });

  it("keeps a replaced snapshot while a workspace pinned to it is still creating its VM", async () => {
    const boat = compute(), store = new CloudV2Store(pool);
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    const first = await computers.enqueue(org, admin, recipe); await builder.tick();
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: admin, name: "w",
      repository: "withso/zeros", branch: "zeros/w", baseBranch: "master", computerBuildId: first.id });
    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await computers.enqueue(org, admin, recipe); await builder.tick();
    expect((await computers.overview(org)).snapshotName).toBe(cloudV2SnapshotName("alpha", org, 2));
    expect(boat.deleteSnapshot).not.toHaveBeenCalled();
    await store.defer(workspace.id, "creating", 0, { boatSandboxId: "bx_ws1" });
    await builder.cleanup();
    expect(boat.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(cloudV2SnapshotName("alpha", org, 1));
  });

  it("runs one build at a time, since each holds a dedicated lock connection", async () => {
    const other = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Other', $3, false, true)`,
      [other, `org-${other}`, admin]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [other, admin]);
    const boat = compute();
    let release!: () => void;
    vi.mocked(boat.create).mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { sandboxId: "bx_build1" }; });
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    await computers.enqueue(org, admin, recipe);
    await computers.enqueue(other, admin, recipe);
    const tick = builder.tick();
    await vi.waitFor(() => expect(boat.create).toHaveBeenCalledTimes(1));
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_computer_builds WHERE state = 'building'")).rows[0].n).toBe(1);
    release(); await tick;
  });

  it("never accepts a branch or tag that reads as a Git option", async () => {
    await expect(computers.saveRecipe(org, admin, [{ repository: "withso/zeros", ref: "--upload-pack=touch" }], 0)).rejects.toThrow();
    await expect(computers.enqueue(org, admin, { repositories: [{ repository: "withso/zeros", ref: "-b" }] })).rejects.toThrow();
  });

  it("never queues an automatic refresh from a live build that was replaced meanwhile", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    const first = await computers.enqueue(org, admin, { repositories: [{ repository: "fixture/old" }] }); await builder.tick();
    // The scan read the first build; an admin's build of other repositories went live before it queued.
    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await computers.enqueue(org, admin, { repositories: [{ repository: "fixture/new" }] }); await builder.tick();
    expect(await computers.enqueueAutomatic(org, first.id, "runtime", "c".repeat(64))).toBeNull();
    const live = (await computers.overview(org)).activeBuildId!;
    const queued = await computers.enqueueAutomatic(org, live, "runtime", "c".repeat(64));
    // The recipe comes from the locked live build, never from the stale read.
    expect(queued?.recipe.repositories.map(row => row.repository)).toEqual(["fixture/new"]);
  });

  it("picks the due computer even when many computers with nothing due sort before it", async () => {
    const boat = compute();
    await computers.enqueue(org, admin, recipe);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
    const due = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Due', $3, false, true)`, [due, `org-${due}`, admin]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [due, admin]);
    await computers.enqueue(due, admin, recipe);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime: { sha256: "c".repeat(64), url: runtime.url }, cloneToken: async () => "ghs_token" }).tick();
    // The first computer is current and was built recently: nothing is due there.
    await pool.query(`UPDATE cloud_v2_computer_builds SET finished_at = now() - interval '2 hours' WHERE org_id = $1`, [org]);
    const candidates = await computers.refreshCandidates("c".repeat(64), 1);
    expect(candidates).toEqual([]);
    const stale = await computers.refreshCandidates("d".repeat(64), 1);
    expect(stale.map(row => row.organizationId)).toHaveLength(1);
    expect(stale[0]!.runtimeStale).toBe(true);
  });

  it("keeps the configured repositories when a forgotten live snapshot clears the live build", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    await computers.enqueue(org, admin, recipe, { configure: true }); await builder.tick();
    let overview = await computers.overview(org);
    await computers.discardRecipe(org, admin, overview.recipeRevision);
    overview = await computers.overview(org);
    const missing = await computers.buildConfigured(org, admin, overview.recipeRevision);
    await computers.claim();
    // An explicit missing-snapshot observation can clear its pointer. A stock
    // image create failure cannot establish that the previous snapshot is gone.
    await computers.baseMissing(missing.id, org, overview.snapshotName!);
    await computers.fail(missing.id, "computer_base_missing");
    overview = await computers.overview(org);
    expect(overview.activeBuildId).toBeNull();
    expect(overview.recipe.repositories).toEqual([{ repository: "withso/zeros", setup: "pnpm install" }]);
    const clean = await computers.buildConfigured(org, admin, overview.recipeRevision);
    expect(clean.baseSnapshot).toBeNull();
  });

  it("admits a ready build while a daily refresh scan waits on GitHub", async () => {
    const boat = compute();
    await computers.enqueue(org, admin, recipe);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
    await pool.query(`UPDATE cloud_v2_computer_builds SET created_at = now() - interval '25 hours', finished_at = now() - interval '25 hours' WHERE org_id = $1`, [org]);
    await new CloudV2Store(pool).createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: admin, name: "w",
      repository: "withso/zeros", branch: "zeros/w", baseBranch: "master", computerBuildId: null });
    const other = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Other', $3, false, true)`, [other, `org-${other}`, admin]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [other, admin]);
    let answer!: (sha: string | null) => void;
    const remoteHead = vi.fn(() => new Promise<string | null>(resolve => { answer = resolve; }));
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token", remoteHead });
    const manual = await computers.enqueue(other, admin, recipe);
    await builder.tick();
    expect(remoteHead).toHaveBeenCalledOnce();
    expect((await computers.overview(other)).builds[0]).toMatchObject({ id: manual.id, state: "succeeded" });
    answer(commit);
  });

  it("activates an earlier build at its commit after its branch was deleted, with a real Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-computer-pinned-"));
    const run = promisify(execFile);
    const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args]);
    const origin = join(root, "origin");
    try {
      await run("git", ["init", "--initial-branch=master", origin]);
      await writeFile(join(origin, "README.md"), "base\n");
      await git(origin, "add", "."); await git(origin, "commit", "-m", "base");
      await git(origin, "switch", "-c", "feature");
      await writeFile(join(origin, "README.md"), "feature\n");
      await git(origin, "commit", "-am", "feature");
      const pinned = (await run("git", ["-C", origin, "rev-parse", "HEAD"])).stdout.trim();
      await git(origin, "switch", "master");
      // GitHub serves any commit of the repository by id; emulate that locally.
      await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
      const local = (command: string) => command.replaceAll("https://github.com/example/project.git", origin).replaceAll("/home/user", join(root, "checkouts"));
      const boat = compute();
      vi.mocked(boat.execLong).mockImplementation(async (_id, command, _timeout, input) => {
        const child = run("bash", ["-c", local(command)]);
        child.child.stdin?.end(input);
        const result = await child;
        return { exitCode: 0, stdout: result.stdout, timedOut: false };
      });
      const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "fixture" });
      const first = await computers.enqueue(org, admin, { repositories: [{ repository: "example/project", ref: "feature" }] });
      await builder.tick();
      expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "succeeded", recipe: { repositories: [{ commit: pinned, branch: "feature" }] } });
      await git(origin, "branch", "-D", "feature");
      // In place: the commit is still on the disk the live build left.
      await computers.reactivate(org, admin, first.id); await builder.tick();
      expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "succeeded", reason: "reactivate",
        recipe: { repositories: [{ repository: "example/project", ref: "feature", commit: pinned, branch: "master" }] } });
      // Clean: a fresh clone no longer has the branch, so the commit is fetched by id.
      await rm(join(root, "checkouts"), { recursive: true, force: true });
      await pool.query("UPDATE cloud_v2_computers SET active_build_id = NULL, snapshot_name = NULL WHERE org_id = $1", [org]);
      await computers.reactivate(org, admin, first.id); await builder.tick();
      expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "succeeded", baseSnapshot: null,
        recipe: { repositories: [{ commit: pinned, branch: "master" }] } });
      expect((await run("git", ["-C", join(root, "checkouts/example/project"), "rev-parse", "HEAD"])).stdout.trim()).toBe(pinned);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it("rotates organizations GitHub cannot answer for, so they never starve readable ones", async () => {
    const boat = compute();
    const orgs = [org];
    for (let index = 0; index < 2; index++) {
      const id = randomUUID(); orgs.push(id);
      await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'O', $3, false, true)`, [id, `org-${id}`, admin]);
      await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, admin]);
    }
    for (const id of orgs) {
      await computers.enqueue(id, admin, recipe);
      await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
      await new CloudV2Store(pool).createWorkspace({ id: randomUUID(), organizationId: id, creatorUserId: admin, name: "w",
        repository: "withso/zeros", branch: `zeros/${id.slice(0, 8)}`, baseBranch: "master", computerBuildId: null });
    }
    await pool.query(`UPDATE cloud_v2_computer_builds SET created_at = now() - interval '25 hours', finished_at = now() - interval '25 hours'`);
    // The two oldest are unreadable; the newest has new commits.
    await pool.query(`UPDATE cloud_v2_computer_builds SET finished_at = now() - interval '30 hours' WHERE org_id = ANY($1::uuid[])`, [orgs.slice(0, 2)]);
    const readable = orgs[2]!;
    const remoteHead = vi.fn(async (organizationId: string) => organizationId === readable ? "c".repeat(40) : null);
    let now = Date.now();
    const scan = async () => {
      now += 11 * 60_000;
      const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token",
        remoteHead, refreshPage: 2, now: () => now });
      await builder.scheduleRefreshes();
    };
    // A page holds only the two unreadable ones; they are deferred an hour, not left in place.
    const asked = () => remoteHead.mock.calls.map(([id]) => id);
    await scan();
    expect(asked().sort()).toEqual(orgs.slice(0, 2).sort());
    expect((await computers.overview(readable)).builds[0]!.reason).toBe("manual");
    await scan();
    expect(asked()).toHaveLength(3);
    expect(asked()[2]).toBe(readable);
    expect((await computers.overview(readable)).builds[0]).toMatchObject({ reason: "refresh", state: "queued" });
  });

  it("refuses repository names that would leave the home directory", async () => {
    await expect(computers.saveRecipe(org, admin, [{ repository: "../.." }], 0)).rejects.toThrow();
    await expect(computers.enqueue(org, admin, { repositories: [{ repository: "withso/.." }] })).rejects.toThrow();
  });
});
