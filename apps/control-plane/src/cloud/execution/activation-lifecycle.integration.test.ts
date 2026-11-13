import { generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { manageCloudExecution, type CloudExecutionChange } from "../../manage-cloud-execution.js";
import { withSystemTx } from "../../db.js";
import { configureCloudTeamOwnership } from "../../db-context.js";
import { HttpError } from "../../authz.js";
import type { CloudV2Compute } from "../boat.js";
import { CloudProviderError } from "../provider-error.js";
import { CloudV2Lifecycle } from "../lifecycle.js";
import { CloudExecutionActivations } from "./activation.js";
import { CloudExecutionAuthority } from "./authority.js";
import { CloudExecutionContexts } from "./store.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const url = process.env.TEST_DATABASE_URL, database = url ? describe : describe.skip;
database("durable activation through provider Stop and real worker routes", () => {
  let pool: pg.Pool, f: ExecutionFixture, input: CloudExecutionChange, compute: CloudV2Compute, lifecycle: CloudV2Lifecycle;
  const options = () => ({ databaseUrl: url!, channel: "development" });
  const run = async (action: CloudExecutionChange["action"]) => {
    const request = { ...input, action }, plan = await manageCloudExecution(pool, request, options());
    return manageCloudExecution(pool, request, { ...options(), execute: true, approval: plan.planSha256 });
  };
  const row = async () => (await pool.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
  const activation = async () => (await pool.query("SELECT * FROM cloud_v2_execution_activations WHERE id=$1", [input.activationId])).rows[0];
  const advance = () => new CloudExecutionActivations(pool, f.cp.execution).step(input.activationId);
  const boot = async (features = f.features, bootId = randomUUID(), runtimeSha256 = input.runtimeSha256) => {
    const token = await f.cp.store.rotateWorkerToken(f.workspace.id);
    const response = await f.worker("hello", { protocol: 2, bootId, runtimeSha256 }, { token, boot: bootId, features });
    const call = (path: string, body: unknown) => f.worker(path, body, { token, boot: bootId, features });
    return { token, bootId, response, call };
  };
  const stoppedRecovery = async (phase: "failed" | "cancelled", stale = false) => {
    if (phase === "failed") {
      await lifecycle.tick(); await advance();
      const started = await boot(); expect(started.response.status).toBe(200);
      expect((await started.call("execution-leases/boot-clean", {
        retirementId: randomUUID(), processes: 0, legacyMaterial: "refused",
      })).status).toBe(409);
    } else expect([200,202]).toContain((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status);
    await lifecycle.tick();
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null });
    expect((await activation()).phase).toBe(phase);
    // Rows written by an older replica can retain the prior Stop's proof.
    if (stale) await pool.query("UPDATE cloud_v2_execution_activations SET confirmed_stop_generation=confirmed_stop_generation-1 WHERE id=$1", [input.activationId]);
    return activation();
  };
  const copyActivation = async (phase: "prepared" | "failed" | "rolled_back" | "superseded") => {
    const id = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_execution_activations(id,workspace_id,org_id,initiator_user_id,operator_user_id,
      runtime_sha256,target_fingerprint,request_hash,reason_hash,prepared_snapshot,phase,started_at,deadline_at,
      confirmed_stop_generation,confirmed_stopped_at)
      SELECT $2,workspace_id,org_id,initiator_user_id,operator_user_id,runtime_sha256,target_fingerprint,
        request_hash,reason_hash,prepared_snapshot,$3,started_at,deadline_at,confirmed_stop_generation,confirmed_stopped_at
      FROM cloud_v2_execution_activations WHERE id=$1`, [input.activationId, id, phase]);
    return (await pool.query("SELECT * FROM cloud_v2_execution_activations WHERE id=$1", [id])).rows[0];
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 8, statement_timeout: 6000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool); await f.hello(); await f.cp.loginChanges.stop();
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.admin.id]);
    input = { activationId: randomUUID(), action: "prepare", channel: "development", organizationId: f.organizationId,
      workspaceId: f.workspace.id, initiatorUserId: f.viewer.id, operatorUserId: f.admin.id,
      runtimeSha256: "c".repeat(64), reason: "Local fixture qualification of the clean boot gate" };
    compute = { stop: vi.fn(async () => {}), delete: vi.fn(async () => {}), extendLease: vi.fn(async () => {}) } as unknown as CloudV2Compute;
    lifecycle = new CloudV2Lifecycle({ store: f.cp.store, compute,
      runtime: { sha256: input.runtimeSha256, url: async () => "https://example.test/runtime" },
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString()],
      sealPortToken: () => null, stopWorker: async () => true, bootEnv: () => ({}), sandboxName: () => "fixture" });
    await run("prepare"); await run("activate");
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("holds the old protocol fence until provider Stop, then requires a fresh capable clean boot", async () => {
    let release!: () => void;
    vi.mocked(compute.stop).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const stopping = lifecycle.tick();
    await expect.poll(() => compute.stop).toHaveBeenCalled();
    expect(await row()).toMatchObject({ state: "stopping", execution_transition_id: input.activationId });
    expect(await activation()).toMatchObject({ phase: "draining", drained_at: null });
    await advance(); expect((await activation()).phase).toBe("draining");
    expect((await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: input.runtimeSha256 })).status).toBe(401);
    release(); await stopping;
    expect(await activation()).toMatchObject({ phase: "authorizing", confirmed_stop_generation: (await row()).stop_generation, drained_at: expect.any(Date) });
    expect((await row()).worker_token_hash).toBeNull();
    await advance();
    expect(await row()).toMatchObject({ state: "starting", execution_mode: "active", execution_transition_id: input.activationId, execution_initiator_user_id: f.viewer.id });
    const started = await boot(); expect(started.response.status).toBe(200);
    const { config } = await started.response.json();
    expect(config).toMatchObject({ actingUser: 1, agents: {}, gitIdentity: null });
    for (const name of ["environment","mcpServers","api","codeReview"]) expect(config).not.toHaveProperty(name);
    expect((await row()).state).toBe("starting");
    expect((await started.call("bootstrap-lease", { contextId: config.bootstrapContextId })).status).toBe(409);
    const receipt = { retirementId: randomUUID(), processes: 0, legacyMaterial: "removed" };
    expect(await (await started.call("execution-leases/boot-clean", receipt)).json()).toEqual({ retired: 0 });
    expect(await row()).toMatchObject({ state: "running", execution_mode: "active", execution_transition_id: null });
    expect(await activation()).toMatchObject({ phase: "active", legacy_material: "removed", boot_id: started.bootId, completed_at: expect.any(Date) });
    const lease = await started.call("bootstrap-lease", { contextId: config.bootstrapContextId });
    expect(lease.status).toBe(200); expect((await lease.json()).userId).toBe(f.viewer.id);
    expect(await (await started.call("execution-leases/boot-clean", receipt)).json()).toEqual({ retired: 0 });
    await advance(); expect((await row()).state).toBe("running");
  });

  it.each(["stop", "archive", "delete"])("lets %s win during the drain and never restarts", async action => {
    let release!: () => void;
    vi.mocked(compute.stop).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const stopping = lifecycle.tick(); await expect.poll(() => compute.stop).toHaveBeenCalled();
    const response = action === "delete" ? await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}`, "DELETE") :
      await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/${action}`, "POST");
    expect([200,202]).toContain(response.status);
    expect(await row()).toMatchObject({ execution_transition_id: input.activationId });
    expect((await activation()).phase).toBe("cancelled");
    release(); await stopping; await advance();
    expect((await row()).state).toBe(action === "delete" ? "deleting" : "stopped");
    if (action !== "delete") expect(await row()).toMatchObject({ execution_mode: "prepared", execution_transition_id: null });
    expect(compute.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels while source admission is held and never commits a later wake", async () => {
    await lifecycle.tick();
    const original = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementation(async (...args) => {
      const proof = await original(...args); entered(); await barrier; return proof;
    });
    const pending = advance(); await held;
    try {
      expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(200);
      expect(await row()).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null });
    } finally { release(); await pending; }
    expect((await row()).state).toBe("stopped");
    expect((await activation()).phase).toBe("cancelled");
  });

  it("defers unknown source authority across process restart but fails a denied initiator", async () => {
    await lifecycle.tick();
    f.unavailable.add(f.viewer.id); await advance();
    expect(await row()).toMatchObject({ state: "stopped", execution_transition_id: input.activationId });
    expect((await activation()).phase).toBe("authorizing");
    f.unavailable.clear(); f.denied.add(`${f.viewer.id}:42`);
    await pool.query("UPDATE cloud_github_source_verifications SET retry_at=clock_timestamp()-interval '1 second' WHERE owner_user_id=$1", [f.viewer.id]);
    const fresh = new CloudExecutionContexts(pool, { ...f.cp.execution.deps,
      authority: new CloudExecutionAuthority(pool, f.github.source, f.github.connections.store) });
    await new CloudExecutionActivations(pool, fresh).step(input.activationId);
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null });
    expect(await activation()).toMatchObject({ phase: "failed", first_error_code: "member_access_revoked" });
  });

  it("does not let a cancelled activation's late denial fail its replacement", async () => {
    await lifecycle.tick();
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementationOnce(async () => {
      entered(); await barrier; throw new HttpError(403, "member_access_revoked", "Fixture delayed refusal");
    });
    const pending = advance(); await held;
    try {
      expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(200);
      await run("rollback");
      input = { ...input, activationId: randomUUID() };
      await run("prepare"); await run("activate");
    } finally { release(); await pending; }
    expect(await activation()).toMatchObject({ phase: "draining", first_error_code: null });
    expect(await row()).toMatchObject({ state: "stopping", execution_transition_id: input.activationId });
  });

  it.each(["leave", "suspend", "hold"])("refuses an initiator's %s while source admission is held", async change => {
    await lifecycle.tick();
    const original = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementation(async (...args) => {
      const proof = await original(...args); entered(); await barrier; return proof;
    });
    const pending = advance(); await held;
    try {
      if (change === "leave") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId,f.viewer.id]);
      else if (change === "suspend") await pool.query("UPDATE users SET auth_status='suspended',auth_revision=auth_revision+1 WHERE id=$1", [f.viewer.id]);
      else {
        for (let n = 0; n < 5; n++) {
          const user = (await pool.query("INSERT INTO users(email,display_name) VALUES($1,'Seat') RETURNING id", [`seat-${randomUUID()}@example.test`])).rows[0].id;
          await pool.query("INSERT INTO organization_members(org_id,user_id,role,created_at) VALUES($1,$2,'member',clock_timestamp()-interval '1 day')", [f.organizationId,user]);
        }
        await pool.query("UPDATE account_entitlements SET valid_until=clock_timestamp() WHERE user_id=$1", [f.viewer.id]);
        expect((await withSystemTx(pool, tx => tx.query("SELECT organization_member_on_hold($1,$2,10,5) AS held", [f.organizationId,f.viewer.id]))).rows[0].held).toBe(true);
      }
    } finally { release(); await pending; }
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null });
    expect(await activation()).toMatchObject({ phase: "failed", first_error_code: "member_access_revoked" });
  });

  it("stops a booting activation promptly when the initiator leaves before cleanup", async () => {
    await lifecycle.tick(); await advance();
    const started = await boot(); expect(started.response.status).toBe(200);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId,f.viewer.id]);
    const response = await started.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" });
    expect(response.status).toBe(403);
    await advance();
    expect(await row()).toMatchObject({ state: "stopping", execution_transition_id: input.activationId });
    expect(await activation()).toMatchObject({ phase: "failed", first_error_code: "member_access_revoked" });
    await lifecycle.tick();
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null });
  });

  it("retains a closed first failure through timeout and cleanup retries", async () => {
    await pool.query("UPDATE cloud_v2_execution_activations SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [input.activationId]);
    await advance();
    expect(await activation()).toMatchObject({ phase: "failed", first_error_code: "activation_timeout" });
    expect(await row()).toMatchObject({ state: "stopping", execution_transition_id: input.activationId });
    await lifecycle.tick(); await advance();
    expect(await row()).toMatchObject({ state: "stopped", execution_transition_id: null });
    expect((await activation()).first_error_code).toBe("activation_timeout");
  });

  it("keeps an unknown database failure retryable instead of labelling it a denial", async () => {
    await lifecycle.tick(); await advance();
    const started = await boot(); expect(started.response.status).toBe(200);
    const error = Object.assign(new Error("Fixture database disconnected"), { code: "08006" });
    vi.spyOn(f.cp.execution.deps.authority, "cached").mockRejectedValueOnce(error);
    await expect(advance()).rejects.toBe(error);
    expect(await activation()).toMatchObject({ phase: "booting", first_error_code: null });
    expect((await row()).state).toBe("starting");
  });

  it("records a failed worker checkout and shuts down before releasing the fence", async () => {
    await lifecycle.tick(); await advance();
    const started = await boot(); expect(started.response.status).toBe(200);
    expect((await started.call("checkout-failed", {})).status).toBe(200);
    await advance();
    expect(await activation()).toMatchObject({ phase: "failed", first_error_code: "activation_boot_failed" });
    expect(await row()).toMatchObject({ state: "stopping", execution_transition_id: input.activationId });
    await lifecycle.tick();
    expect(await row()).toMatchObject({ state: "stopped", execution_transition_id: null });
  });

  it.each(["missing", "lost", "pending"])("refuses an initial activation that needs a %s VM restore and retains its checkpoint", async kind => {
    await lifecycle.tick(); await advance();
    const object = `cloud-v2/checkpoints/${f.workspace.id}/${randomUUID()}.zck`;
    await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object=$2,checkpoint_key='{}',checkpoint_sha256=$3,
      checkpoint_bytes=42,checkpoint_saved_at=clock_timestamp(),checkpoint_stop_generation=stop_generation,
      boat_sandbox_id=CASE WHEN $4='missing' THEN NULL ELSE boat_sandbox_id END,
      restore_pending=($4='pending'),restore_attempt=gen_random_uuid(),
      restore_create=jsonb_build_object('from','fixture-snapshot','name','fixture','env','{}'::jsonb,'requestedAt',clock_timestamp())
      WHERE id=$1`, [f.workspace.id,object,"a".repeat(64),kind]);
    compute.resume = vi.fn(async () => { throw new CloudProviderError("provider_not_found", "Fixture lost VM", false); });
    compute.create = vi.fn(async () => ({ sandboxId: "bx_unexpected" }));
    compute.exec = vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false }));
    await advance(); await lifecycle.tick(); await advance();
    expect((await activation()).phase).toBe("failed");
    expect((await row()).checkpoint_object).toBe(object);
    expect(["stopping","stopped"]).toContain((await row()).state);
    expect(compute.create).not.toHaveBeenCalled();
    expect(compute.exec).not.toHaveBeenCalled();
    await lifecycle.tick();
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null, checkpoint_object: object });
  });

  it.each(["missing", "refused", "survivors"])("retains the first cleanup failure (%s) and waits for Stop before clearing its guard", async kind => {
    await lifecycle.tick(); await advance();
    const started = await boot(); expect(started.response.status).toBe(200);
    const receipt = { retirementId: randomUUID(), processes: kind === "survivors" ? 1 : 0, ...(kind === "missing" ? {} : { legacyMaterial: kind === "refused" ? "refused" : "none" }) };
    expect((await started.call("execution-leases/boot-clean", receipt)).status).toBe(409);
    expect(await row()).toMatchObject({ state: "stopping", execution_transition_id: input.activationId });
    expect(await activation()).toMatchObject({ phase: "failed", first_error_code: "execution_not_retired" });
    expect((await started.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" })).status).toBe(409);
    await lifecycle.tick();
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null });
    expect((await activation()).first_error_code).toBe("execution_not_retired");
  });

  it("retains closed cleanup classes on the failed activation and prints them in the operator replay", async () => {
    await lifecycle.tick(); await advance();
    const started = await boot(); expect(started.response.status).toBe(200);
    const receipt = { retirementId: randomUUID(), processes: 0, legacyMaterial: "refused", refusals: ["seed_journal_outdated"] };
    expect((await started.call("execution-leases/boot-clean", receipt)).status).toBe(409);
    expect(await activation()).toMatchObject({ phase: "failed", first_error_code: "execution_not_retired",
      legacy_material: "refused", first_failed_refusals: ["seed_journal_outdated"] });
    await lifecycle.tick();
    const inspected = await manageCloudExecution(pool, input, options());
    expect(inspected).toMatchObject({ state: "committed", bootClean: {
      refusals: ["seed_journal_outdated"], legacyMaterial: "refused", seedJournal: "outdated",
    } });
    const rollback = await manageCloudExecution(pool, { ...input, action: "rollback" }, options());
    expect(rollback).toMatchObject({ bootClean: inspected.bootClean });
  });

  it("keeps a failed activation rollbackable after a prepared runtime is stopped again", async () => {
    await lifecycle.tick(); await advance();
    const started = await boot(); expect(started.response.status).toBe(200);
    expect((await started.call("execution-leases/boot-clean", {
      retirementId: randomUUID(), processes: 0, legacyMaterial: "refused",
    })).status).toBe(409);
    await lifecycle.tick();
    const failed = await row(), original = await activation();
    expect(failed).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null });
    expect(original).toMatchObject({ phase: "failed", confirmed_stop_generation: failed.stop_generation });

    await f.login();
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/start`, "POST")).status).toBe(202);
    const resumed = await boot(f.features, randomUUID(), "b".repeat(64));
    expect(resumed.response.status, (await resumed.response.json()).error?.code).toBe(200);
    expect((await row()).state).toBe("running");
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(202);
    await expect(manageCloudExecution(pool, { ...input, action: "rollback" }, options())).rejects.toThrow(/completed provider Stop/);
    await lifecycle.tick();

    const stopped = await row(), confirmed = await activation();
    expect(stopped).toMatchObject({ state: "stopped", execution_mode: "prepared", execution_transition_id: null, worker_token_hash: null });
    expect(BigInt(stopped.stop_generation)).toBe(BigInt(failed.stop_generation) + 1n);
    expect(compute.stop).toHaveBeenCalledTimes(3);
    expect(confirmed).toMatchObject({ phase: "failed", first_error_code: original.first_error_code,
      confirmed_stop_generation: stopped.stop_generation });
    expect((await run("rollback")).state).toBe("changed");
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "legacy" });
  });

  it.each(["failed", "cancelled"] as const)("reconfirms a stopped %s activation only after the held provider Stop completes", async phase => {
    const original = await stoppedRecovery(phase, true), before = await row();
    const calls = vi.mocked(compute.stop).mock.calls.length;
    await expect(run("rollback")).rejects.toThrow(/completed provider Stop/);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(202);
    const stopping = await row();
    expect(stopping.state).toBe("stopping");
    expect(BigInt(stopping.stop_generation)).toBe(BigInt(before.stop_generation) + 1n);
    let release!: () => void;
    vi.mocked(compute.stop).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = lifecycle.tick();
    try {
      await expect.poll(() => compute.stop).toHaveBeenCalledTimes(calls + 1);
      expect(await activation()).toMatchObject({ phase, first_error_code: original.first_error_code,
        confirmed_stop_generation: original.confirmed_stop_generation, confirmed_stopped_at: original.confirmed_stopped_at });
      await expect(run("rollback")).rejects.toThrow(/completed provider Stop/);
      expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(200);
      expect((await row()).stop_generation).toBe(stopping.stop_generation);
    } finally { release?.(); await pending; }
    expect(await activation()).toMatchObject({ phase, first_error_code: original.first_error_code,
      confirmed_stop_generation: stopping.stop_generation });
    expect((await row()).state).toBe("stopped");
    expect((await run("rollback")).state).toBe("changed");
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "legacy" });
  });

  it("does not refresh a recovery proof when the provider refuses Stop", async () => {
    const original = await stoppedRecovery("failed", true), calls = vi.mocked(compute.stop).mock.calls.length;
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(202);
    const stopping = await row();
    vi.mocked(compute.stop).mockRejectedValueOnce(new CloudProviderError("provider_unavailable", "Synthetic Stop refusal", true));
    await lifecycle.tick();
    expect((await row()).state).toBe("stopping");
    expect(await activation()).toMatchObject({ first_error_code: original.first_error_code,
      confirmed_stop_generation: original.confirmed_stop_generation, confirmed_stopped_at: original.confirmed_stopped_at });
    await expect(run("rollback")).rejects.toThrow(/completed provider Stop/);
    await f.cp.store.defer(f.workspace.id, "stopping", 0, { stopGeneration: stopping.stop_generation });
    await lifecycle.tick();
    expect(compute.stop).toHaveBeenCalledTimes(calls + 2);
    expect(await activation()).toMatchObject({ first_error_code: original.first_error_code,
      confirmed_stop_generation: stopping.stop_generation });
    expect((await run("rollback")).state).toBe("changed");
  });

  it.each(["failed", "cancelled"] as const)("keeps Stop idempotent when the stopped %s activation has a current proof", async phase => {
    const original = await stoppedRecovery(phase), before = await row(), calls = vi.mocked(compute.stop).mock.calls.length;
    for (let n = 0; n < 2; n++) expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(200);
    await lifecycle.tick();
    expect(compute.stop).toHaveBeenCalledTimes(calls);
    expect(await row()).toMatchObject({ state: "stopped", stop_generation: before.stop_generation });
    expect(await activation()).toMatchObject({ confirmed_stop_generation: original.confirmed_stop_generation,
      confirmed_stopped_at: original.confirmed_stopped_at });
    expect((await run("rollback")).state).toBe("changed");
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(200);
    expect((await row()).stop_generation).toBe(before.stop_generation);
  });

  it("refreshes only the current recovery and preserves rolled-back and superseded proofs", async () => {
    const original = await stoppedRecovery("failed", true);
    const history = [await copyActivation("rolled_back"), await copyActivation("superseded")];
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(202);
    await lifecycle.tick();
    expect(await activation()).toMatchObject({ phase: "failed", first_error_code: original.first_error_code,
      confirmed_stop_generation: (await row()).stop_generation });
    for (const entry of history) {
      const saved = (await pool.query("SELECT * FROM cloud_v2_execution_activations WHERE id=$1", [entry.id])).rows[0];
      expect(saved).toEqual(entry);
    }
    expect((await run("rollback")).state).toBe("changed");
  });

  it.each(["prepared", "failed"] as const)("never selects a recovery proof when another %s activation exists", async phase => {
    const original = await stoppedRecovery("failed", true), other = await copyActivation(phase), before = await row();
    const calls = vi.mocked(compute.stop).mock.calls.length;
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(200);
    await lifecycle.tick();
    expect(compute.stop).toHaveBeenCalledTimes(calls);
    expect((await row()).stop_generation).toBe(before.stop_generation);
    await f.login();
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/start`, "POST")).status).toBe(202);
    expect((await boot(f.features, randomUUID(), "b".repeat(64))).response.status).toBe(200);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST")).status).toBe(202);
    await lifecycle.tick();
    expect(compute.stop).toHaveBeenCalledTimes(calls + 1);
    expect(await activation()).toMatchObject({ phase: "failed", confirmed_stop_generation: original.confirmed_stop_generation,
      confirmed_stopped_at: original.confirmed_stopped_at });
    expect((await pool.query("SELECT * FROM cloud_v2_execution_activations WHERE id=$1", [other.id])).rows[0]).toEqual(other);
    await expect(run("rollback")).rejects.toThrow(/completed provider Stop/);
  });

  it("rejects the old boot, an unsupported runtime and a missing worker capability", async () => {
    await lifecycle.tick(); await advance();
    expect((await boot(f.features, f.boot)).response.status).toBe(409);
    expect((await boot(f.features, randomUUID(), "d".repeat(64))).response.status).toBe(409);
    const response = (await boot(f.features.replace(",acting-user-v1", ""))).response;
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "worker_update_required" } });
    expect((await row()).state).toBe("starting");
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_boots WHERE workspace_id=$1 AND clean_at IS NOT NULL", [f.workspace.id])).rowCount).toBe(0);
  });

  it("refuses running rollback and accepts only the matching completed provider Stop without waking", async () => {
    await lifecycle.tick(); await advance(); const started = await boot(); expect(started.response.status).toBe(200);
    expect((await started.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" })).status).toBe(200);
    await expect(run("rollback")).rejects.toThrow(/completed provider Stop/);
    await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST");
    await expect(run("rollback")).rejects.toThrow(/completed provider Stop/);
    await lifecycle.tick();
    const stopped = await row();
    expect(stopped.execution_mode).toBe("active");
    await run("rollback");
    expect(await row()).toMatchObject({ state: "stopped", execution_mode: "legacy", execution_transition_id: null, worker_token_hash: null, worker_boot_id: null });
    expect((await row()).stop_generation).toBe(stopped.stop_generation);
    expect((await activation()).phase).toBe("rolled_back");
  });

  it("requires Reassign before planning a no-Creator rollback", async () => {
    await lifecycle.tick(); await advance(); const started = await boot();
    expect((await started.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" })).status).toBe(200);
    configureCloudTeamOwnership(pool,true);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId,f.creator.id]));
    await f.cp.store.requestExecutionLifecycle(f.workspace.id,f.viewer.id,"stop");
    await lifecycle.tick();
    const before = await row();
    expect(before).toMatchObject({ state: "stopped", creator_user_id: null, execution_mode: "active" });
    await expect(manageCloudExecution(pool,{ ...input,action: "rollback" },options())).rejects.toThrow(/reassign.*Creator/i);
    expect(await row()).toEqual(before);
  });

  it("binds a rollback approval to the current Creator revision", async () => {
    await lifecycle.tick(); await advance(); const started = await boot();
    expect((await started.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" })).status).toBe(200);
    await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`,"POST");
    await lifecycle.tick();
    const request = { ...input,action: "rollback" as const }, plan = await manageCloudExecution(pool,request,options());
    configureCloudTeamOwnership(pool,true);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspace.id,f.viewer.id]));
    await expect(manageCloudExecution(pool,request,{ ...options(),execute: true,approval: plan.planSha256 })).rejects.toThrow(/plan changed/);
    expect((await row()).execution_mode).toBe("active");
    expect((await run("rollback")).state).toBe("changed");
    expect(await row()).toMatchObject({ execution_mode: "legacy", creator_user_id: f.viewer.id });
  });
});
