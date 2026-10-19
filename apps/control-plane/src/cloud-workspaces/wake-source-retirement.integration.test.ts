import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { CloudAgentBootCredentialResponseSchema } from "./agent-boot-contract.js";
import { CloudProviderError, type CloudProviderResource, type CloudWorkspaceProvider } from "./provider.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { previousBackendWake } from "./lifecycle-compatibility-fixtures.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { commitFinalSaveFixture, sealFinalSaveFixture } from "./final-save-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("wake source retirement", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
  });

  async function readySource(state: CloudProviderResource["state"] = "archived", saved = state !== "running") {
    const fixture = await seedReadyCloudWorkspace(pool);
    await pool.query(`INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib)
      VALUES($1,10,10,100000,100000,1000000) ON CONFLICT(org_id) DO NOTHING`, [fixture.organizationId]);
    const scope = { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
      generation: 1, engineInstanceId: fixture.engineInstanceId };
    const engine = { ...scope, heartbeatToken: fixture.heartbeatToken };
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1", [fixture.engineInstanceId]);
    const execution = new DatabaseCloudAgentExecutionService(pool, { currentKeyVersion: 1,
      keys: { 1: randomBytes(32).toString("base64url") } }, false);
    const boot = CloudAgentBootCredentialResponseSchema.parse(await execution.boot(engine, "bootstrap", { ...scope, version: 1, mode: "boot-owner-v1" }));
    await execution.boot(engine, "activate", { ...scope, version: 1, mode: "boot-owner-v1",
      bootId: boot.bootId, writerEpoch: boot.writerEpoch, expectedCacheRevision: boot.cacheRevision });
    if (saved) {
      await sealFinalSaveFixture(pool, engine);
      const intentId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
        VALUES($1::uuid,$2,$3,1,$4,'archive',$1::text,digest($1::text,'sha256'))`,
      [intentId,fixture.workspaceId,fixture.organizationId,fixture.userId]);
      await commitFinalSaveFixture(pool, engine, { intentId,userId:fixture.userId,reason:"before_archive" });
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [intentId]);
    }
    const binding = (await pool.query(`UPDATE cloud_workspace_provider_bindings
      SET last_observed_at=now()-interval '1 hour',next_drift_check_at=now()
      WHERE workspace_id=$1 AND generation=1 RETURNING provider_resource_id`, [fixture.workspaceId])).rows[0];
    let resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1,
      resourceId: binding.provider_resource_id, state, target: null, metadata: {} };
    let stopError: CloudProviderError | null = null;
    const source = async () => (await pool.query(`SELECT writer.state,binding.retired_at IS NOT NULL AS binding_retired
      FROM cloud_workspace_local_command_writers writer JOIN cloud_agent_boot_bindings binding
        ON binding.workspace_id=writer.workspace_id AND binding.writer_epoch=writer.writer_epoch
      WHERE writer.workspace_id=$1 AND writer.writer_epoch=$2`, [fixture.workspaceId, boot.writerEpoch])).rows[0];
    const atStart: unknown[] = [];
    const unused = vi.fn(async (): Promise<never> => { throw new Error("Unexpected provider operation"); });
    const stop = vi.fn(async () => {
      if (stopError) throw stopError;
      resource = { ...resource, state: "archived" };
      return resource;
    });
    const start = vi.fn(async () => {
      atStart.push(await source());
      resource = { ...resource, state: "running" };
      return resource;
    });
    const provider: CloudWorkspaceProvider = { name: "boat", inspect: async () => resource, find: async () => [resource],
      create: unused, delete: unused, archive: unused, stop, start,
      async *listManaged() { yield resource; } };
    const worker = new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1_000 });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: fixture.userId }); await next(); });
    const config = { provider: "boat", imageRef: "fixture-image", architecture: "linux/amd64", cpuMillicores: 2000,
      memoryMiB: 4096, storageMiB: 20480, sourceCommit: "b".repeat(40), settingsSecretEncryptionKeys: {},
      currentSettingsSecretEncryptionKeyVersion: null } as CloudWorkspaceBackendConfig;
    app.route("/", createCloudWorkspaceRoutes(pool, config, { workosEnabled: false }));
    app.onError((error, c) => error instanceof HttpError ? c.json({ code: error.code }, error.status) : c.json({ code: "unexpected_error" }, 500));
    const wake = async (key = randomUUID()) => {
      const response = await app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}/wake`,
        { method: "POST", headers: { "idempotency-key": key } });
      const body = await response.json();
      expect([200, 202], JSON.stringify(body)).toContain(response.status);
      return body;
    };
    const run = async () => { for (let step = 0; step < 5; step++) if (!await worker.runOnce()) break; };
    const drains = async () => (await pool.query(`SELECT id,state,next_attempt_at FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=$1 AND operation='stop' ORDER BY created_at,id`, [fixture.workspaceId])).rows;
    return { fixture, boot, engine, worker, provider, source, wake, run, atStart, stop, start, drains,
      setState: (state: CloudProviderResource["state"]) => { resource = { ...resource, state }; },
      failStop: (error: CloudProviderError | null) => { stopError = error; } };
  }

  // Exercise the real owner route after terminal failure, not just the
  // uninterrupted worker-created stop/wake chain.
  it("retries source retirement on a fresh owner wake after its internal drain failed", async () => {
    const f = await readySource();
    f.failStop(new CloudProviderError("synthetic_access_drain_failed", "Synthetic drain failure", false));
    expect(await f.worker.reconcileDriftOnce()).toBe(true);
    expect(await f.worker.runOnce()).toBe(true);
    expect((await f.drains())[0].state).toBe("failed");
    expect((await pool.query(`SELECT state,error_code FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=$1 AND operation='wake'`, [f.fixture.workspaceId])).rows)
      .toEqual([{ state: "failed", error_code: "workspace_drain_failed" }]);
    expect(await f.source()).toEqual({ state: "active", binding_retired: false });

    const wake = await f.wake();
    f.failStop(null);
    await f.run();
    expect(f.atStart).not.toContainEqual({ state: "active", binding_retired: false });
    expect(f.atStart).toEqual([{ state: "retired", binding_retired: true }]);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wake.intent.id])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT sealed_sequence,seal,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.boot.writerEpoch])).rows[0])
      .toEqual({ sealed_sequence: "0", seal: expect.any(Object), seal_ack: expect.any(Object) });
  });

  it("retains an unsaved cold source without a controlled stop or restart", async () => {
    const f = await readySource("archived", false);
    await f.worker.reconcileDriftOnce();
    await f.wake(); await f.run();
    expect(f.stop).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    expect(await f.source()).toEqual({ state:"active",binding_retired:false });
    expect((await pool.query(`SELECT state FROM cloud_workspace_final_save_recoveries
      WHERE workspace_id=$1`, [f.fixture.workspaceId])).rows).toEqual([{ state:"capturing" }]);
  });

  it.each(["stopped", "archived"] as const)("retires a %s source before a direct owner wake without a drift pass", async state => {
    const f = await readySource(state);
    await pool.query("UPDATE cloud_workspaces SET desired_state='stopped',status='stopped' WHERE id=$1", [f.fixture.workspaceId]);
    await f.wake();
    await f.run();
    expect(f.atStart).toEqual([{ state: "retired", binding_retired: true }]);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("gates an already queued unlinked cold wake before any provider start", async () => {
    const f = await readySource();
    await pool.query("UPDATE cloud_workspaces SET status='waking' WHERE id=$1", [f.fixture.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1,1,$2,$3,'wake',$4,$5)`, [f.fixture.workspaceId, f.fixture.organizationId, f.fixture.userId, randomUUID(), randomBytes(32)]);
    await f.run();
    expect(f.atStart).toEqual([{ state: "retired", binding_retired: true }]);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("rejects an unlinked older-worker SQL claim after source retirement failed", async () => {
    const f = await readySource();
    f.failStop(new CloudProviderError("synthetic_access_drain_failed", "Synthetic drain failure", false));
    await f.worker.reconcileDriftOnce();
    await f.worker.runOnce();
    expect((await f.drains())[0].state).toBe("failed");
    const wakeId = await withSystemTx(pool, tx => previousBackendWake(tx, f.fixture));
    expect((await pool.query("SELECT resume_after_intent_id FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wakeId])).rows[0].resume_after_intent_id).toBeNull();
    // Freeze the old dispatch boundary directly: the previous reconciler
    // fixture deliberately shares runOnce and cannot prove this rollout fence.
    await expect(pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching' WHERE id=$1", [wakeId]).then(() => undefined))
      .rejects.toMatchObject({ code: "40001" });
    f.failStop(null);
    await f.run();
    expect(f.atStart).toEqual([{ state: "retired", binding_retired: true }]);
  });

  it("leaves a terminal retirement failure visible during later background drift", async () => {
    const f = await readySource();
    f.failStop(new CloudProviderError("synthetic_access_drain_failed", "Synthetic drain failure", false));
    await f.worker.reconcileDriftOnce();
    await f.worker.runOnce();
    await pool.query("UPDATE cloud_workspace_provider_bindings SET next_drift_check_at=now() WHERE workspace_id=$1", [f.fixture.workspaceId]);
    await f.worker.reconcileDriftOnce();
    await f.run();
    expect((await f.drains()).map(row => row.state)).toEqual(["failed"]);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.atStart).toEqual([]);
    expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [f.fixture.workspaceId])).rows[0])
      .toEqual({ status: "failed", last_error_code: "workspace_drain_failed" });
  });

  it.each(["failed", "superseded"] as const)("publishes a %s predecessor drain inherited by background drift", async state => {
    const f = await readySource();
    const drainId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,state,completed_at)
      VALUES($1,$2,1,$3,'stop',$4,$5,$6,now())`,
    [drainId, f.fixture.workspaceId, f.fixture.organizationId, randomUUID(), randomBytes(32), state]);
    await f.worker.reconcileDriftOnce();
    expect((await pool.query(`SELECT state,error_code,resume_after_intent_id FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=$1 AND operation='wake'`, [f.fixture.workspaceId])).rows)
      .toEqual([{ state: "failed", error_code: "workspace_drain_failed", resume_after_intent_id: drainId }]);
    expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [f.fixture.workspaceId])).rows[0])
      .toEqual({ status: "failed", last_error_code: "workspace_drain_failed" });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.atStart).toEqual([]);
    await f.wake();
    await f.run();
    expect(f.atStart).toEqual([{ state: "retired", binding_retired: true }]);
  });

  async function pendingOriginalWake(f: Awaited<ReturnType<typeof readySource>>) {
    // A source created during this wake is not a predecessor at claim time.
    // A later cold observation must still retire it before restarting the VM.
    await pool.query("UPDATE cloud_workspaces SET status='waking' WHERE id=$1", [f.fixture.workspaceId]);
    return (await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,created_at)
      VALUES($1,1,$2,$3,'wake',$4,$5,now()-interval '1 minute') RETURNING id`,
    [f.fixture.workspaceId, f.fixture.organizationId, f.fixture.userId, randomUUID(), randomBytes(32)])).rows[0].id as string;
  }

  it("drains a source discovered cold by the common provider observation before restarting", async () => {
    const f = await readySource();
    await pendingOriginalWake(f);
    await f.run();
    expect(f.atStart).toEqual([{ state: "retired", binding_retired: true }]);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each(["provider binding", "authority epoch", "claim"] as const)("discards a cold observation after its %s changed", async changed => {
    const f = await readySource();
    const wakeId = await pendingOriginalWake(f);
    let entered!: () => void, finish!: () => void;
    const inspecting = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    const inspect = f.provider.inspect.bind(f.provider);
    vi.spyOn(f.provider, "inspect").mockImplementationOnce(async id => {
      const result = await inspect(id);
      entered(); await release; return result;
    });
    const pass = f.worker.runOnce();
    await inspecting;
    try {
      if (changed === "provider binding") await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='replacement' WHERE workspace_id=$1", [f.fixture.workspaceId]);
      else if (changed === "authority epoch") await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [f.fixture.workspaceId]);
      else await pool.query("UPDATE cloud_workspace_lifecycle_intents SET lease_owner='other-worker' WHERE id=$1", [wakeId]);
    } finally { finish(); }
    await pass;
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.drains()).toEqual([]);
    expect(await f.source()).toEqual({ state: "active", binding_retired: false });
  });

  it("preserves the existing drain and its provider backoff across repeated owner wakes", async () => {
    const f = await readySource();
    f.failStop(new CloudProviderError("provider_rate_limited", "Synthetic retryable drain failure", true, { retryAfterMs: 60_000 }));
    await f.worker.reconcileDriftOnce();
    await f.worker.runOnce();
    const [drain] = await f.drains();
    expect(drain.state).toBe("observing");
    const key = randomUUID();
    const first = await f.wake(key);
    expect((await f.wake(key)).intent.id).toBe(first.intent.id);
    await f.wake();
    await f.run();
    expect(f.atStart).toEqual([]);
    expect(await f.drains()).toEqual([drain]);
    f.failStop(null);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=now() WHERE id=$1", [drain.id]);
    await f.run();
    expect(f.atStart).toEqual([{ state: "retired", binding_retired: true }]);
  });

  it("keeps a ready owner wake warm without retiring its active source", async () => {
    const f = await readySource("running");
    expect((await f.wake()).intent.state).toBe("succeeded");
    await f.run();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.source()).toEqual({ state: "active", binding_retired: false });
  });

  it("resumes an already retired source without another provider drain", async () => {
    const f = await readySource();
    await f.worker.reconcileDriftOnce();
    await f.run();
    f.stop.mockClear(); f.start.mockClear(); f.atStart.length = 0;
    f.setState("stopped");
    await pool.query("UPDATE cloud_workspaces SET desired_state='stopped',status='stopped' WHERE id=$1", [f.fixture.workspaceId]);
    await f.wake(); await f.run();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.atStart).toEqual([{ state: "retired", binding_retired: true }]);
  });
});
