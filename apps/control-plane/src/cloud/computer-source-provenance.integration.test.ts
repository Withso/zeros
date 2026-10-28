import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudV2ComputerBuilder, CloudV2Computers } from "./computer.js";
import type { CloudV2Compute } from "./boat.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";

type Target = { repository: string; repositoryId?: string };
type Resolver = CloudV2ComputerSourceResolver;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("Cloud Computer immutable source provenance", () => {
  let pool: pg.Pool, computers: CloudV2Computers, org: string, admin: string;
  let repositories: Map<string, string>, allowed: Set<string>, resolve: ReturnType<typeof vi.fn<Resolver>>;
  const recipe = { repositories: [{ repository: "former/project", setup: "echo source-output" }] };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    org = randomUUID(); admin = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [admin, `${admin}@example.test`]);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,true)", [org, `org-${org}`, admin]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, admin]);
    repositories = new Map([["42", "former/project"]]); allowed = new Set(["42"]);
    resolve = vi.fn(async (_org, _user, target: Target) => {
      const id = target.repositoryId ?? [...repositories].find(([, name]) => name === target.repository.toLowerCase())?.[0];
      if (!id || !allowed.has(id) || !repositories.has(id)) throw new HttpError(403, "github_cloud_access_denied", "Repository access denied");
      return { repositoryId: id, repository: repositories.get(id)! };
    });
    computers = new CloudV2Computers(pool, pool, resolve);
  });
  const transfer = () => { repositories.set("42", "current/project"); repositories.set("99", "former/project"); allowed.add("99"); };
  function builder() {
    const compute: CloudV2Compute = {
      create: vi.fn(async () => ({ sandboxId: "fixture-builder" })), resume: vi.fn(), extendLease: vi.fn(), stop: vi.fn(),
      delete: vi.fn(async () => {}), deleteSnapshot: vi.fn(async () => {}), saveSnapshot: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "runtime", timedOut: false })),
      execLong: vi.fn(async (_id: string, command: string) => ({ exitCode: 0,
        stdout: command.includes("rev-parse") ? `zeros-build-branch=main\n${"a".repeat(40)}\n` : "source-output-canary", timedOut: false })),
    };
    const cloneToken = vi.fn(async () => "synthetic");
    const service = new CloudV2ComputerBuilder({ computers, compute, cloneToken, channel: "alpha",
      runtime: { sha256: "b".repeat(64), url: async () => "https://example.test/runtime" } });
    return { compute, cloneToken, service };
  }

  it("records identities before a build can append source-bearing output, including failed builds", async () => {
    const queued = await computers.enqueue(org, admin, recipe);
    await computers.claim();
    await computers.append(queued.id, "source-output-canary");
    await computers.fail(queued.id, "computer_setup_failed");
    transfer();
    expect(await computers.logRepositories(org, queued.id)).toEqual([{ repository: "former/project", repositoryId: "42" }]);
    expect(await computers.log(org, queued.id)).toBe("source-output-canary");
  });

  it("never authorizes historical source by the replacement at the original name", async () => {
    const first = await computers.enqueue(org, admin, recipe, { configure: true });
    await computers.claim(); await computers.activate(first.id, "source-snapshot");
    transfer(); allowed.delete("42");
    await expect(computers.buildConfigured(org, admin, 1)).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    await expect(computers.saveRecipe(org, admin, recipe.repositories, 1)).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    await expect(computers.reactivate(org, admin, first.id)).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    expect(await computers.enqueueAutomatic(org, first.id, "runtime", "a".repeat(64))).toBeNull();
    expect((await computers.overview(org)).builds).toHaveLength(1);
  });

  it("keeps the original ID through configured builds, reactivation and both refresh paths after a transfer", async () => {
    const first = await computers.enqueue(org, admin, recipe, { configure: true });
    await computers.claim(); await computers.activate(first.id, "source-snapshot");
    transfer();
    await computers.saveRecipe(org, admin, [{ ...recipe.repositories[0]!, setup: "echo changed" }], 1);
    const next = await computers.buildConfigured(org, admin, 2);
    expect(await computers.logRepositories(org, next.id)).toEqual([{ repository: "former/project", repositoryId: "42" }]);
    await computers.claim(); await computers.activate(next.id, "configured-snapshot");
    const reactivated = await computers.reactivate(org, admin, first.id);
    expect(await computers.logRepositories(org, reactivated.id)).toEqual([{ repository: "former/project", repositoryId: "42" }]);
    await computers.claim(); await computers.activate(reactivated.id, "reactivated-snapshot");
    for (const reason of ["runtime", "refresh"] as const) {
      const queued = await computers.enqueueAutomatic(org, reactivated.id, reason, "a".repeat(64));
      expect(queued).not.toBeNull();
      expect(await computers.logRepositories(org, queued!.id)).toEqual([{ repository: "former/project", repositoryId: "42" }]);
      await computers.claim(); await computers.fail(queued!.id, "fixture_cleanup");
    }
  });

  it("preserves legacy logs while refusing unknown provenance without a name-based backfill", async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,created_by,source_policy_version,log) VALUES($1,$2,1,$3,'succeeded',$4,2,'legacy-source-canary')", [id, org, JSON.stringify(recipe), admin]);
    await expect(computers.logRepositories(org, id)).rejects.toMatchObject({ code: "cloud_source_review_required" });
    await expect(computers.reactivate(org, admin, id)).rejects.toMatchObject({ code: "cloud_source_review_required" });
    expect(resolve).not.toHaveBeenCalled();
    expect(await computers.log(org, id)).toBe("legacy-source-canary");
  });

  it("clones the transferred ID's canonical remote into the original directory and runs its pinned setup with real Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-source-transfer-")), run = promisify(execFile);
    try {
      for (const label of ["original", "replacement"]) {
        const origin = join(root, label);
        await run("git", ["init", "--initial-branch=main", origin]);
        await writeFile(join(origin, "README.md"), label);
        await writeFile(join(origin, "setup.sh"), `printf '%s' '${label}' > setup-marker\n`);
        await run("git", ["-C", origin, "add", "."]);
        await run("git", ["-C", origin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
      }
      const head = (await run("git", ["-C", join(root, "original"), "rev-parse", "HEAD"])).stdout.trim();
      const job = await computers.enqueue(org, admin, { repositories: [{ repository: "former/project", setup: "bash setup.sh", commit: head }] });
      transfer();
      const f = builder();
      vi.mocked(f.compute.execLong).mockImplementation(async (_id, command, _timeout, input) => {
        const local = command.replaceAll("/home/user", join(root, "checkouts"))
          .replaceAll("https://github.com/current/project.git", join(root, "original"))
          .replaceAll("https://github.com/former/project.git", join(root, "replacement"));
        const result = run("bash", ["-c", local]); result.child.stdin?.end(input);
        return { exitCode: 0, stdout: (await result).stdout, timedOut: false };
      });
      await f.service.tick();
      expect(f.cloneToken).toHaveBeenCalledWith(org, admin, { repository: "current/project", repositoryId: "42" });
      expect(await readFile(join(root, "checkouts/former/project/README.md"), "utf8")).toBe("original");
      expect(await readFile(join(root, "checkouts/former/project/setup-marker"), "utf8")).toBe("original");
      expect(await computers.recipeForRepositoryId(org, job.id, "42")).toMatchObject({ repository: "former/project", setup: "bash setup.sh", commit: head, branch: "main" });
      await expect(computers.recipeForRepositoryId(org, job.id, "99")).rejects.toMatchObject({ code: "cloud_source_review_required" });
      expect((await computers.overview(org)).activeBuildId).toBe(job.id);
      expect(vi.mocked(f.compute.saveSnapshot).mock.invocationCallOrder[0]).toBeLessThan(f.cloneToken.mock.invocationCallOrder[0]!);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["mint", "clone"] as const)("refuses a further transfer during %s before running setup", async stage => {
    const job = await computers.enqueue(org, admin, recipe), f = builder();
    const move = () => { repositories.set("42", "later/project"); repositories.set("99", "former/project"); };
    if (stage === "mint") f.cloneToken.mockImplementation(async () => { move(); return "synthetic"; });
    else vi.mocked(f.compute.execLong).mockImplementation(async () => { move(); return { exitCode: 0, stdout: `zeros-build-branch=main\n${"a".repeat(40)}\n`, timedOut: false }; });
    await f.service.tick();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "failed", errorCode: "cloud_source_review_required" });
    expect(vi.mocked(f.compute.execLong).mock.calls.some(([, command]) => command.includes("echo source-output"))).toBe(false);
    expect(await computers.logRepositories(org, job.id)).toEqual([{ repository: "former/project", repositoryId: "42" }]);
    expect(f.compute.delete).toHaveBeenCalled(); expect(f.compute.deleteSnapshot).toHaveBeenCalled();
  });

  it("records all source IDs before the first credential and retains them when a later repository fails", async () => {
    repositories.set("43", "other/private"); allowed.add("43");
    const job = await computers.enqueue(org, admin, { repositories: [...recipe.repositories, { repository: "other/private", setup: "echo second" }] });
    const targets = [{ repository: "former/project", repositoryId: "42" }, { repository: "other/private", repositoryId: "43" }], f = builder();
    f.cloneToken.mockImplementation(async () => { expect(await computers.logRepositories(org, job.id)).toEqual(targets); return "synthetic"; });
    const exec = vi.mocked(f.compute.execLong).getMockImplementation()!;
    vi.mocked(f.compute.execLong).mockImplementation(async (...args) => {
      const result = await exec(...args);
      if (args[1].includes("echo source-output")) allowed.delete("43");
      return result;
    });
    await f.service.tick();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "failed", errorCode: "github_cloud_access_denied" });
    expect(await computers.log(org, job.id)).toContain("source-output-canary");
    expect(await computers.logRepositories(org, job.id)).toEqual(targets);
    expect(f.cloneToken).toHaveBeenCalledTimes(1);
  });

  it.each(["clone-admission", "activation"] as const)("rechecks its resource lock after source I/O at %s", async stage => {
    let lost = false, setupFinished = false;
    vi.spyOn(computers, "withBuildLock").mockImplementation(async (_id, work) => {
      await work(() => { if (lost) throw Object.assign(new Error("Fixture lock was lost"), { code: "computer_lock_lost" }); });
    });
    const job = await computers.enqueue(org, admin, recipe), f = builder();
    if (stage === "clone-admission") f.cloneToken.mockImplementation(async () => { lost = true; return "synthetic"; });
    else {
      const original = resolve.getMockImplementation()!;
      resolve.mockImplementation(async (...args) => { const result = await original(...args); if (setupFinished) lost = true; return result; });
      const exec = vi.mocked(f.compute.execLong).getMockImplementation()!;
      vi.mocked(f.compute.execLong).mockImplementation(async (...args) => {
        const result = await exec(...args); if (args[1].includes("echo source-output")) setupFinished = true; return result;
      });
    }
    await f.service.tick();
    expect(lost).toBe(true);
    if (stage === "clone-admission") expect(vi.mocked(f.compute.execLong).mock.calls.length).toBe(0);
    expect((await computers.overview(org)).activeBuildId).toBeNull();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ id: job.id, state: "failed", errorCode: "computer_lock_lost" });
  });

  it("cannot replace or retrofit a build's source identities or source-bearing recipe", async () => {
    const job = await computers.enqueue(org, admin, recipe);
    await expect(pool.query("UPDATE cloud_v2_computer_builds SET source_targets='[]' WHERE id=$1", [job.id])).rejects.toThrow("source identities are immutable");
    await expect(computers.update(job.id, { recipe: { repositories: [{ repository: "former/project", setup: "different" }] } })).rejects.toThrow("source recipe is immutable");
    await expect(computers.update(job.id, { recipe: { repositories: [{ ...recipe.repositories[0]!, commit: "a".repeat(40), branch: "main" }] } })).resolves.toBeUndefined();
    const legacy = randomUUID();
    await pool.query("INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,created_by) VALUES($1,$2,2,$3,'failed',$4)", [legacy, org, JSON.stringify(recipe), admin]);
    await expect(pool.query("UPDATE cloud_v2_computer_builds SET source_targets=$2 WHERE id=$1", [legacy, JSON.stringify([{ repository: "former/project", repositoryId: "99" }])])).rejects.toThrow("source identities are immutable");
  });

  it("keeps provenance through discard and a missing active snapshot", async () => {
    const job = await computers.enqueue(org, admin, recipe);
    await computers.claim(); await computers.activate(job.id, "source-snapshot");
    await computers.saveRecipe(org, admin, recipe.repositories, 0);
    await computers.discardRecipe(org, admin, 1);
    await computers.baseMissing(job.id, org, "source-snapshot");
    transfer();
    const next = await computers.buildConfigured(org, admin, 2);
    expect(await computers.logRepositories(org, next.id)).toEqual([{ repository: "former/project", repositoryId: "42" }]);
  });

  it("never repairs a legacy recipe by name; an explicit remove/save and fresh addition creates new provenance only", async () => {
    const legacy = randomUUID();
    await pool.query("INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,created_by) VALUES($1,$2,1,$3,'succeeded',$4)", [legacy, org, JSON.stringify(recipe), admin]);
    await pool.query("INSERT INTO cloud_v2_computers(org_id,recipe,recipe_revision) VALUES($1,$2,1)", [org, JSON.stringify(recipe)]);
    transfer(); allowed.delete("42");
    await expect(computers.saveRecipe(org, admin, recipe.repositories, 1)).rejects.toMatchObject({ code: "cloud_source_review_required" });
    await expect(computers.buildConfigured(org, admin, 1)).rejects.toMatchObject({ code: "cloud_source_review_required" });
    expect(resolve).not.toHaveBeenCalled();
    await computers.saveRecipe(org, admin, [], 1);
    await computers.saveRecipe(org, admin, recipe.repositories, 2);
    const current = await computers.buildConfigured(org, admin, 3);
    expect(await computers.logRepositories(org, current.id)).toEqual([{ repository: "former/project", repositoryId: "99" }]);
    await expect(computers.logRepositories(org, legacy)).rejects.toMatchObject({ code: "cloud_source_review_required" });
  });

  it("does not overwrite a concurrent recipe edit after waiting for a provider identity", async () => {
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const original = resolve.getMockImplementation()!;
    resolve.mockImplementationOnce(async (...args) => { entered(); await wait; return original(...args); });
    const slow = computers.saveRecipe(org, admin, recipe.repositories, 0).then(value => ({ value }), error => ({ error }));
    await observed;
    try { await computers.saveRecipe(org, admin, [], 0); } finally { release(); }
    expect(await slow).toMatchObject({ error: { code: "computer_recipe_changed" } });
    expect(await computers.overview(org)).toMatchObject({ recipeRevision: 1, recipe: { repositories: [] } });
  });
});
