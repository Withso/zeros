import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import type { CloudV2Compute } from "./boat.js";
import { CloudV2ComputerBuilder, CloudV2Computers, cloudV2SnapshotName } from "./computer.js";
import { CloudProviderError } from "./provider-error.js";
import { CloudV2Store } from "./store.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const commit = "a".repeat(40);

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
    computers = new CloudV2Computers(pool);
    [admin, member] = [randomUUID(), randomUUID()];
    for (const id of [admin, member]) await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')`, [id, `u-${id}@example.test`]);
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

  it("allows ordinary members to read the Computer's repositories", async () => {
    await expect(computers.requireMember(org, member)).resolves.toBeUndefined();
    await expect(computers.requireMember(org, randomUUID())).rejects.toMatchObject({ status: 404 });
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
    // A named snapshot is an independent copy: the builder goes as soon as it is ready.
    expect(boat.saveSnapshot).toHaveBeenCalledWith("bx_build1", cloudV2SnapshotName("alpha", org, 1));
    expect(boat.delete).toHaveBeenCalledWith("bx_build1");
    expect(boat.stop).not.toHaveBeenCalled();

    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await computers.reactivate(org, admin, overview.builds[0]!.id);
    await builder.tick();
    overview = await computers.overview(org);
    expect(overview.snapshotName).toBe(cloudV2SnapshotName("alpha", org, 2));
    expect(overview.builds[0]!.recipe).toMatchObject({ rebuiltFrom: 1 });
    expect(overview.builds[0]!.recipe.repositories[0]!.commit).toBe(commit);
    const rebuildClone = vi.mocked(boat.execLong).mock.calls.find(([, command]) => command.includes("checkout --detach"))![1];
    expect(rebuildClone.indexOf("symbolic-ref --quiet --short HEAD")).toBeGreaterThan(0);
    expect(rebuildClone.indexOf("symbolic-ref --quiet --short HEAD")).toBeLessThan(rebuildClone.indexOf("checkout --detach"));
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
      vi.mocked(boat.execLong).mockImplementation(async (_id, command) => {
        const local = command.replaceAll("https://github.com/example/project.git", origin)
          .replaceAll("/home/user", join(root, "checkouts"));
        const result = await run("bash", ["-c", local]);
        return { exitCode: 0, stdout: result.stdout, timedOut: false };
      });
      const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "fixture" });
      await computers.enqueue(org, admin, { repositories: [{ repository: "example/project",
        ...(source === "tag" ? { ref: "v1.2.3" } : { commit: pinnedCommit }) }] });
      await builder.tick();
      const overview = await computers.overview(org);
      expect(overview.builds[0]).toMatchObject({ state: "succeeded", recipe: { repositories: [{ branch: "master", commit: pinnedCommit }] } });
      expect(await new CloudV2Store(pool).installedRepositories(org)).toEqual([{ repository: "example/project", defaultBranch: "master" }]);
      // This is the worker's new-workspace source; it must exist in the snapshot.
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
    expect(boat.saveSnapshot).not.toHaveBeenCalled();
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

  it("refreshes the live snapshot in place, deleting removed repositories", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    await computers.enqueue(org, admin, { repositories: [{ repository: "withso/zeros" }, { repository: "withso/old" }] });
    await builder.tick();
    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    const second = await computers.enqueue(org, admin, { repositories: [{ repository: "withso/zeros" }, { repository: "withso/new" }] });
    expect(second.baseSnapshot).toBe(cloudV2SnapshotName("alpha", org, 1));
    await builder.tick();
    expect(boat.create).toHaveBeenLastCalledWith({ key: second.id, from: cloudV2SnapshotName("alpha", org, 1),
      name: `zeros-alpha-build-${second.id.slice(0, 8)}`, env: {} });
    const removal = vi.mocked(boat.exec).mock.calls.map(([, command]) => command).find(command => command.includes("rm -rf -- "));
    expect(removal).toContain("rm -rf -- '\\''/home/user/withso/old'\\''");
    expect(removal).not.toContain("withso/zeros");
    expect(removal).not.toContain("withso/new");
    expect((await computers.overview(org)).builds[0]).toMatchObject({ id: second.id, state: "succeeded" });
  });

  it("fetches existing checkouts in place, keeping ignored files, and clones additions with a real Git", async () => {
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
      const shell = async (_id: string, command: string) => {
        const result = await run("bash", ["-c", local(command)]);
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
      // The builder disk persists between ticks here, like the snapshot it starts from.
      await computers.enqueue(org, admin, { repositories: [{ repository: "example/kept", setup }, { repository: "example/added" }] });
      await builder.tick();
      const overview = await computers.overview(org);
      expect(overview.builds[0]).toMatchObject({ state: "succeeded", recipe: { repositories: [
        { repository: "example/kept", branch: "master", commit: head }, { repository: "example/added", branch: "master" },
      ] } });
      const checkouts = join(root, "checkouts/example");
      expect((await run("cat", [join(checkouts, "kept/node_modules/marker")])).stdout).toBe("installed\ninstalled\n");
      expect((await run("cat", [join(checkouts, "kept/README.md")])).stdout).toBe("kept, second\n");
      expect((await run("ls", [checkouts])).stdout.split("\n").filter(Boolean)).toEqual(["added", "kept"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it("refreshes only the runtime when it changes, without Git or setup, and backs off a failing refresh", async () => {
    const boat = compute();
    await computers.enqueue(org, admin, recipe);
    await new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" }).tick();
    vi.mocked(boat.execLong).mockClear();
    const next = { sha256: "c".repeat(64), url: runtime.url };
    let now = Date.now();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime: next, cloneToken: async () => "ghs_token", now: () => now });
    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await builder.tick();
    let overview = await computers.overview(org);
    expect(overview.builds[0]).toMatchObject({ reason: "runtime", state: "succeeded", runtimeSha256: "c".repeat(64),
      baseSnapshot: cloudV2SnapshotName("alpha", org, 1), recipe: { repositories: [{ repository: "withso/zeros", commit, branch: "master" }] } });
    expect(boat.execLong).not.toHaveBeenCalled();
    expect(vi.mocked(boat.exec).mock.calls.some(([, command]) => command.includes(`/opt/zeros/runtime/${"c".repeat(64)}`))).toBe(true);

    // A refresh that keeps failing is retried later, not on every scan.
    const failing = { sha256: "d".repeat(64), url: runtime.url };
    const retrying = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime: failing, cloneToken: async () => "ghs_token", now: () => now });
    vi.mocked(boat.exec).mockResolvedValueOnce({ exitCode: 1, stdout: "", timedOut: false });
    await retrying.tick();
    overview = await computers.overview(org);
    expect(overview.builds[0]).toMatchObject({ reason: "runtime", state: "failed", runtimeSha256: "d".repeat(64) });
    now += 11 * 60_000;
    await retrying.tick();
    expect((await computers.overview(org)).builds[0]!.id).toBe(overview.builds[0]!.id);
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
    expect(remoteHead).toHaveBeenCalledWith(org, admin, "withso/zeros", "master");
    expect((await computers.overview(org)).builds).toHaveLength(1);
    // GitHub not answering is not "unchanged": the next scan asks again.
    head = null; now += 11 * 60_000;
    const unknown = builder();
    await unknown.scheduleRefreshes(); now += 11 * 60_000; await unknown.scheduleRefreshes();
    expect(remoteHead).toHaveBeenCalledTimes(3);
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

  it("forgets a live snapshot Boat no longer has, so the next build starts clean", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", runtime, cloneToken: async () => "ghs_token" });
    await computers.enqueue(org, admin, recipe); await builder.tick();
    vi.mocked(boat.create).mockRejectedValueOnce(new CloudProviderError("provider_not_found", "Boat API request did not succeed", false, { httpStatus: 404 }));
    const second = await computers.enqueue(org, admin, recipe); await builder.tick();
    let overview = await computers.overview(org);
    expect(overview.builds[0]).toMatchObject({ id: second.id, state: "failed", errorCode: "computer_base_missing" });
    expect(overview.snapshotName).toBeNull();
    expect((await pool.query("SELECT builder_create_pending FROM cloud_v2_computer_builds WHERE id = $1", [second.id])).rows[0].builder_create_pending).toBe(false);
    const third = await computers.enqueue(org, admin, recipe);
    expect(third.baseSnapshot).toBeNull();
    await builder.tick();
    expect(boat.create).toHaveBeenLastCalledWith({ key: third.id, name: `zeros-alpha-build-${third.id.slice(0, 8)}`, env: {} });
    overview = await computers.overview(org);
    expect(overview).toMatchObject({ activeBuildId: third.id, snapshotName: cloudV2SnapshotName("alpha", org, 3) });
  });

  it("refuses repository names that would leave the home directory", async () => {
    await expect(computers.saveRecipe(org, admin, [{ repository: "../.." }], 0)).rejects.toThrow();
    await expect(computers.enqueue(org, admin, { repositories: [{ repository: "withso/.." }] })).rejects.toThrow();
  });
});
