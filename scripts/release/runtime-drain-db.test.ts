import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrationPool, withSystemTx } from "../../apps/control-plane/src/db";
import { resetMigratedTestDatabase } from "../../apps/control-plane/src/test-database";
import { grantTestPro } from "../../apps/control-plane/src/test-pro";
import { CloudV2Computers } from "../../apps/control-plane/src/cloud/computer";
import { CloudV2Store } from "../../apps/control-plane/src/cloud/store";
import { RuntimeHandoffStore } from "../../apps/control-plane/src/cloud/runtime-handoff-store";
import { beginBuildDrain } from "../../apps/control-plane/src/cloud/runtime-build-drain";
import { runtimeDrain, existingRuntimeDrain, RUNTIME_BUILD_DRAIN_TTL_MS } from "./runtime-drain";
import { releaseRuntime, type RuntimeReleaseDependencies, type RuntimeDrainLease } from "./runtime-release";
import type { RuntimeReleaseConfig } from "./runtime-contracts";

const pg = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url))("pg");
describe.skipIf(!process.env.TEST_DATABASE_URL)("runtime controller with the actual operator drain", () => {
  let pool: ReturnType<typeof createMigrationPool>;
  beforeAll(() => { pool = createMigrationPool(process.env.TEST_DATABASE_URL!, { role: "none", maxConnections: 6 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  function fixture() {
    const config: RuntimeReleaseConfig = { channel: "alpha", action: "publish", repository: "fixture/repo", branch: "main",
      workflowSha: "1".repeat(40), sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64), runId: "123", runAttempt: 1 };
    const drain = runtimeDrain(config, pool);
    const release = { version: 1 as const, sha256: "b".repeat(64), sourceSha: config.sourceSha!, sourceSha256: "c".repeat(64),
      qualification: { channel: "alpha" as const, runId: config.runId, runAttempt: 1, completedAt: new Date().toISOString(), receiptSha256: "d".repeat(64), deleted: true as const } };
    const manifest = { version: 1 as const, repository: config.repository, sha256: release.sha256, sourceSha: release.sourceSha, sourceSha256: release.sourceSha256, bytes: 123 };
    const live = { branch: config.branch, current: { sha256: config.expectedRuntimeSha256, release: null }, previous: null,
      identity: { version: 1 as const, channel: config.channel, ready: true as const, maintenance: false as const, sourceSha: config.expectedCpSha,
        migrations: { state: "current" as const, head: "0221_cloud_computer_build_recovery.sql", expectedHead: "0221_cloud_computer_build_recovery.sql", manifestSha256: "e".repeat(64) },
        cloud: { enabled: true as const, ready: true as const, state: "healthy" as const }, worker: { sha256: config.expectedRuntimeSha256 }, workerQualified: false,
        runtimeCanaryAdmission: 1 as const, runtimeBuildDrainVersion: 1 as const } };
    let lease: RuntimeDrainLease | undefined;
    const deps: RuntimeReleaseDependencies = {
      source: vi.fn(async () => {}), current: vi.fn(async () => live), prepare: vi.fn(async () => manifest),
      qualify: vi.fn(async () => release), qualification: vi.fn(async () => release), retain: vi.fn(async () => {}),
      beginDrain: vi.fn(async () => { const result = await drain.beginDrain(); lease = result.lease; return result; }),
      inspectDrain: drain.inspectDrain, endDrain: vi.fn(drain.endDrain), pause: vi.fn(async () => {}),
      stage: vi.fn(async () => { expect(await drain.inspectDrain(lease!)).toMatchObject({ ready: true, state: "active", liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0 }); }),
      deploy: vi.fn(async () => "fixture-deployment"), wait: vi.fn(async () => {}), recover: vi.fn(async () => ({ releaseDrain: true })), record: vi.fn(async () => {}),
    };
    return { config, drain, deps, live, lease: () => lease, run: () => releaseRuntime(config, deps) };
  }
  async function owner() {
    const user = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Runtime controller fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Controller fixture',$3,false,true)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    return { user, org, computers };
  }
  async function committedAdoption() {
    const { user, org } = await owner(), store = new CloudV2Store(pool), handoffs = new RuntimeHandoffStore(pool);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: user, name: "Fixture", repository: "fixture/repo",
      sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await store.rotateWorkerToken(workspace.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot); await handoffs.recordRuntime(token, boot, "a".repeat(64));
    const revision = (await store.workerSession(token, boot))!.loginRevision;
    const handoff = (await handoffs.prepare(token, boot, { target: "b".repeat(64), instanceId: randomUUID(), revision, generation: 1 }))!;
    expect(await handoffs.commit(token, boot, handoff.id, revision, 1, handoff.target_sha256)).toBe(true);
    return async () => { await handoffs.activate(token, handoff.id); expect(await handoffs.promote(token, handoff.id, handoff.next_boot_id)).toBe(true); await handoffs.complete(handoff.id); };
  }

  it("uses migration authority, blocks an old claim writer and confirms end before recording success", async () => {
    const f = fixture(), { org, user, computers } = await owner();
    const job = await computers.enqueue(org, user, { repositories: [{ repository: "fixture/repo" }] });
    vi.mocked(f.deps.stage).mockImplementation(async () => {
      const result = await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_computer_builds SET state='building' WHERE id=$1 RETURNING id", [job.id]));
      expect(result.rowCount).toBe(0);
      const row = (await pool.query("SELECT run_id,ttl_ms FROM cloud_runtime_build_drain WHERE singleton")).rows[0];
      expect(row).toEqual({ run_id: f.config.runId, ttl_ms: RUNTIME_BUILD_DRAIN_TTL_MS });
      expect((await pool.query("SELECT current_user AS role")).rows[0].role).not.toBe("zeros_app");
    });
    await f.run();
    expect(await f.drain.inspectDrain(f.lease()!)).toMatchObject({ state: "ended", ready: false });
    expect(await f.drain.endDrain(f.lease()!)).toEqual({ version: 1, lease: f.lease(), released: true });
    expect(f.deps.endDrain).toHaveBeenCalledBefore(f.deps.record);
    expect((await computers.claim())?.id).toBe(job.id);
  });
  it("cleanup reads an existing run receipt without allocating or renewing a drain", async () => {
    const f = fixture();
    expect(await existingRuntimeDrain(f.config, pool)).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_runtime_build_drain_runs")).rows[0].count).toBe(0);
    const first = await f.drain.beginDrain();
    expect((await existingRuntimeDrain(f.config, pool))?.lease).toEqual(first.lease);
    await f.drain.endDrain(first.lease);
    expect(await existingRuntimeDrain(f.config, pool)).toMatchObject({ lease: first.lease, state: "ended" });
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_runtime_build_drain_runs")).rows[0].count).toBe(1);
  });
  it("cleanup cannot recover a foreign binding or use an old receipt to end a successor", async () => {
    const f = fixture(), first = await f.drain.beginDrain();
    await expect(existingRuntimeDrain({ ...f.config, expectedCpSha: "9".repeat(40) }, pool)).rejects.toThrow();
    await f.drain.endDrain(first.lease);
    const next = runtimeDrain({ ...f.config, runId: "124" }, pool), successor = await next.beginDrain();
    await expect(existingRuntimeDrain(f.config, pool)).rejects.toThrow();
    expect(await next.inspectDrain(successor.lease)).toMatchObject({ state: "active" });
  });

  it.each(["liveCount", "unresolvedCount", "runtimeAdoptionCount"] as const)("waits on the real %s without cancelling admitted work", async count => {
    const f = fixture(); let finish: () => Promise<unknown>;
    if (count === "runtimeAdoptionCount") finish = await committedAdoption();
    else {
      const { user, org, computers } = await owner(), job = await computers.enqueue(org, user, { repositories: [{ repository: "fixture/repo" }] });
      expect((await computers.claim())?.id).toBe(job.id);
      if (count === "unresolvedCount") {
        await computers.prepareResource(job.id); await computers.fail(job.id, "computer_build_interrupted");
        finish = () => computers.createRefused(job.id);
      } else finish = async () => { await computers.heartbeat(job.id); await computers.fail(job.id, "fixture_completion"); };
    }
    vi.mocked(f.deps.pause!).mockImplementation(async () => {
      expect(await f.drain.inspectDrain(f.lease()!)).toMatchObject({ [count]: 1, ready: false });
      expect(f.deps.stage).not.toHaveBeenCalled(); await finish();
    });
    await f.run();
    expect(f.deps.pause).toHaveBeenCalledOnce(); expect(f.deps.beginDrain).toHaveBeenCalledOnce();
    expect(f.deps.stage).toHaveBeenCalledOnce(); expect(f.deps.record).toHaveBeenCalledOnce();
  });

  it("keeps a run consumed across workflow attempts and cannot release a successor", async () => {
    const f = fixture(), first = await f.drain.beginDrain(); await f.drain.endDrain(first.lease);
    const successor = runtimeDrain({ ...f.config, runId: "124" }, pool), next = await successor.beginDrain();
    const replay = runtimeDrain({ ...f.config, runAttempt: 2 }, pool);
    expect(await replay.beginDrain()).toMatchObject({ lease: first.lease, state: "ended", ready: false });
    await expect(replay.endDrain(first.lease)).rejects.toMatchObject({ code: "runtime_build_drain_mismatch" });
    await expect(f.run()).rejects.toThrow(); expect(f.deps.stage).not.toHaveBeenCalled();
    expect(await successor.inspectDrain(next.lease)).toMatchObject({ state: "active", ready: true });
  });

  it("refuses operator actions with an app role without exposing a database error", async () => {
    const f = fixture(), appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 1 });
    try {
      const wrong = runtimeDrain(f.config, appPool);
      await expect(wrong.beginDrain()).rejects.toMatchObject({ code: "runtime_build_drain_unavailable" });
      const owned = await f.drain.beginDrain();
      await expect(wrong.endDrain(owned.lease)).rejects.toMatchObject({ code: "runtime_build_drain_unavailable" });
      expect(await f.drain.inspectDrain(owned.lease)).toMatchObject({ state: "active", ready: true });
    } finally { await appPool.end(); }
  });

  it("refuses renewal of an expired run or a changed TTL", async () => {
    const f = fixture(), first = await beginBuildDrain(pool, { runId: f.config.runId, liveCpSha: f.config.expectedCpSha,
      priorRuntimeSha256: f.config.expectedRuntimeSha256, ttlMs: 1000 });
    await expect.poll(async () => (await f.drain.inspectDrain(first.lease)).state, { timeout: 2500 }).toBe("expired");
    await expect(f.drain.beginDrain()).rejects.toMatchObject({ code: "runtime_build_drain_mismatch" });
    expect(await f.drain.inspectDrain(first.lease)).toMatchObject({ lease: first.lease, state: "expired", ready: false });
    expect(await f.drain.endDrain(first.lease)).toEqual({ version: 1, lease: first.lease, released: true });
  });

  it("does not turn a lost commit acknowledgement into confirmed drain release", async () => {
    const f = fixture(), first = await f.drain.beginDrain(), connect = pool.connect.bind(pool), cleanups: Array<() => void> = [];
    let lost = false;
    const intercepted = vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await connect(), query = client.query.bind(client);
      const spy = vi.spyOn(client, "query").mockImplementation(async (...args) => {
        const result = await query(...args);
        if (args[0] === "COMMIT" && !lost) { lost = true; throw new Error("synthetic lost commit reply"); }
        return result;
      });
      cleanups.push(() => spy.mockRestore()); return client;
    });
    try { await expect(f.drain.endDrain(first.lease)).rejects.toMatchObject({ code: "runtime_build_drain_unavailable" }); }
    finally { cleanups.forEach(cleanup => cleanup()); intercepted.mockRestore(); }
    expect(await f.drain.inspectDrain(first.lease)).toMatchObject({ state: "ended", ready: false });
    expect(await f.drain.endDrain(first.lease)).toEqual({ version: 1, lease: first.lease, released: true });
  });

  it("recovers a committed begin with a lost reply and ends that exact run without staging", async () => {
    const f = fixture(), connect = pool.connect.bind(pool), cleanups: Array<() => void> = [];
    const interceptedClients = new WeakSet<object>();
    let lost = false;
    const intercepted = vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await connect();
      if (interceptedClients.has(client)) return client;
      interceptedClients.add(client);
      const query = client.query.bind(client);
      const spy = vi.spyOn(client, "query").mockImplementation(async (...args) => {
        const result = await query(...args);
        if (args[0] === "COMMIT" && !lost) { lost = true; throw new Error("synthetic lost begin reply"); }
        return result;
      });
      cleanups.push(() => spy.mockRestore()); return client;
    });
    try { await expect(f.run()).rejects.toThrow(); }
    finally { cleanups.forEach(cleanup => cleanup()); intercepted.mockRestore(); }
    const recovered = await f.drain.beginDrain();
    expect(recovered).toMatchObject({ state: "ended", ready: false, lease: { runId: f.config.runId } });
    expect(f.deps.stage).not.toHaveBeenCalled(); expect(f.deps.record).not.toHaveBeenCalled();
    expect(f.deps.endDrain).toHaveBeenCalledExactlyOnceWith(recovered.lease);
  });

  it("does not treat a migrated database as an old control plane's live capability", async () => {
    const f = fixture(); delete (f.live.identity as Record<string, unknown>).runtimeBuildDrainVersion;
    await expect(f.run()).rejects.toThrow(); expect(f.deps.beginDrain).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_runtime_build_drain_runs")).rows[0].n).toBe(0);
  });
});
