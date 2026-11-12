import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_EXECUTION_ACTIVATION_LIMIT, manageCloudExecution, type CloudExecutionChange } from "../../manage-cloud-execution.js";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const url = process.env.TEST_DATABASE_URL, database = url ? describe : describe.skip;
database("owner-only execution activation plans", () => {
  let pool: pg.Pool, f: ExecutionFixture, input: CloudExecutionChange;
  const options = () => ({ databaseUrl: url!, channel: "development" });
  const run = async (action: CloudExecutionChange["action"], change = input) => {
    const request = { ...change, action }, plan = await manageCloudExecution(pool, request, options());
    return manageCloudExecution(pool, request, { ...options(), execute: true, approval: plan.planSha256 });
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 6, statement_timeout: 5000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool);
    await f.hello();
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.admin.id]);
    input = { activationId: randomUUID(), action: "prepare", channel: "development", organizationId: f.organizationId,
      workspaceId: f.workspace.id, initiatorUserId: f.viewer.id, operatorUserId: f.admin.id,
      runtimeSha256: "b".repeat(64), reason: "Local fixture qualification of shared execution" };
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const row = async () => (await pool.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];

  it("plans without writing and leaves a prepared workspace fully usable by N-1", async () => {
    const before = await row(), plan = await manageCloudExecution(pool, input, options());
    expect(plan.state).toBe("planned");
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_activations")).rowCount).toBe(0);
    expect((await row()).execution_mode).toBe("legacy");
    await manageCloudExecution(pool, input, { ...options(), execute: true, approval: plan.planSha256 });
    const prepared = await row();
    expect(prepared).toMatchObject({ state: before.state, execution_mode: "prepared", execution_transition_id: null,
      worker_boot_id: before.worker_boot_id, access_epoch: before.access_epoch, stop_generation: before.stop_generation });
    expect(prepared.worker_token_hash.equals(before.worker_token_hash)).toBe(true);
    const client = await pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await client.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows).toEqual([{ id: f.workspace.id }]);
      expect((await client.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp() WHERE id=$1 RETURNING id", [f.workspace.id])).rowCount).toBe(1);
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await f.send()).status).toBe(201);
    expect((await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: "b".repeat(64) })).status).toBe(200);
  });

  it("sets the protocol guard only at activate and cancels old queued and running authority once", async () => {
    await f.send();
    await run("prepare");
    const prepared = await row();
    const request = { ...input, action: "activate" as const }, plan = await manageCloudExecution(pool, request, options());
    expect((await row()).execution_transition_id).toBeNull();
    await manageCloudExecution(pool, request, { ...options(), execute: true, approval: plan.planSha256 });
    const activating = await row();
    expect(activating).toMatchObject({ state: "stopping", execution_mode: "prepared", execution_transition_id: input.activationId });
    expect(BigInt(activating.access_epoch)).toBe(BigInt(prepared.access_epoch) + 1n);
    expect(BigInt(activating.stop_generation)).toBe(BigInt(prepared.stop_generation) + 1n);
    expect((await pool.query("SELECT state,cancel_requested,wake_after_stop FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rows)
      .toEqual([{ state: "cancelled", cancel_requested: true, wake_after_stop: false }]);
    expect((await manageCloudExecution(pool, request, { ...options(), execute: true, approval: plan.planSha256 })).state).toBe("replayed");
    expect((await row()).stop_generation).toBe(activating.stop_generation);
    expect((await f.send()).status).toBe(409);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/start`, "POST")).status).toBe(409);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST")).status).toBe(409);
  });

  it("binds exact target, identity, runtime, source and approval rather than accepting a stale plan", async () => {
    const plan = await manageCloudExecution(pool, input, options());
    await expect(manageCloudExecution(pool, input, { ...options(), execute: true, approval: "0".repeat(64) })).rejects.toThrow(/plan/i);
    const target = new URL(url!); target.hostname = "another-database.example.test";
    await expect(manageCloudExecution(pool, input, { ...options(), databaseUrl: target.toString(), execute: true, approval: plan.planSha256 })).rejects.toThrow(/plan/i);
    await expect(manageCloudExecution(pool, input, { ...options(), channel: "production" })).rejects.toThrow(/channel/i);
    await pool.query("UPDATE cloud_v2_workspaces SET base_branch='changed' WHERE id=$1", [f.workspace.id]);
    await expect(manageCloudExecution(pool, input, { ...options(), execute: true, approval: plan.planSha256 })).rejects.toThrow(/plan/i);
    await run("prepare");
    await expect(run("activate", { ...input, runtimeSha256: "c".repeat(64) })).rejects.toThrow(/activation|plan/i);
    await pool.query("UPDATE organization_members SET authorization_revision=authorization_revision+1 WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    await expect(run("activate")).rejects.toThrow(/plan/i);
    expect((await row()).execution_transition_id).toBeNull();
  });

  it("can replace an obsolete prepared plan without draining or losing its replay receipt", async () => {
    await run("prepare");
    const original = { ...input }, before = await row();
    await pool.query("UPDATE cloud_v2_workspaces SET base_branch='next-base' WHERE id=$1", [f.workspace.id]);
    await expect(run("activate")).rejects.toThrow(/plan/i);
    input = { ...input, activationId: randomUUID() };
    await run("prepare");
    expect(await row()).toMatchObject({ state: before.state, execution_mode: "prepared", execution_transition_id: null,
      access_epoch: before.access_epoch, stop_generation: before.stop_generation });
    expect((await pool.query("SELECT phase FROM cloud_v2_execution_activations WHERE id=$1", [original.activationId])).rows[0].phase).toBe("superseded");
    expect((await run("prepare", original)).state).toBe("replayed");
    await expect(run("activate", original)).rejects.toThrow(/plan/i);
    await run("activate");
    expect((await row()).execution_transition_id).toBe(input.activationId);
  });

  it("requires the migration role and active platform owner; HTTP and worker tokens have no activation entry", async () => {
    const runtime = new pg.Pool({ connectionString: url, max: 1, options: "-c role=zeros_app" });
    try { await expect(manageCloudExecution(runtime, input, options())).rejects.toThrow(/migration owner/i); }
    finally { await runtime.end(); }
    await expect(run("prepare", { ...input, operatorUserId: f.creator.id })).rejects.toThrow(/platform owner/i);
    await expect(withSystemTx(pool, tx => tx.query("INSERT INTO cloud_v2_execution_activations DEFAULT VALUES"))).rejects.toMatchObject({ code: "42501" });
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_execution_activations SET runtime_sha256=$1", ["c".repeat(64)]))).rejects.toMatchObject({ code: "42501" });
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/execution/activate`, "POST", input)).status).toBe(404);
    expect((await f.worker("execution/activate", input)).status).toBe(404);
  });

  it("refuses a prepared replacement approved before another plan took its place", async () => {
    await run("prepare");
    const replacing = { ...input, activationId: randomUUID() }, plan = await manageCloudExecution(pool, replacing, options());
    const concurrent = { ...input, activationId: randomUUID() };
    await run("prepare", concurrent);
    await expect(manageCloudExecution(pool, replacing, { ...options(), execute: true, approval: plan.planSha256 })).rejects.toThrow(/plan/i);
    expect((await pool.query("SELECT id FROM cloud_v2_execution_activations WHERE workspace_id=$1 AND phase='prepared'", [f.workspace.id])).rows)
      .toEqual([{ id: concurrent.activationId }]);
    expect((await row()).execution_transition_id).toBeNull();
  });

  it("bounds retained plans and receipts without losing replay at the limit", async () => {
    await run("prepare");
    await pool.query(`INSERT INTO cloud_v2_execution_activations(id,workspace_id,org_id,initiator_user_id,operator_user_id,
      runtime_sha256,target_fingerprint,request_hash,reason_hash,prepared_snapshot,phase,completed_at)
      SELECT gen_random_uuid(),workspace_id,org_id,initiator_user_id,operator_user_id,runtime_sha256,target_fingerprint,
        request_hash,reason_hash,prepared_snapshot,'superseded',clock_timestamp()
      FROM cloud_v2_execution_activations CROSS JOIN generate_series(1,$2) WHERE id=$1`, [input.activationId,CLOUD_EXECUTION_ACTIVATION_LIMIT - 2]);
    input = { ...input, activationId: randomUUID() };
    await run("prepare");
    const before = await row();
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_activations WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(CLOUD_EXECUTION_ACTIVATION_LIMIT);
    expect((await run("prepare")).state).toBe("replayed");
    await expect(run("prepare", { ...input, activationId: randomUUID() })).rejects.toThrow(/limit/i);
    expect(await row()).toEqual(before);
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id]);
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_activations")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_activation_receipts")).rowCount).toBe(0);
  });

  it("stores only bounded control metadata in the prepared snapshot", async () => {
    await run("prepare");
    const snapshot = (await pool.query("SELECT prepared_snapshot FROM cloud_v2_execution_activations WHERE id=$1", [input.activationId])).rows[0].prepared_snapshot;
    expect(Object.keys(snapshot).sort()).toEqual(["accessEpoch", "bootId", "creatorUserId", "initiatorAccountRevision", "initiatorConnectionRevision",
      "initiatorMemberCreatedAt", "initiatorMemberRevision", "initiatorUserId", "organizationId", "organizationRevision", "sandboxId", "sourceRevision", "state", "stopGeneration", "targetFingerprintVersion", "workspaceId"].sort());
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-|token|secret|environment|\/home\//i);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(4096);
  });
});
