import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { withSystemTx } from "../db.js";
import { CloudV2Computers } from "./computer.js";
import { beginBuildDrain, inspectBuildDrain, endBuildDrain, buildDrainActive, runtimeBuildDrainVersion } from "./runtime-build-drain.js";
import { CloudV2Store } from "./store.js";
import { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import { RuntimeAdoption } from "./runtime-adoption.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("versioned release build drain", () => {
  let pool: pg.Pool, computers: CloudV2Computers, org: string, user: string;
  const input = () => ({ runId: randomUUID(), liveCpSha: "a".repeat(40), priorRuntimeSha256: "b".repeat(64), ttlMs: 60_000 });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool); org = randomUUID(); user = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
  });
  const queued = () => computers.enqueue(org, user, { repositories: [{ repository: "fixture/repo" }] });

  it.each([false, true])("blocks claims through the shared database boundary (old writer=%s)", async old => {
    const job = await queued(), drain = await beginBuildDrain(pool, input());
    try {
      expect(drain).toMatchObject({ version: 1, state: "active", liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0, ready: true });
      if (old) {
        const result = await withSystemTx(pool, tx => tx.query(`UPDATE cloud_v2_computer_builds SET state='building',started_at=clock_timestamp(),heartbeat_at=clock_timestamp()
          WHERE id=(SELECT b.id FROM cloud_v2_computer_builds b JOIN organizations o ON o.id=b.org_id
            WHERE b.state='queued' AND b.cleanup_requested_at IS NULL AND o.deleted_at IS NULL
            ORDER BY b.created_at LIMIT 1 FOR UPDATE OF b SKIP LOCKED) RETURNING id`));
        expect(result.rowCount).toBe(0);
      } else expect(await computers.claim()).toBeNull();
      expect((await computers.overview(org)).builds[0]).toMatchObject({ id: job.id, state: "queued" });
    } finally { await endBuildDrain(pool, drain.lease); }
    expect((await computers.claim())?.id).toBe(job.id);
  });
  it("binds retries and release to the exact run, live source, prior pin and expiry", async () => {
    const request = input(), first = await beginBuildDrain(pool, request);
    expect(runtimeBuildDrainVersion).toBe(1);
    expect(await beginBuildDrain(pool, request)).toEqual(first);
    await expect(beginBuildDrain(pool, input())).rejects.toMatchObject({ code: "runtime_build_drain_conflict" });
    await expect(beginBuildDrain(pool, { ...request, liveCpSha: "c".repeat(40) })).rejects.toMatchObject({ code: "runtime_build_drain_mismatch" });
    await expect(endBuildDrain(pool, { ...first.lease, priorRuntimeSha256: "d".repeat(64) })).rejects.toMatchObject({ code: "runtime_build_drain_mismatch" });
    expect(await buildDrainActive(pool)).toBe(true);
    expect(await endBuildDrain(pool, first.lease)).toEqual({ version: 1, lease: first.lease, released: true });
    expect(await endBuildDrain(pool, first.lease)).toMatchObject({ released: true });
    expect(await inspectBuildDrain(pool, first.lease)).toMatchObject({ state: "ended", ready: false });
    const successor = await beginBuildDrain(pool, input());
    expect(await beginBuildDrain(pool, request)).toMatchObject({ lease: first.lease, state: "ended", ready: false });
    await expect(endBuildDrain(pool, first.lease)).rejects.toMatchObject({ code: "runtime_build_drain_mismatch" });
    expect(await inspectBuildDrain(pool, successor.lease)).toMatchObject({ state: "active", ready: true });
  });
  it("waits for active claims and unresolved provider effects separately", async () => {
    const job = await queued(); await computers.claim();
    const drain = await beginBuildDrain(pool, input());
    expect(drain).toMatchObject({ liveCount: 1, unresolvedCount: 0, ready: false });
    await computers.prepareResource(job.id); await computers.fail(job.id, "computer_build_interrupted");
    expect(await inspectBuildDrain(pool, drain.lease)).toMatchObject({ liveCount: 0, unresolvedCount: 1, ready: false });
    await computers.createRefused(job.id);
    expect(await inspectBuildDrain(pool, drain.lease)).toMatchObject({ liveCount: 0, unresolvedCount: 0, ready: true });
  });
  it("expires without silently extending a lost-response retry", async () => {
    const request = { ...input(), ttlMs: 1000 }, first = await beginBuildDrain(pool, request);
    await expect.poll(async () => (await inspectBuildDrain(pool, first.lease)).state, { timeout: 2500 }).toBe("expired");
    expect(await beginBuildDrain(pool, request)).toMatchObject({ lease: first.lease, state: "expired", ready: false });
    expect(await buildDrainActive(pool)).toBe(false);
  });
  it("does not let the app system role acquire or release a drain", async () => {
    const runtimePool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 1 });
    try {
      await expect(beginBuildDrain(runtimePool, input())).rejects.toMatchObject({ code: "42501" });
      const current = await beginBuildDrain(pool, input());
      await expect(endBuildDrain(runtimePool, current.lease)).rejects.toMatchObject({ code: "42501" });
      expect(await buildDrainActive(runtimePool)).toBe(true);
    } finally { await runtimePool.end(); }
  });

  it("waits for an earlier old-writer claim before reporting the drain counts", async () => {
    const job = await queued(), blocker = await pool.connect();
    let draining: ReturnType<typeof beginBuildDrain> | undefined;
    try {
      await blocker.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      await blocker.query("UPDATE cloud_v2_computer_builds SET state='building',started_at=clock_timestamp(),heartbeat_at=clock_timestamp() WHERE id=$1", [job.id]);
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      draining = beginBuildDrain(pool, input());
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount).toBeGreaterThan(0);
      await blocker.query("COMMIT");
      const drain = await draining;
      expect(drain).toMatchObject({ liveCount: 1, ready: false });
      await computers.heartbeat(job.id); await computers.fail(job.id, "fixture_failure");
      expect(await inspectBuildDrain(pool, drain.lease)).toMatchObject({ liveCount: 0, ready: true });
      await endBuildDrain(pool, drain.lease);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await draining?.catch(() => {}); }
  });

  it("refuses an old claim that waited behind the release lease publication", async () => {
    const job = await queued(), request = input(), blocker = await pool.connect();
    let claiming: Promise<pg.QueryResult> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`UPDATE cloud_runtime_build_drain SET lease_id=$1,run_id=$2,live_cp_sha=$3,prior_runtime_sha256=$4,
        ttl_ms=$5,expires_at=clock_timestamp()+interval '1 minute' WHERE singleton`,
      [randomUUID(), request.runId, request.liveCpSha, request.priorRuntimeSha256, request.ttlMs]);
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      claiming = withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_computer_builds SET state='building' WHERE id=$1 RETURNING id", [job.id]));
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount).toBeGreaterThan(0);
      await blocker.query("COMMIT");
      expect((await claiming).rowCount).toBe(0);
      expect((await computers.overview(org)).builds[0]!.state).toBe("queued");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await claiming?.catch(() => {}); }
  });

  async function prepared() {
    const store = new CloudV2Store(pool), handoffs = new RuntimeHandoffStore(pool);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: user, name: "Fixture",
      repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot); await handoffs.recordRuntime(token, boot, "a".repeat(64));
    const revision = (await store.workerSession(token, boot))!.loginRevision;
    const handoff = (await handoffs.prepare(token, boot, { target: "b".repeat(64), instanceId: randomUUID(), revision, generation: 1 }))!;
    return { store, handoffs, workspace, token, boot, revision, handoff };
  }

  it("blocks preparation and commitment, including an older handoff writer", async () => {
    const f = await prepared(), drain = await beginBuildDrain(pool, input());
    try {
      expect(drain.ready).toBe(true);
      expect(await f.handoffs.prepare(f.token, f.boot, { target: "c".repeat(64), instanceId: f.handoff.instance_id, revision: f.revision, generation: 2 })).toBeNull();
      expect(await f.handoffs.commit(f.token, f.boot, f.handoff.id, f.revision, 1, f.handoff.target_sha256)).toBe(false);
      expect((await withSystemTx(pool, tx => tx.query("UPDATE cloud_worker_runtime_handoffs SET state='committed' WHERE id=$1 RETURNING id", [f.handoff.id]))).rowCount).toBe(0);
    } finally { await endBuildDrain(pool, drain.lease); }
    expect(await f.handoffs.commit(f.token, f.boot, f.handoff.id, f.revision, 1, f.handoff.target_sha256)).toBe(true);
  });

  it("waits for a committed adoption while allowing its activation and readiness to finish", async () => {
    const f = await prepared(); expect(await f.handoffs.commit(f.token, f.boot, f.handoff.id, f.revision, 1, f.handoff.target_sha256)).toBe(true);
    const drain = await beginBuildDrain(pool, input());
    expect(drain).toMatchObject({ runtimeAdoptionCount: 1, ready: false });
    const adoption = new RuntimeAdoption({ store: f.store, handoffs: f.handoffs, authorizeSource: async () => {},
      drainActive: () => buildDrainActive(pool), runtimeForWorkspace: async () => ({ sha256: "b".repeat(64), url: async () => "https://fixture.example.test/runtime" }),
      compute: { execLong: async () => ({ exitCode: 0, stdout: "", timedOut: false }) } });
    try {
      expect(await adoption.request(f.token, f.boot, { op: "activate", id: f.handoff.id })).toMatchObject({ status: "activating" });
      expect(await adoption.request(f.token, f.handoff.next_boot_id, { op: "ready", id: f.handoff.id })).toMatchObject({ status: "completed" });
      expect(await inspectBuildDrain(pool, drain.lease)).toMatchObject({ runtimeAdoptionCount: 0, ready: true });
    } finally { adoption.close(); await endBuildDrain(pool, drain.lease); }
  });
});
