import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Computers, CloudV2ComputerBuilder } from "./computer.js";
import type { CloudV2Compute } from "./boat.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("independent retry admission after drain contention", () => {
  let pool: pg.Pool;
  const oldRuntime = "a".repeat(64), nextRuntime = "b".repeat(64), commit = "a".repeat(40);
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());

  async function fixture() {
    const user = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const base = await computers.enqueue(org, user, { repositories: [{ repository: "fixture/repo", commit, branch: "main" }] });
    await computers.claim(oldRuntime); await computers.activate(base.id, "fixture-base");
    const failed = (await computers.enqueueAutomatic(org, base.id, "runtime", nextRuntime))!;
    await computers.claim(nextRuntime); await computers.fail(failed.id, "computer_build_interrupted");
    await pool.query("UPDATE cloud_v2_computer_builds SET finished_at=clock_timestamp()-interval '61 seconds' WHERE id=$1", [failed.id]);
    expect(await computers.retryInterrupted(nextRuntime)).toBe(1);
    const retry = (await computers.overview(org)).builds[0]!;
    return { user, org, computers, base, failed, retry };
  }

  async function holdDrain() {
    const tx = await pool.connect();
    await tx.query("BEGIN");
    await tx.query("SELECT singleton FROM cloud_runtime_build_drain WHERE singleton FOR UPDATE");
    const pid = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { tx, waiting: () => expect.poll(async () => (await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%cloud_runtime_build_claim_allowed%'", [pid],
    )).rows[0].n, { timeout: 2500 }).toBe(1) };
  }

  it.each([false, true])("rechecks retry recipe ownership after the drain wait (edited=%s)", async edited => {
    const f = await fixture(), held = await holdDrain();
    const claiming = f.computers.claim(nextRuntime);
    let result: Awaited<typeof claiming>;
    try {
      await held.waiting();
      if (edited) await f.computers.saveRecipe(f.org, f.user, [{ repository: "fixture/repo", ref: "new-intent" }], 0);
      await held.tx.query("COMMIT"); result = await claiming;
    } finally { await held.tx.query("ROLLBACK"); held.tx.release(); await claiming.catch(() => {}); }
    if (edited) expect(result).toBeNull();
    else expect(result?.id).toBe(f.retry.id);
  });

  it.each([false, true])("admits a provider only for the retry recipe still owned after the wait (edited=%s)", async edited => {
    const f = await fixture(), held = await holdDrain();
    const compute: CloudV2Compute = {
      create: vi.fn(async () => ({ sandboxId: "bx_probe1234" })), resume: vi.fn(), extendLease: vi.fn(), stop: vi.fn(), delete: vi.fn(),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      execLong: vi.fn(async () => ({ exitCode: 0, stdout: `zeros-build-branch=main\n${commit}\n`, timedOut: false })),
      saveSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
    };
    const builder = new CloudV2ComputerBuilder({ computers: f.computers, compute, runtime: { sha256: nextRuntime, url: async () => "https://example.test/runtime" },
      channel: "alpha", cloneToken: async () => "synthetic-token" });
    const tick = builder.tick();
    try {
      await held.waiting();
      if (edited) await f.computers.saveRecipe(f.org, f.user, [{ repository: "fixture/repo", ref: "new-intent" }], 0);
      await held.tx.query("COMMIT"); await tick;
    } finally { await held.tx.query("ROLLBACK"); held.tx.release(); await tick.catch(() => {}); builder.close(); }
    if (edited) expect(compute.create).not.toHaveBeenCalled();
    else expect(compute.create).toHaveBeenCalledOnce();
    expect((await f.computers.overview(f.org)).builds.find(build => build.id === f.failed.id))
      .toMatchObject({ state: "failed", errorCode: "computer_build_interrupted" });
  });
});
