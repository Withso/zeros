import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import type { Config } from "../config.js";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { builderFixture, BUILDER_SANDBOX } from "./cloud-builder-vm-test-fixtures.js";
import { DatabaseBuilderVmOperationStore, type BuilderVmIntent } from "./cloud-builder-vm-store.js";
import { builderVmSourceResolver } from "./cloud-builder-vm.js";
import { RUNTIME_SMOKE_CHECKS } from "./cloud-builder-commands.js";
import { RuntimeQualificationWorker, RUNTIME_QUALIFICATION_KINDS } from "./runtime-qualification.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { createRuntimeStaffRoutes, RUNTIME_STAFF_PATH, readRuntimeStatus } from "./runtime-publication-routes.js";
import { seedRuntimeBase, seedRuntimeBundle, runtimeBase } from "./runtime-test-fixtures.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("runtime smoke qualification with PostgreSQL, fake Boat and pinned SSH", () => {
  let pool: pg.Pool;
  let operations: DatabaseBuilderVmOperationStore;
  let boat: ReturnType<typeof builderFixture>;
  let artifacts: RuntimeArtifactStore;
  let worker: RuntimeQualificationWorker;
  let runtimeId: string;
  const makeWorker = (enabled = true) => new RuntimeQualificationWorker({ pool, enabled, vms: boat.vms, operations, artifacts });
  const qualifications = () => withSystemTx(pool, async tx => (await tx.query(`SELECT * FROM cloud_runtime_qualifications ORDER BY credential_kind`)).rows);
  const runs = () => withSystemTx(pool, async tx => (await tx.query(`SELECT * FROM cloud_runtime_qualification_runs ORDER BY created_at,id`)).rows);
  const runIntent = (id: string): BuilderVmIntent => ({ purpose: "runtime-qualification", source: { kind: "base", baseImageId: runtimeBase.id },
    name: `zeros-v2-qual-${runtimeId.slice(3, 15)}`, operationKey: `runtime-qualification.${id}`, ttlSeconds: 1800 });
  async function expire(id: string) {
    await withSystemTx(pool, async tx => {
      await tx.query(`UPDATE cloud_runtime_qualification_runs SET state='running',base_image_id=$2,base_compatibility_id=$3,
        started_at=clock_timestamp()-interval '1 hour',deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [id, runtimeBase.id, runtimeBase.compatibilityId]);
    });
  }
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    operations = new DatabaseBuilderVmOperationStore(pool, "zeros-v2-test-account");
    boat = builderFixture(operations);
    artifacts = { head: vi.fn(), presignCreatePut: vi.fn(), presignGet: vi.fn(async () => ({
      url: "https://objects.example.test/private-artifact-value", expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })) };
    runtimeId = await withSystemTx(pool, async tx => { await seedRuntimeBase(tx); return (await seedRuntimeBundle(tx, { kinds: [] })).descriptor.runtimeId; });
    worker = makeWorker();
  });

  it("inserts exactly five smoke rows only after verified VM deletion, with no unproved MCP/native claims", async () => {
    const scheduled = await worker.enqueue(runtimeId);
    expect(scheduled.status).toBe("queued");
    expect(await qualifications()).toHaveLength(0);
    const realDelete = boat.vms.delete.bind(boat.vms);
    vi.spyOn(boat.vms, "delete").mockImplementation(async value => { expect(await qualifications()).toHaveLength(0); await realDelete(value); });
    await worker.tick();
    const rows = await qualifications();
    expect(rows.map(row => row.credential_kind).sort()).toEqual([...RUNTIME_QUALIFICATION_KINDS].sort());
    for (const row of rows) expect(row).toMatchObject({ runtime_id: runtimeId, base_compatibility_id: runtimeBase.compatibilityId,
      profile: "zeros-cloud-worker-v4", enabled: true, mcp_qualified: false, native_capabilities: {},
      evidence: { mode: "smoke", baseImageId: runtimeBase.id, runId: scheduled.runId,
        checks: ["base_status", "install_runtime", ...RUNTIME_SMOKE_CHECKS] } });
    expect(Date.parse(rows[0].evidence.ranAt)).toBeGreaterThan(0);
    expect(artifacts.presignGet).toHaveBeenCalledWith(expect.stringContaining(`runtime/v1/${runtimeId}/`), 900);
    expect(boat.state.deleted).toBe(true);
    expect((await runs())[0]).toMatchObject({ id: scheduled.runId, state: "succeeded", sandbox_id: BUILDER_SANDBOX,
      cleanup_confirmed_at: expect.any(Date), diagnostic: { ok: true, stage: "self_test" } });
    expect(await worker.enqueue(runtimeId)).toEqual({ status: "qualified", runId: null });
    await worker.tick();
    expect(boat.state.creates).toBe(1);
  });

  it.each(["self_test", "base_status", "install_runtime", "allocation", "artifact"])("fails closed and cleans the VM on %s failure", async phase => {
    if (phase === "self_test") boat.state.failChecks = ["sqlite_query"];
    if (phase === "base_status") boat.state.baseCompatibilityId = `bc1-${"e".repeat(64)}`;
    if (phase === "install_runtime") boat.state.sshOutput = "not a diagnostic; private-artifact-value";
    if (phase === "allocation") boat.state.wallet = "wrong-wallet";
    if (phase === "artifact") vi.mocked(artifacts.presignGet).mockRejectedValue(new Error("private-artifact-value"));
    const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await worker.enqueue(runtimeId); await worker.tick();
      expect(await qualifications()).toHaveLength(0);
      expect(boat.state.deleted).toBe(true);
      const [run] = await runs();
      expect(run.state).toBe("failed");
      expect(run.diagnostic.schema).toBe("zeros.diagnostic/v1");
      expect(run.diagnostic.ok).toBe(false);
      if (phase === "self_test") expect(run.diagnostic.failedChecks).toEqual(["sqlite_query"]);
      expect(JSON.stringify(run)).not.toContain("private-artifact-value");
      expect(JSON.stringify(logs.mock.calls)).not.toContain("private-artifact-value");
    } finally { logs.mockRestore(); }
  });

  it("holds the single running slot until deletion is confirmed and never approves a cleanup failure", async () => {
    boat.state.deletionStatus = "pending";
    await worker.enqueue(runtimeId); await worker.tick();
    expect(await qualifications()).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ state: "running", diagnostic: { stage: "cleanup", failedChecks: ["cleanup_unconfirmed"] } });
    boat.state.deletionStatus = "completed";
    await makeWorker().tick();
    expect((await runs())[0]).toMatchObject({ state: "failed", cleanup_confirmed_at: expect.any(Date), diagnostic: { timedOut: true } });
    expect(await qualifications()).toHaveLength(0);
  });

  it("closes a certified create refusal and releases the global slot without replaying it", async () => {
    boat.state.createRefused = true;
    const { runId } = await worker.enqueue(runtimeId);
    const second = await withSystemTx(pool, async tx => (await seedRuntimeBundle(tx, { digit: "d", releaseOrder: 2, kinds: [] })).descriptor.runtimeId);
    await worker.enqueue(second);
    await worker.tick();
    expect((await runs())[0]).toMatchObject({ state: "failed", sandbox_id: null,
      cleanup_confirmed_at: expect.any(Date), diagnostic: { stage: "allocate", ok: false } });
    expect(boat.state.creates).toBe(1);
    expect(boat.state.allocations.size).toBe(0);
    expect(boat.state.deleteRequests).toBe(0);
    expect(await qualifications()).toHaveLength(0);
    expect(await operations.find(runIntent(runId!).operationKey)).toMatchObject({ create_closed_at: expect.any(Date) });
    await expect(boat.vms.create(runIntent(runId!))).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await expect(operations.bind(runIntent(runId!).operationKey, BUILDER_SANDBOX)).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await expect(withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_builder_vm_create_attempts
      (account_scope,operation_key,attempt_id) VALUES ('zeros-v2-test-account',$1,$2)`,
    [runIntent(runId!).operationKey, randomUUID()]))).rejects.toMatchObject({ code: "55000" });
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_builder_vm_operations SET create_closed_at=NULL WHERE operation_key=$1`,
      [runIntent(runId!).operationKey]))).rejects.toMatchObject({ code: "55000" });
    boat.state.createRefused = false;
    await makeWorker().tick();
    expect((await runs()).map(run => run.state)).toEqual(["failed", "succeeded"]);
    expect((await qualifications()).every(row => row.runtime_id === second)).toBe(true);
    expect(await qualifications()).toHaveLength(5);
  });

  it("retains an ambiguous attempt when a later request is certified refused", async () => {
    boat.state.createRepliesLost = 1;
    boat.state.createRefused = true;
    const { runId } = await worker.enqueue(runtimeId);
    await worker.tick();
    expect(boat.state.allocations.size).toBe(1);
    expect((await runs())[0]).toMatchObject({ state: "running", sandbox_id: null, cleanup_confirmed_at: null });
    expect(await operations.find(runIntent(runId!).operationKey)).toMatchObject({ create_closed_at: null });
    const attempts = await withSystemTx(pool, async tx => (await tx.query(`SELECT rejection_code FROM cloud_builder_vm_create_attempts
      WHERE operation_key=$1 ORDER BY dispatched_at`, [runIntent(runId!).operationKey])).rows);
    expect(attempts[0]).toEqual({ rejection_code: null });
    expect(attempts.slice(1).length).toBeGreaterThan(0);
    expect(attempts.slice(1).every(row => row.rejection_code === "trial_compute_limit_reached")).toBe(true);
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_builder_vm_operations SET create_closed_at=clock_timestamp()
      WHERE operation_key=$1`, [runIntent(runId!).operationKey]))).rejects.toMatchObject({ code: "55000" });
    await expect(withSystemTx(pool, tx => tx.query(`DELETE FROM cloud_builder_vm_create_attempts WHERE operation_key=$1`,
      [runIntent(runId!).operationKey]))).rejects.toMatchObject({ code: "55000" });
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_builder_vm_create_attempts SET rejection_code='limit_reached'
      WHERE operation_key=$1 AND rejected_at IS NOT NULL`, [runIntent(runId!).operationKey]))).rejects.toMatchObject({ code: "55000" });
    boat.advance(24 * 60 * 60_000);
    const dispatched = boat.state.creates;
    await makeWorker().tick();
    expect(boat.state.creates).toBe(dispatched);
    expect((await runs())[0]).toMatchObject({ state: "running", cleanup_confirmed_at: null });
    expect(await qualifications()).toHaveLength(0);
  });

  it("fences a suspended create after another replica closes an expired run", async () => {
    const { runId } = await worker.enqueue(runtimeId);
    const second = await withSystemTx(pool, async tx => (await seedRuntimeBundle(tx, { digit: "d", releaseOrder: 2, kinds: [] })).descriptor.runtimeId);
    await worker.enqueue(second);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const realCreate = boat.vms.create.bind(boat.vms);
    vi.spyOn(boat.vms, "create").mockImplementationOnce(async input => { entered(); await barrier; return realCreate(input); });
    const running = worker.tick();
    await reached;
    try {
      expect(await operations.find(runIntent(runId!).operationKey)).toMatchObject({
        create_dispatched_at: null, create_closed_at: null, sandbox_id: null });
      await expire(runId!);
      await makeWorker().tick();
      expect((await runs())[0]).toMatchObject({ state: "failed", sandbox_id: null, cleanup_confirmed_at: expect.any(Date) });
    } finally { release(); await running; }
    expect(boat.state.allocations.size).toBe(0);
    expect(boat.state.creates).toBe(0);
    expect(await operations.find(runIntent(runId!).operationKey)).toMatchObject({ sandbox_id: null, create_closed_at: expect.any(Date) });
    expect((await runs())[0]).toMatchObject({ state: "failed", sandbox_id: null, cleanup_confirmed_at: expect.any(Date) });
    expect(await qualifications()).toHaveLength(0);
    await makeWorker().tick();
    expect((await runs()).map(run => run.state)).toEqual(["failed", "succeeded"]);
    expect((await qualifications()).every(row => row.runtime_id === second)).toBe(true);
    expect(await qualifications()).toHaveLength(5);
  });

  it("deletes a bound VM even when saving its identity to a running run is no longer possible", async () => {
    const { runId } = await worker.enqueue(runtimeId);
    const realCreate = boat.vms.create.bind(boat.vms);
    vi.spyOn(boat.vms, "create").mockImplementationOnce(async input => {
      const builder = await realCreate(input);
      await withSystemTx(pool, tx => tx.query(`UPDATE cloud_runtime_qualification_runs
        SET state='failed',finished_at=clock_timestamp() WHERE id=$1`, [runId]));
      return builder;
    });
    await worker.tick();
    expect(boat.state.deleted).toBe(true);
    expect(boat.state.deleteRequests).toBe(1);
    expect(await operations.find(runIntent(runId!).operationKey)).toMatchObject({ state: "deleted", sandbox_id: BUILDER_SANDBOX });
    expect((await runs())[0]).toMatchObject({ state: "failed", sandbox_id: BUILDER_SANDBOX, cleanup_confirmed_at: expect.any(Date) });
    expect(await qualifications()).toHaveLength(0);
  });

  it("keeps an in-flight create uncertain until replay binds and deletes it, including its late response", async () => {
    const { runId } = await worker.enqueue(runtimeId);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const realFetch = boat.fetcher.getMockImplementation()!;
    boat.fetcher.mockImplementationOnce(async (...args) => {
      const response = await realFetch(...args); entered(); await barrier; return response;
    });
    const running = worker.tick();
    await reached;
    try {
      expect(await operations.closeUnallocatedCreate(runIntent(runId!).operationKey)).toBe(false);
      await expire(runId!); await makeWorker().tick();
      expect((await runs())[0]).toMatchObject({ state: "failed", sandbox_id: BUILDER_SANDBOX, cleanup_confirmed_at: expect.any(Date) });
    } finally { release(); await running; }
    expect(boat.state.allocations.size).toBe(1);
    expect(boat.state.creates).toBe(2);
    expect(boat.state.deleteRequests).toBe(1);
    await expect(boat.client.request(`/sandboxes/${BUILDER_SANDBOX}`)).rejects.toMatchObject({ code: "provider_not_found" });
    expect(await operations.find(runIntent(runId!).operationKey)).toMatchObject({ state: "deleted", sandbox_id: BUILDER_SANDBOX, create_closed_at: null });
    expect(await qualifications()).toHaveLength(0);
  });

  it.each([true, false])("reconciles a crashed run from the durable provider journal (run recorded sandbox: %s)", async recorded => {
    const { runId } = await worker.enqueue(runtimeId);
    const builder = await boat.vms.create(runIntent(runId!));
    await expire(runId!);
    if (recorded) await withSystemTx(pool, tx => tx.query("UPDATE cloud_runtime_qualification_runs SET sandbox_id=$2 WHERE id=$1", [runId, builder.sandboxId]));
    await makeWorker().tick();
    expect(boat.state.deleted).toBe(true);
    expect(boat.channel.execute).not.toHaveBeenCalled();
    expect(await qualifications()).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ state: "failed", sandbox_id: builder.sandboxId,
      cleanup_confirmed_at: expect.any(Date), diagnostic: { stage: "reconcile", failedChecks: ["timeout"] } });
  });

  it("recovers an ambiguous create after a crash using the same provider key and deletes its allocation", async () => {
    const { runId } = await worker.enqueue(runtimeId);
    boat.state.createRepliesLost = 10;
    await expect(boat.vms.create(runIntent(runId!))).rejects.toMatchObject({ check: "timeout" });
    await expire(runId!);
    boat.state.createRepliesLost = 0;
    await makeWorker().tick();
    expect(boat.state.allocations.size).toBe(1);
    expect(boat.state.deleted).toBe(true);
    expect((await runs())[0].state).toBe("failed");
    expect(await qualifications()).toHaveLength(0);
  });

  it("does nothing when disabled, including publication enqueue and timer startup", async () => {
    const disabled = makeWorker(false);
    expect(await disabled.enqueue(runtimeId)).toEqual({ status: "disabled", runId: null });
    await disabled.tick(); await disabled.start()();
    expect(await runs()).toHaveLength(0);
    expect(boat.fetcher).not.toHaveBeenCalled();
  });

  it("deduplicates publication/staff/tick triggers across worker instances", async () => {
    const other = makeWorker();
    const scheduled = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? other : worker).enqueue(runtimeId, { force: i % 2 === 0 })));
    expect(new Set(scheduled.map(result => result.runId)).size).toBe(1);
    await Promise.all([worker.tick(), worker.tick(), other.tick()]);
    expect(await runs()).toHaveLength(1);
    expect(boat.state.creates).toBe(1);
    expect(await qualifications()).toHaveLength(5);
  });

  it("enforces a global running slot across different runtime triggers", async () => {
    const second = await withSystemTx(pool, async tx => (await seedRuntimeBundle(tx, { digit: "d", releaseOrder: 2, kinds: [] })).descriptor.runtimeId);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const realExecute = boat.channel.execute.getMockImplementation()!;
    boat.channel.execute.mockImplementationOnce(async input => { entered(); await barrier; return realExecute(input); });
    await worker.enqueue(runtimeId);
    const running = worker.tick();
    await reached;
    try {
      await makeWorker().enqueue(second);
      await makeWorker().tick();
      const records = await runs();
      expect(records.filter(run => run.state === "running")).toHaveLength(1);
      expect(records.filter(run => run.state === "queued")).toHaveLength(1);
      expect(boat.state.creates).toBe(1);
    } finally { release(); await running; }
  });

  it("background selection chooses the newest confirmed unqualified runtime and current approved base", async () => {
    const chosen = await withSystemTx(pool, async tx => {
      await seedRuntimeBundle(tx, { digit: "b", releaseOrder: 3, confirmed: false, kinds: [] });
      return (await seedRuntimeBundle(tx, { digit: "c", releaseOrder: 2, kinds: [] })).descriptor.runtimeId;
    });
    await worker.tick();
    expect((await runs())[0].runtime_id).toBe(chosen);
    expect((await qualifications()).every(row => row.runtime_id === chosen)).toBe(true);
    expect(await builderVmSourceResolver(pool)({ kind: "base", baseImageId: runtimeBase.id })).toBe("zeros-v2-test-base");
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_runtime_base_images SET revoked_at=now() WHERE base_image_id=$1", [runtimeBase.id]));
    await expect(builderVmSourceResolver(pool)({ kind: "base", baseImageId: runtimeBase.id })).rejects.toMatchObject({ check: "source_unavailable" });
  });

  it("revalidates revocation after a successful test and cleanup", async () => {
    const realDelete = boat.vms.delete.bind(boat.vms);
    vi.spyOn(boat.vms, "delete").mockImplementation(async vm => {
      await realDelete(vm);
      await withSystemTx(pool, tx => tx.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [runtimeId]));
    });
    await worker.tick();
    expect(boat.state.deleted).toBe(true);
    expect(await qualifications()).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ state: "failed", diagnostic: { failedChecks: ["runtime_ineligible"] } });
  });

  it("keeps failures dormant until an explicit staff retry and never overwrites immutable evidence", async () => {
    boat.state.failChecks = ["pty_load"];
    await worker.tick(); await worker.tick();
    expect(await runs()).toHaveLength(1);
    boat = builderFixture(operations); boat.state.sandboxId = "bx_bcdefghj"; worker = makeWorker();
    await worker.enqueue(runtimeId, { force: true }); await worker.tick();
    expect(await qualifications()).toHaveLength(5);
    const original = (await qualifications())[0].evidence;
    expect(await worker.enqueue(runtimeId)).toEqual({ status: "qualified", runId: null });
    boat = builderFixture(operations); boat.state.sandboxId = "bx_cdefghjk"; worker = makeWorker();
    await worker.enqueue(runtimeId, { force: true }); await worker.tick();
    expect((await runs()).map(run => run.state)).toEqual(["failed", "succeeded", "succeeded"]);
    expect(await qualifications()).toHaveLength(5);
    expect((await qualifications())[0].evidence).toEqual(original);
  });

  it("exposes staff-only retries and bounded closed run status", async () => {
    let staffRole: string | null = "developer";
    const app = new Hono();
    app.use("*", async (c, next) => { if (staffRole) c.set("user", { id: randomUUID(), staffRole } as never); await next(); });
    app.onError((error, c) => c.json({ code: error instanceof HttpError ? error.code : "failed" }, (error instanceof HttpError ? error.status : 500) as 400));
    const retry = vi.fn((id: string) => worker.enqueue(id, { force: true }));
    app.route("/", createRuntimeStaffRoutes({ deploymentChannel: "alpha" } as Config, pool, retry));
    const path = `${RUNTIME_STAFF_PATH}/runtimes/${runtimeId}/requalify`;
    expect((await app.request(path, { method: "POST" })).status).toBe(202);
    staffRole = "support";
    expect((await app.request(path, { method: "POST" })).status).toBe(404);
    staffRole = null;
    expect((await app.request(path, { method: "POST" })).status).toBe(401);
    expect(retry).toHaveBeenCalledOnce();
    await worker.tick();
    const status = await readRuntimeStatus(pool, "alpha");
    expect(status.qualificationRuns[0]).toMatchObject({ state: "succeeded", sandboxId: BUILDER_SANDBOX,
      cleanupConfirmedAt: expect.any(Date), diagnostic: { ok: true } });
    expect(JSON.stringify(status)).not.toContain("private-artifact-value");
  });

  it("forces system-only RLS for the journals and preserves provider identity/retirement", async () => {
    await worker.tick();
    await withUserTx(pool, randomUUID(), async tx => {
      expect((await tx.query("SELECT * FROM cloud_runtime_qualification_runs")).rows).toEqual([]);
      expect((await tx.query("SELECT * FROM cloud_builder_vm_operations")).rows).toEqual([]);
      expect((await tx.query("SELECT * FROM cloud_builder_vm_create_attempts")).rows).toEqual([]);
    });
    await expect(withUserTx(pool, randomUUID(), tx => tx.query("INSERT INTO cloud_runtime_qualification_runs (runtime_id) VALUES ($1)", [runtimeId]))).rejects.toMatchObject({ code: "42501" });
    const key = `runtime-qualification.${(await runs())[0].id}`;
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_builder_vm_operations SET state='ready' WHERE operation_key=$1", [key]))).rejects.toMatchObject({ code: "55000" });
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_builder_vm_operations SET sandbox_id='bx_bcdefghj' WHERE operation_key=$1", [key]))).rejects.toMatchObject({ code: "55000" });
  });
});
