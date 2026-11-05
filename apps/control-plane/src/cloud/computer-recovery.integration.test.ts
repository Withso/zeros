import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Computers, CloudV2ComputerBuilder } from "./computer.js";
import type { CloudV2Compute } from "./boat.js";
import { HttpError } from "../authz.js";
import { CloudV2Store } from "./store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Computer interruption recovery", () => {
  let pool: pg.Pool, computers: CloudV2Computers, org: string, user: string;
  const commit = "a".repeat(40), oldRuntime = "a".repeat(64), newRuntime = "b".repeat(64);
  const recipe = { repositories: [{ repository: "fixture/repo", commit, branch: "main" }] };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(() => pool.end());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool); org = randomUUID(); user = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
  });
  function compute(): CloudV2Compute {
    return {
      create: vi.fn(async () => ({ sandboxId: "bx_build1234" })), resume: vi.fn(), extendLease: vi.fn(), stop: vi.fn(), delete: vi.fn(),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      execLong: vi.fn(async () => ({ exitCode: 0, stdout: `zeros-build-branch=main\n${commit}\n`, timedOut: false })),
      saveSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
    };
  }
  function builder(boat: CloudV2Compute, sha256 = oldRuntime) {
    return new CloudV2ComputerBuilder({ computers, compute: boat, runtime: { sha256, url: async () => "https://fixture.example.test/runtime.tar.gz" },
      channel: "alpha", cloneToken: async () => "synthetic-token" });
  }
  async function live() {
    const base = await computers.enqueue(org, user, recipe); await computers.claim();
    await computers.setRuntime(base.id, oldRuntime); await computers.activate(base.id, "snapshot-fixture"); return base;
  }
  it.each(["runtime", "refresh"] as const)("retries an interrupted automatic %s with its frozen inputs", async reason => {
    const base = await live(), sha256 = reason === "runtime" ? newRuntime : oldRuntime;
    const failed = (await computers.enqueueAutomatic(org, base.id, reason, sha256))!;
    await computers.claim();
    await pool.query("UPDATE cloud_v2_computer_builds SET heartbeat_at=clock_timestamp()-interval '10 minutes' WHERE id=$1", [failed.id]);
    await computers.failInterrupted();
    await pool.query("UPDATE cloud_v2_computer_builds SET finished_at=clock_timestamp()-interval '61 seconds' WHERE id=$1", [failed.id]);
    const boat = compute(); await builder(boat, sha256).tick();
    const overview = await computers.overview(org);
    expect(overview.builds).toHaveLength(3);
    expect(overview.builds[0]).toMatchObject({ state: "succeeded", reason, runtimeSha256: sha256, baseSnapshot: failed.baseSnapshot });
    expect(overview.builds[1]).toMatchObject({ id: failed.id, state: "failed", errorCode: "computer_build_interrupted" });
    expect(overview.builds[0]!.recipe.repositories[0]).toMatchObject({ repository: "fixture/repo", commit });
    expect(boat.create).toHaveBeenCalledOnce();
  });
  it.each(["manual", "reactivate", "genuine"] as const)("does not retry %s failures automatically", async kind => {
    const base = await live();
    const failed = kind === "manual" ? await computers.enqueue(org, user, recipe)
      : kind === "reactivate" ? await computers.reactivate(org, user, base.id)
      : (await computers.enqueueAutomatic(org, base.id, "refresh", oldRuntime))!;
    await computers.claim();
    await computers.fail(failed.id, kind === "genuine" ? "computer_setup_failed" : "computer_build_interrupted");
    await pool.query("UPDATE cloud_v2_computer_builds SET finished_at=clock_timestamp()-interval '10 minutes' WHERE id=$1", [failed.id]);
    const boat = compute(); await builder(boat).tick();
    expect((await computers.overview(org)).builds).toHaveLength(2); expect(boat.create).not.toHaveBeenCalled();
  });
  it("does not start a provider operation when shutdown wins the claim response", async () => {
    const job = await computers.enqueue(org, user, recipe), boat = compute(), runner = builder(boat);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const claim = computers.claim.bind(computers);
    vi.spyOn(computers, "claim").mockImplementation(async () => { const result = await claim(); entered(); await held; return result; });
    const task = runner.tick();
    try {
      await waiting;
      (runner as CloudV2ComputerBuilder & { close?(): void }).close?.();
    } finally { release(); await task; }
    expect(boat.create).not.toHaveBeenCalled();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ id: job.id, state: "queued" });
  });

  async function interrupted() {
    const base = await live(), job = (await computers.enqueueAutomatic(org, base.id, "runtime", newRuntime))!;
    await computers.claim(newRuntime); await computers.fail(job.id, "computer_build_interrupted");
    return { base, job };
  }
  const age = (id: string, seconds: number) => pool.query("UPDATE cloud_v2_computer_builds SET finished_at=clock_timestamp()-$2::int*interval '1 second' WHERE id=$1", [id, seconds]);

  it("uses one- and five-minute backoff, retains failed attempts, and admits at most three total", async () => {
    const { job } = await interrupted();
    expect(await computers.retryInterrupted(newRuntime)).toBe(0);
    await age(job.id, 61);
    expect((await Promise.all([computers.retryInterrupted(newRuntime), computers.retryInterrupted(newRuntime)])).sort()).toEqual([0, 1]);
    const second = (await computers.claim(newRuntime))!;
    expect(second.recipe).toEqual(job.recipe);
    const inputs = await pool.query("SELECT source_targets,runtime_sha256,automatic_base_build_id,automatic_recipe_revision FROM cloud_v2_computer_builds WHERE id=ANY($1::uuid[]) ORDER BY version", [[job.id, second.id]]);
    expect(inputs.rows[1]).toEqual(inputs.rows[0]);
    await computers.fail(second.id, "computer_build_interrupted"); await age(second.id, 61);
    expect(await computers.retryInterrupted(newRuntime)).toBe(0);
    await age(second.id, 301); expect(await computers.retryInterrupted(newRuntime)).toBe(1);
    const third = (await computers.claim(newRuntime))!;
    await computers.fail(third.id, "computer_build_interrupted"); await age(third.id, 601);
    expect(await computers.retryInterrupted(newRuntime)).toBe(0);
    expect((await computers.overview(org)).builds.filter(b => b.reason === "runtime")).toHaveLength(3);
    expect((await pool.query("SELECT retry_attempt FROM cloud_v2_computer_builds WHERE reason='runtime' ORDER BY version")).rows.map(r => r.retry_attempt)).toEqual([1, 2, 3]);
  });

  it.each(["runtime", "recipe", "manual", "admin", "source", "create", "builder", "snapshot", "operation", "legacy"] as const)(
    "does not retry a superseded, unauthorized or unresolved input (%s)", async change => {
      const { job } = await interrupted(); await age(job.id, 601);
      if (change === "recipe") await computers.saveRecipe(org, user, [{ repository: "fixture/repo", ref: "changed" }], 0);
      if (change === "manual") { const later = await computers.enqueue(org, user, recipe); await computers.claim(); await computers.fail(later.id, "computer_setup_failed"); }
      if (change === "admin") await pool.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [org, user]);
      if (change === "source") await pool.query(`INSERT INTO cloud_v2_computer_builds
        (id,org_id,version,recipe,state,error_code,created_by,reason,runtime_sha256,base_snapshot,automatic_base_build_id,automatic_recipe_revision,finished_at,source_policy_version)
        SELECT $2,org_id,version+1,recipe,state,error_code,created_by,reason,runtime_sha256,base_snapshot,automatic_base_build_id,automatic_recipe_revision,finished_at,1
        FROM cloud_v2_computer_builds WHERE id=$1`, [job.id, randomUUID()]);
      if (change === "create") await pool.query("UPDATE cloud_v2_computer_builds SET builder_create_pending=true WHERE id=$1", [job.id]);
      if (change === "builder") await pool.query("UPDATE cloud_v2_computer_builds SET builder_sandbox_id='bx_uncertain' WHERE id=$1", [job.id]);
      if (change === "snapshot") await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id='uncertain-snapshot' WHERE id=$1", [job.id]);
      if (change === "operation") await pool.query("UPDATE cloud_v2_computer_builds SET operation_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
      if (change === "legacy") await pool.query("UPDATE cloud_v2_computer_builds SET automatic_base_build_id=NULL,automatic_recipe_revision=NULL WHERE id=$1", [job.id]);
      expect(await computers.retryInterrupted(change === "runtime" ? "c".repeat(64) : newRuntime)).toBe(0);
    });

  it("rechecks queued retry intent before its claim and before publication", async () => {
    const { job } = await interrupted(); await age(job.id, 61); await computers.retryInterrupted(newRuntime);
    const next = (await computers.overview(org)).builds[0]!;
    await computers.saveRecipe(org, user, [{ repository: "fixture/repo", ref: "changed" }], 0);
    expect(await computers.claim(newRuntime)).toBeNull();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ id: next.id, state: "cancelled", errorCode: "computer_refresh_superseded" });
  });

  it.each(["recipe", "admin", "unresolved"] as const)("does not let a full page of %s refusals starve an eligible retry", async reason => {
    for (let index = 0; index < 25; index++) {
      const blockedOrg = randomUUID();
      await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [blockedOrg, `org-${blockedOrg}`, user]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [blockedOrg, user]);
      const base = await computers.enqueue(blockedOrg, user, recipe); await computers.claim(oldRuntime);
      await computers.activate(base.id, `snapshot-${blockedOrg}`);
      const failed = (await computers.enqueueAutomatic(blockedOrg, base.id, "runtime", newRuntime))!;
      await computers.claim(newRuntime); await computers.fail(failed.id, "computer_build_interrupted"); await age(failed.id, 601);
      if (reason === "recipe") await computers.saveRecipe(blockedOrg, user, [{ repository: "fixture/repo", ref: "changed" }], 0);
      if (reason === "admin") await pool.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [blockedOrg, user]);
      if (reason === "unresolved") await pool.query("UPDATE cloud_v2_computer_builds SET builder_create_pending=true WHERE id=$1", [failed.id]);
    }
    const { job } = await interrupted(); await age(job.id, 61);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_v2_computer_builds WHERE error_code='computer_build_interrupted'")).rows[0].count).toBe(26);
    expect(await computers.retryInterrupted(newRuntime)).toBe(1);
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "queued", reason: "runtime" });
  }, 20_000);

  it("does not turn a stale heartbeat into an interruption while its owner still holds the build lock", async () => {
    const job = await computers.enqueue(org, user, recipe); await computers.claim(newRuntime);
    await pool.query("UPDATE cloud_v2_computer_builds SET heartbeat_at=clock_timestamp()-interval '10 minutes' WHERE id=$1", [job.id]);
    await computers.withBuildLock(job.id, async () => {
      expect(await computers.failInterrupted()).toEqual([]);
      expect((await computers.overview(org)).builds[0]!.state).toBe("building");
    });
    await computers.failInterrupted();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "failed", errorCode: "computer_build_interrupted" });
    expect(await computers.log(org, job.id)).toContain("start it again");
  });

  it("returns an unstarted claim when shutdown follows durable provider intent but precedes create", async () => {
    const job = await computers.enqueue(org, user, recipe), boat = compute(), runner = builder(boat);
    const prepare = computers.prepareResource.bind(computers);
    vi.spyOn(computers, "prepareResource").mockImplementation(async (...args) => { const allowed = await prepare(...args); runner.close(); return allowed; });
    await runner.tick();
    expect(boat.create).not.toHaveBeenCalled();
    expect(await computers.resources(job.id)).toMatchObject({ state: "queued", builder_create_pending: false, operation_until: null });
  });

  it("lets an admitted build finish during shutdown", async () => {
    await computers.enqueue(org, user, recipe); const boat = compute(), runner = builder(boat);
    vi.mocked(boat.create).mockImplementation(async () => { runner.close(); return { sandboxId: "bx_build1234" }; });
    await runner.tick();
    expect((await computers.overview(org)).builds[0]!.state).toBe("succeeded");
    expect(boat.delete).toHaveBeenCalledWith("bx_build1234");
  });

  it("revalidates the frozen source before a retry creates a builder", async () => {
    const { job } = await interrupted(); await age(job.id, 61); await computers.retryInterrupted(newRuntime);
    computers = new CloudV2Computers(pool, pool, async () => { throw new HttpError(403, "github_access_lost", "Unavailable"); });
    const boat = compute(); await builder(boat, newRuntime).tick();
    expect(boat.create).not.toHaveBeenCalled();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "failed", errorCode: "github_access_lost" });
  });

  async function recentWorkspace() {
    await new CloudV2Store(pool).createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: user, name: "Fixture",
      repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
  }
  const ageBuild = (id: string, hours: number) => pool.query(`UPDATE cloud_v2_computer_builds
    SET created_at=clock_timestamp()-$2::int*interval '1 hour',finished_at=clock_timestamp()-$2::int*interval '1 hour' WHERE id=$1`, [id, hours]);

  it("lets an old-pin builder finish a queued retry with its recorded new pin", async () => {
    const { job } = await interrupted(); await age(job.id, 61); await computers.retryInterrupted(newRuntime);
    const retry = (await computers.overview(org)).builds[0]!, boat = compute();
    await builder(boat, oldRuntime).tick();
    const overview = await computers.overview(org);
    expect(overview.activeBuildId).toBe(retry.id);
    expect(overview.builds[0]).toMatchObject({ state: "succeeded", runtimeSha256: newRuntime });
    expect(overview.builds[1]).toMatchObject({ id: job.id, state: "failed", errorCode: "computer_build_interrupted" });
    expect(boat.create).toHaveBeenCalledOnce();
    expect(vi.mocked(boat.exec).mock.calls[0]![1]).toContain(newRuntime);
  });

  it("does not cancel a new-pin retry that is already building when an old-pin process claims", async () => {
    const { job } = await interrupted(); await age(job.id, 61); await computers.retryInterrupted(newRuntime);
    const retry = (await computers.overview(org)).builds[0]!, boat = compute(), runner = builder(boat, newRuntime);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(boat.create).mockImplementation(async () => { entered(); await held; return { sandboxId: "bx_build1234" }; });
    const tick = runner.tick();
    try {
      await waiting;
      expect(await computers.claim(oldRuntime)).toBeNull();
      expect((await computers.overview(org)).builds[0]).toMatchObject({ id: retry.id, state: "building", runtimeSha256: newRuntime });
    } finally { release(); await tick; runner.close(); }
    expect((await computers.overview(org)).activeBuildId).toBe(retry.id);
  });

  it.each(["failed", "cancelled"] as const)("keeps the six-hour cooldown and three-failure budget for genuine %s runtime builds", async state => {
    const base = await live();
    const failed = (await computers.enqueueAutomatic(org, base.id, "runtime", newRuntime))!;
    await computers.claim(newRuntime); await computers.fail(failed.id, "provider_rate_limited");
    if (state === "cancelled") await pool.query("UPDATE cloud_v2_computer_builds SET state='cancelled' WHERE id=$1", [failed.id]);
    expect(await computers.retryInterrupted(newRuntime)).toBe(0);
    expect(await computers.refreshCandidates(newRuntime)).toEqual([]);
    await ageBuild(failed.id, 7);
    expect(await computers.refreshCandidates(newRuntime)).toEqual([expect.objectContaining({ activeBuildId: base.id, runtimeStale: true })]);
    for (let failures = 2; failures <= 3; failures++) {
      const next = (await computers.enqueueAutomatic(org, base.id, "runtime", newRuntime))!;
      await computers.claim(newRuntime); await computers.fail(next.id, "provider_rate_limited");
      if (state === "cancelled") await pool.query("UPDATE cloud_v2_computer_builds SET state='cancelled' WHERE id=$1", [next.id]);
      await ageBuild(next.id, 7);
      expect(await computers.refreshCandidates(newRuntime)).toHaveLength(failures < 3 ? 1 : 0);
    }
    expect((await computers.overview(org)).builds.filter(build => build.errorCode === "provider_rate_limited")).toHaveLength(3);
  });

  it("re-enqueues a genuine runtime failure through the ordinary builder after six hours", async () => {
    const base = await live(), failed = (await computers.enqueueAutomatic(org, base.id, "runtime", newRuntime))!;
    await computers.claim(newRuntime); await computers.fail(failed.id, "provider_rate_limited"); await ageBuild(failed.id, 7);
    const boat = compute(), runner = builder(boat, newRuntime);
    await runner.scheduleRefreshes(); await runner.tick(); runner.close();
    const overview = await computers.overview(org);
    expect(overview.builds[0]).toMatchObject({ state: "succeeded", reason: "runtime", runtimeSha256: newRuntime });
    expect(overview.builds[1]).toMatchObject({ id: failed.id, state: "failed", errorCode: "provider_rate_limited" });
    expect(boat.create).toHaveBeenCalledOnce();
  });

  it("keeps daily refresh after a genuine automatic failure", async () => {
    const base = await live(), failed = (await computers.enqueueAutomatic(org, base.id, "refresh", oldRuntime))!;
    await computers.claim(oldRuntime); await computers.fail(failed.id, "computer_setup_failed");
    await ageBuild(base.id, 27); await ageBuild(failed.id, 26); await recentWorkspace();
    expect(await computers.retryInterrupted(oldRuntime)).toBe(0);
    const boat = compute(), runner = builder(boat);
    await runner.scheduleRefreshes(); await runner.tick(); runner.close();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "succeeded", reason: "refresh" });
    expect(boat.create).toHaveBeenCalledOnce();
  });

  it.each(["manual", "reactivate"] as const)("does not automatically recreate a failed %s after either refresh interval", async reason => {
    const base = await live(), failed = reason === "manual" ? await computers.enqueue(org, user, recipe)
      : await computers.reactivate(org, user, base.id);
    await computers.claim(); await computers.fail(failed.id, "provider_rate_limited");
    await ageBuild(base.id, 27); await ageBuild(failed.id, 26); await recentWorkspace();
    expect(await computers.retryInterrupted(newRuntime)).toBe(0);
    expect(await computers.refreshCandidates(newRuntime)).toEqual([]);
    expect(await computers.refreshCandidates(oldRuntime)).toEqual([]);
  });

  it("does not bypass exhausted interrupted retries through an ordinary runtime or daily refresh", async () => {
    const { base, job } = await interrupted(); await age(job.id, 61); await computers.retryInterrupted(newRuntime);
    const second = (await computers.claim(newRuntime))!;
    await computers.fail(second.id, "computer_build_interrupted"); await age(second.id, 301); await computers.retryInterrupted(newRuntime);
    const third = (await computers.claim(newRuntime))!; await computers.fail(third.id, "computer_build_interrupted");
    for (const id of [base.id, job.id, second.id, third.id]) await ageBuild(id, 26);
    await recentWorkspace();
    expect(await computers.retryInterrupted(newRuntime)).toBe(0);
    expect(await computers.refreshCandidates(newRuntime)).toEqual([]);
  });

  it("does not make system supersession a permanent refresh failure", async () => {
    const { base, job } = await interrupted(); await age(job.id, 61); await computers.retryInterrupted(newRuntime);
    await computers.saveRecipe(org, user, [{ repository: "fixture/repo", ref: "changed" }], 0);
    expect(await computers.claim(newRuntime)).toBeNull();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "cancelled", errorCode: "computer_refresh_superseded" });
    expect(await computers.retryInterrupted(newRuntime)).toBe(0);
    expect(await computers.refreshCandidates(newRuntime)).toEqual([expect.objectContaining({ activeBuildId: base.id, runtimeStale: true })]);
  });

  it.each([
    ["source", false], ["source", true], ["log", false], ["log", true], ["snapshot", false], ["snapshot", true],
  ] as const)("rechecks retry ownership at provider intent after the last awaited %s boundary (edited=%s)", async (boundary, edited) => {
    const { base, job } = await interrupted(); await age(job.id, 61); await computers.retryInterrupted(newRuntime);
    const boat = compute();
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    if (boundary === "source") {
      let first = true;
      computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => {
        if (first) { first = false; entered(); await held; }
        return { repository: target.repository, repositoryId: "42" };
      });
    } else if (boundary === "log") {
      const append = computers.append.bind(computers);
      vi.spyOn(computers, "append").mockImplementation(async (id, text) => {
        await append(id, text);
        if (text === "[zeros] starting from Boat's stock image\n") { entered(); await held; }
      });
    } else {
      vi.mocked(boat.exec).mockImplementation(async (_id, command) => {
        if (command === "sync") { entered(); await held; }
        return { exitCode: 0, stdout: "", timedOut: false };
      });
    }
    const runner = builder(boat, newRuntime), tick = runner.tick();
    try {
      await waiting;
      if (edited) await computers.saveRecipe(org, user, [{ repository: "fixture/repo", ref: "changed" }], 0);
    } finally { release(); await tick; runner.close(); }
    if (edited) {
      expect(boundary === "snapshot" ? boat.saveSnapshot : boat.create).not.toHaveBeenCalled();
      expect((await computers.overview(org)).activeBuildId).toBe(base.id);
    } else {
      expect(boat.create).toHaveBeenCalledOnce(); expect(boat.saveSnapshot).toHaveBeenCalledOnce();
      expect((await computers.overview(org)).builds[0]).toMatchObject({ state: "succeeded", runtimeSha256: newRuntime });
    }
  });
});
