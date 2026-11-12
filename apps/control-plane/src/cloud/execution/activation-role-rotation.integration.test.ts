import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrationPool, withSystemTx } from "../../db.js";
import { parseDatabaseTarget } from "../../database-target.js";
import { manageCloudExecution, type CloudExecutionChange } from "../../manage-cloud-execution.js";
import { executionActivationDigest as hash, preparedExecutionSnapshot } from "./activation-snapshot.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const database = databaseUrl ? describe : describe.skip;
database("execution operator role rotation and legacy recovery", () => {
  let pool: pg.Pool, second: pg.Pool | undefined, f: ExecutionFixture;
  let role: string, secondUrl: string, input: CloudExecutionChange;
  const options = (rotated = false) => ({ databaseUrl: rotated ? secondUrl : databaseUrl!, channel: "development" });
  const run = async (action: CloudExecutionChange["action"], rotated = false) => {
    const request = { ...input, action }, db = rotated ? second! : pool;
    const plan = await manageCloudExecution(db, request, options(rotated));
    return manageCloudExecution(db, request, { ...options(rotated), execute: true, approval: plan.planSha256 });
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: databaseUrl, max: 4 }); });
  beforeEach(async () => {
    f = await executionFixture(pool);
    await f.cp.loginChanges.start();
    await f.hello();
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.admin.id]);
    input = { activationId: randomUUID(), action: "prepare", channel: "development", organizationId: f.organizationId,
      workspaceId: f.workspace.id, initiatorUserId: f.viewer.id, operatorUserId: f.admin.id,
      runtimeSha256: "b".repeat(64), reason: "Local role rotation recovery regression" };
    role = `fixture_operator_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE ROLE "${role}" LOGIN INHERIT IN ROLE postgres PASSWORD 'local-fixture-only'`);
    const target = new URL(databaseUrl!); target.username = role; target.password = "local-fixture-only";
    secondUrl = target.toString();
    second = createMigrationPool(secondUrl, { role: "postgres", maxConnections: 1 });
    expect((await second.query("SELECT current_user AS current,session_user AS session")).rows[0])
      .toEqual({ current: "postgres", session: role });
  });
  afterEach(async () => {
    await second?.end(); second = undefined;
    await f?.close();
    await pool.query(`DROP ROLE IF EXISTS "${role}"`);
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(() => pool.end());

  const stopped = async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped',worker_token_hash=NULL,execution_transition_id=NULL WHERE id=$1", [f.workspace.id]);
    await pool.query(`UPDATE cloud_v2_execution_activations SET phase='failed',first_error_code='execution_not_retired',
      confirmed_stop_generation=(SELECT stop_generation FROM cloud_v2_workspaces WHERE id=$2),
      confirmed_stopped_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1`, [input.activationId, f.workspace.id]);
  };
  const legacy = async () => {
    const target = parseDatabaseTarget(databaseUrl!);
    const fingerprint = hash([input.channel,target.hostname,target.port,target.pathname,decodeURIComponent(target.username)]).slice(0,16);
    const snapshot = await withSystemTx(pool, tx => preparedExecutionSnapshot(tx, f.workspace.id, f.viewer.id));
    const identity = { activationId: input.activationId, channel: input.channel, organizationId: input.organizationId,
      workspaceId: input.workspaceId, initiatorUserId: input.initiatorUserId, operatorUserId: input.operatorUserId,
      runtimeSha256: input.runtimeSha256, reason: input.reason };
    await pool.query(`INSERT INTO cloud_v2_execution_activations(id,workspace_id,org_id,initiator_user_id,operator_user_id,
      runtime_sha256,target_fingerprint,request_hash,reason_hash,prepared_snapshot,started_at,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,decode($8,'hex'),decode($9,'hex'),$10,clock_timestamp(),clock_timestamp()+interval '30 minutes')`, [input.activationId,f.workspace.id,f.organizationId,
      f.viewer.id,f.admin.id,input.runtimeSha256,fingerprint,hash(identity),hash(input.reason),snapshot]);
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='prepared' WHERE id=$1", [f.workspace.id]);
    await stopped();
    return { ...input, action: "rollback" as const, legacyTargetFingerprint: fingerprint };
  };

  it("allows a newly authenticated migration-owner role to plan the stopped rollback", async () => {
    await run("prepare"); await run("activate"); await stopped();
    await expect(manageCloudExecution(second!, { ...input, action: "rollback" }, options(true)))
      .resolves.toMatchObject({ state: "planned" });
  });

  it("keeps the approval and activation target stable when prepare and activate use different logins", async () => {
    const initialRole = `${role}_first`, firstUrl = new URL(databaseUrl!);
    firstUrl.username = initialRole; firstUrl.password = "local-fixture-only";
    await pool.query(`CREATE ROLE "${initialRole}" LOGIN INHERIT IN ROLE postgres PASSWORD 'local-fixture-only'`);
    const initial = createMigrationPool(firstUrl.toString(), { role: "postgres", maxConnections: 1 });
    let first;
    try {
      const original = { databaseUrl: firstUrl.toString(), channel: "development" };
      first = await manageCloudExecution(initial, input, original);
      const next = await manageCloudExecution(second!, input, options(true));
      expect(next.targetFingerprint).toMatch(/^v2:[a-f0-9]{16}$/);
      expect(next.planSha256).toBe(first.planSha256);
      expect(next.targetFingerprint).toBe(first.targetFingerprint);
      await manageCloudExecution(initial, input, { ...original, execute: true, approval: first.planSha256 });
    } finally {
      await initial.end();
      await pool.query(`DROP ROLE "${initialRole}"`);
    }
    expect((await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [initialRole])).rowCount).toBe(0);
    expect((await run("activate", true)).state).toBe("changed");
    const row = (await pool.query("SELECT target_fingerprint,prepared_snapshot FROM cloud_v2_execution_activations WHERE id=$1", [input.activationId])).rows[0];
    expect(`v2:${row.target_fingerprint}`).toBe(first.targetFingerprint);
    expect(row.prepared_snapshot.targetFingerprintVersion).toBe(2);
  });

  it("recovers only an explicitly inspected legacy target with a fresh target-bound rollback approval", async () => {
    const request = await legacy();
    await expect(manageCloudExecution(second!, { ...input, action: "rollback" }, options(true))).rejects.toThrow(/another plan/);
    const plan = await manageCloudExecution(second!, request, options(true));
    expect(plan.state).toBe("planned");
    await expect(manageCloudExecution(second!, request, { ...options(true), execute: true, approval: "0".repeat(64) })).rejects.toThrow(/plan/);
    const foreign = new URL(secondUrl); foreign.hostname = "another-database.example.test";
    await expect(manageCloudExecution(second!, request, { ...options(true), databaseUrl: foreign.toString(), execute: true, approval: plan.planSha256 })).rejects.toThrow(/plan/);
    expect((await manageCloudExecution(second!, request, { ...options(true), execute: true, approval: plan.planSha256 })).state).toBe("changed");
    expect((await manageCloudExecution(second!, request, { ...options(true), execute: true, approval: plan.planSha256 })).state).toBe("replayed");
    await expect(manageCloudExecution(second!, request, { ...options(true), databaseUrl: foreign.toString(), execute: true, approval: plan.planSha256 })).rejects.toThrow(/plan/);
    expect((await pool.query("SELECT target_fingerprint,phase FROM cloud_v2_execution_activations WHERE id=$1", [input.activationId])).rows[0])
      .toEqual({ target_fingerprint: request.legacyTargetFingerprint, phase: "rolled_back" });
    expect((await pool.query("SELECT execution_mode,state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0])
      .toEqual({ execution_mode: "legacy", state: "stopped" });
  });

  it("refuses recovery for another identity, runtime, reason, fingerprint, channel, or action", async () => {
    const request = await legacy();
    const changes = [{ activationId: randomUUID() }, { workspaceId: randomUUID() }, { organizationId: randomUUID() },
      { initiatorUserId: f.creator.id }, { operatorUserId: f.viewer.id }, { runtimeSha256: "c".repeat(64) },
      { reason: "A different inspected recovery reason" }, { legacyTargetFingerprint: "0".repeat(16) },
      { action: "prepare" }, { action: "activate" }, { legacyTargetFingerprint: "v2:" + request.legacyTargetFingerprint }];
    for (const change of changes) await expect(manageCloudExecution(second!, { ...request, ...change }, options(true))).rejects.toThrow();
    await expect(manageCloudExecution(second!, request, { ...options(true), channel: "alpha" })).rejects.toThrow(/channel/);
    expect((await pool.query("SELECT phase FROM cloud_v2_execution_activations WHERE id=$1", [input.activationId])).rows[0].phase).toBe("failed");
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_activation_receipts WHERE activation_id=$1", [input.activationId])).rowCount).toBe(0);
  });

  it("keeps all completed Stop and retirement requirements for a legacy recovery", async () => {
    const request = await legacy();
    for (const [table, column, value] of [
      ["cloud_v2_workspaces", "state", "running"],
      ["cloud_v2_workspaces", "worker_token_hash", Buffer.alloc(32, 1)],
      ["cloud_v2_workspaces", "execution_transition_id", input.activationId],
      ["cloud_v2_execution_activations", "confirmed_stop_generation", "9999"],
      ["cloud_v2_execution_activations", "confirmed_stopped_at", null],
    ] as const) {
      const id = table === "cloud_v2_workspaces" ? f.workspace.id : input.activationId;
      const previous = (await pool.query(`SELECT ${column} FROM ${table} WHERE id=$1`, [id])).rows[0][column];
      await pool.query(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`, [id,value]);
      await expect(manageCloudExecution(second!, request, options(true))).rejects.toThrow(/completed provider Stop/);
      await pool.query(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`, [id,previous]);
    }
    await pool.query(`INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,worker_boot_id,worker_token_hash,
      access_epoch,stop_generation,authority,source_fingerprint,client_id,generation,state,expires_at)
      SELECT gen_random_uuid(),id,org_id,creator_user_id,'client',$2,decode(repeat('ab',32),'hex'),
        access_epoch,stop_generation,'{}','fixture',gen_random_uuid(),1,'active',clock_timestamp()+interval '30 seconds' FROM cloud_v2_workspaces WHERE id=$1`, [f.workspace.id,f.boot]);
    await expect(manageCloudExecution(second!, request, options(true))).rejects.toThrow(/completed provider Stop/);
  });

  it("never applies legacy recovery to a versioned target", async () => {
    await run("prepare"); await run("activate"); await stopped();
    const row = (await pool.query("SELECT target_fingerprint FROM cloud_v2_execution_activations WHERE id=$1", [input.activationId])).rows[0];
    await expect(manageCloudExecution(second!, { ...input, action: "rollback", legacyTargetFingerprint: row.target_fingerprint }, options(true)))
      .rejects.toThrow(/legacy/);
  });
});
