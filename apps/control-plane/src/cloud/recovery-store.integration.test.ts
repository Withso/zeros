import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Store } from "./store.js";
import { CloudRecoveryStore } from "./recovery-store.js";
import type { WorkerRoute } from "./worker-connection.js";
import { sealPortToken } from "./worker-port-token.js";
import { CloudV2Computers } from "./computer.js";
import { sealCheckpointKey, cloudV2CheckpointObject } from "./checkpoint.js";
import { newCloudV2Token } from "./tokens.js";
import { CloudRecovery } from "./recovery.js";
import { withSystemTx, withUserTx } from "../db.js";

const keys = { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } };

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("checkpoint recovery fences with PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  async function fixture(capable = true) {
    const user = randomUUID(), org = randomUUID(), boot = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    const store = new CloudV2Store(pool);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: user,
      name: "Recovery continuity", repository: "fixture/repo", sourceRepositoryId: "42", branch: "work", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_recoveryfixture' WHERE id=$1", [workspace.id]);
    await store.setWorkerRoute(workspace.id, "bx_recoveryfixture", "https://fixture-41783.on.boat.dev", sealPortToken("synthetic-port-token", workspace.id, { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } }));
    const token = await store.rotateWorkerToken(workspace.id);
    await store.beginWorkerHello(token, boot, false, "a".repeat(64), false, capable); await store.acceptWorkerHello(token, boot);
    await pool.query(`UPDATE cloud_v2_workspaces SET execution_mode='active',execution_intent_id=$2,
      execution_initiator_user_id=$3,execution_intent_authority='{}',worker_runtime_boot_id=$4,
      worker_runtime_sha256=repeat('a',64) WHERE id=$1`, [workspace.id, randomUUID(), user, boot]);
    const route: WorkerRoute = { ...(await store.workerRoute(workspace.id))!, token: "synthetic-port-token" };
    const recovery = new CloudRecoveryStore(pool);
    return { user, org, boot, token, workspace, store, route, recovery };
  }

  it("serializes replicas into one durable attempt and counts a failed attempt in the rolling hour", async () => {
    const f = await fixture();
    const attempts = await Promise.all([f.recovery.begin(f.route), f.recovery.begin(f.route)]);
    expect(attempts[0]?.id).toBeTruthy(); expect(attempts[0]?.id).toBe(attempts[1]?.id);
    expect((await pool.query("SELECT count(*) FROM cloud_v2_recovery_attempts")).rows[0].count).toBe("1");
    await f.recovery.fail(attempts[0]!.id, "restore_refused");
    expect(await f.recovery.begin(f.route)).toBeNull();
    expect((await f.store.get(f.workspace.id, f.user)).errorCode).toBe("live_connection_unavailable");
  });

  it("never attempts B on an N-1 worker, a changed route, or a changed boot", async () => {
    const f = await fixture(false);
    expect(await f.recovery.begin(f.route)).toBeNull();
    await pool.query("UPDATE cloud_v2_workspaces SET worker_recovery_boot_id=worker_boot_id WHERE id=$1", [f.workspace.id]);
    expect(await f.recovery.begin({ ...f.route, url: "https://old.example.test" })).toBeNull();
    expect(await f.recovery.begin({ ...f.route, bootId: randomUUID() })).toBeNull();
    expect((await pool.query("SELECT count(*) FROM cloud_v2_recovery_attempts")).rows[0].count).toBe("0");
  });

  it("stores only sealed envelopes and keeps the journal invisible outside system context", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    for (const column of ["source_port_token", "replacement_token", "replacement_port_token", "checkpoint_key"] as const) {
      await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_v2_recovery_attempts SET ${column}=$2::jsonb WHERE id=$1`,
        [a.id, JSON.stringify({ value: "synthetic-unsealed-secret" })]))).rejects.toMatchObject({ code: "23514" });
    }
    expect(await withUserTx(pool, f.user, async tx => (await tx.query("SELECT id FROM cloud_v2_recovery_attempts WHERE id=$1", [a.id])).rowCount)).toBe(0);
  });

  it("fails closed if a future workspace writer can see the workspace but not the active attempt", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    await f.recovery.fence(a.id);
    await f.recovery.request(f.token, f.boot, { op: "seal", id: a.id, generation: 1 });
    await pool.query("CREATE POLICY recovery_guard_fixture ON cloud_v2_workspaces USING (creator_user_id=app_current_user()) WITH CHECK (creator_user_id=app_current_user())");
    try {
      await expect(withUserTx(pool, f.user, tx => tx.query("UPDATE cloud_v2_workspaces SET state='running' WHERE id=$1", [f.workspace.id])))
        .rejects.toMatchObject({ code: "23514", constraint: "cloud_recovery_binding_changed" });
      expect((await f.store.get(f.workspace.id, f.user)).state).toBe("starting");
    } finally { await pool.query("DROP POLICY recovery_guard_fixture ON cloud_v2_workspaces"); }
  });

  it("holds only after the fence and binds every seal/status to the same generation", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    expect(await f.recovery.pull(f.token, f.boot, a.id)).toEqual({ hold: false });
    expect(await f.recovery.fence(a.id)).toBe(true);
    expect(await f.recovery.pull(f.token, f.boot, a.id)).toEqual({ hold: true, hint: { id: a.id } });
    const request = { id: a.id, generation: 7, op: "seal" as const };
    expect(await f.recovery.request(f.token, f.boot, request)).toEqual({ id: a.id, generation: 7, status: "sealed" });
    await expect(f.recovery.request(f.token, f.boot, { ...request, op: "status", generation: 8 })).rejects.toMatchObject({ code: "recovery_binding_changed" });
    await expect(f.recovery.request(f.token, randomUUID(), request)).rejects.toMatchObject({ code: "recovery_binding_changed" });
    expect(await f.recovery.request(f.token, f.boot, { ...request, op: "status" })).toEqual({ id: a.id, generation: 7, status: "sealed" });
  });

  it("does not turn an expired or uncertain capture into permission to unfreeze", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    await f.recovery.fence(a.id);
    await f.recovery.request(f.token, f.boot, { op: "seal", id: a.id, generation: 3 });
    await pool.query("UPDATE cloud_v2_recovery_attempts SET phase='capturing',deadline_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [a.id]);
    expect(await f.recovery.request(f.token, f.boot, { op: "status", id: a.id, generation: 3 })).toEqual({ id: a.id, generation: 3, status: "sealed" });
    await expect(f.recovery.cancel(a.id)).rejects.toMatchObject({ code: "recovery_capture_pending" });
  });

  it("cancels a restored source connection only before capture and never revives a stopped generation", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    await f.recovery.fence(a.id);
    await f.recovery.request(f.token, f.boot, { op: "seal", id: a.id, generation: 3 });
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id]);
    await f.recovery.cancel(a.id, { ...f.route, recoveryAttemptId: a.id });
    expect((await f.store.get(f.workspace.id, f.user)).state).toBe("stopping");
    expect((await f.recovery.read(a.id))?.phase).toBe("sealed");
  });

  it("keeps a source hello starting after the seal", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    await f.recovery.fence(a.id);
    await f.recovery.request(f.token, f.boot, { op: "seal", id: a.id, generation: 3 });
    expect((await f.store.acceptWorkerHello(f.token, f.boot))?.state).toBe("starting");
  });

  it("lets Stop win without allowing a stale attempt to change the new generation", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    await f.recovery.fence(a.id);
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id]);
    expect(await f.recovery.fence(a.id)).toBe(false);
    await f.recovery.fail(a.id, "binding_changed");
    const row = (await pool.query("SELECT state,recovery_attempt_id,error_code FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    expect(row).toEqual({ state: "stopping", recovery_attempt_id: null, error_code: null });
  });

  it("keeps a send committed after the fence queued even when pull passed its HTTP precheck", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    expect(await f.recovery.fence(a.id)).toBe(true);
    const message = randomUUID(), chat = randomUUID();
    await pool.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,$2)", [f.workspace.id, chat]);
    await pool.query(`INSERT INTO cloud_v2_prompt_outbox(workspace_id,user_message_id,chat_id,creator_user_id,sequence,
      epoch,access_epoch,payload_hash,payload,payload_bytes,receipt) VALUES($1,$2,$3,$4,1,0,0,repeat('a',64),$5,1,'{}')`,
    [f.workspace.id, message, chat, f.user, JSON.stringify({ chatId: chat, userMessageId: message, agentId: "claude", prompt: [{ type: "text", text: "queued" }], startedAt: 1 })]);
    expect((await f.store.prompts.pull(f.token, f.boot)).prompts).toEqual([]);
    expect((await pool.query("SELECT state,delivery_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rows[0])
      .toEqual({ state: "queued", delivery_id: null });
    expect(await f.recovery.request(f.token, f.boot, { op: "seal", id: a.id, generation: 2 }))
      .toEqual({ id: a.id, generation: 2, status: "sealed" });
  });

  it("accepts a source setup report while waiting without using it as replacement proof", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    await f.recovery.setup(f.token, f.boot, a.id, { state: "succeeded", startedAt: 1, finishedAt: 2 });
    expect((await f.recovery.read(a.id))?.setup_succeeded_at).toBeNull();
  });

  it("keeps the seal deadline anchored while an earlier dispatch is still retiring", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    await f.recovery.fence(a.id);
    await pool.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id,epoch,stop_acked_epoch) VALUES($1,'retiring',1,0)", [f.workspace.id]);
    await pool.query("UPDATE cloud_v2_recovery_attempts SET updated_at=clock_timestamp()-interval '30 seconds' WHERE id=$1", [a.id]);
    const started = (await f.recovery.read(a.id))!.updated_at;
    expect(await f.recovery.request(f.token, f.boot, { op: "seal", id: a.id, generation: 9 })).toMatchObject({ status: "pending" });
    expect((await f.recovery.read(a.id))!.updated_at).toEqual(started);
    await pool.query("UPDATE cloud_v2_prompt_chats SET stop_acked_epoch=epoch WHERE workspace_id=$1", [f.workspace.id]);
    expect(await f.recovery.request(f.token, f.boot, { op: "status", id: a.id, generation: 9 })).toMatchObject({ status: "sealed" });
  });

  it("retains terminal receipts for 24 hours and never purges an unowned, unconfirmed VM", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    await f.recovery.fail(a.id, "github_access_required");
    const claimed = (await f.recovery.claim(a.id, 60000))!;
    expect(await f.recovery.purge(a.id, claimed.lease_id!, [])).toBe(false);
    await pool.query("UPDATE cloud_v2_recovery_attempts SET completed_at=clock_timestamp()-interval '25 hours' WHERE id=$1", [a.id]);
    await pool.query("UPDATE cloud_v2_workspaces SET state='deleted',boat_sandbox_id=NULL WHERE id=$1", [f.workspace.id]);
    expect(await f.recovery.purge(a.id, claimed.lease_id!, [])).toBe(false);
    await f.recovery.deletedSandbox(a.id, a.source_sandbox_id);
    expect(await f.recovery.purge(a.id, claimed.lease_id!, [])).toBe(true);
    expect(await f.recovery.read(a.id)).toBeNull();
  });

  it("rejects an expired coordinator lease and prevents its late failure from cancelling the new owner", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    const old = (await f.recovery.claim(a.id, 60000))!;
    await pool.query("UPDATE cloud_v2_recovery_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [a.id]);
    expect(await f.recovery.workspace(a.id, old.lease_id!, 60000)).toBeNull();
    const next = (await f.recovery.claim(a.id, 60000))!;
    expect(next.lease_id).not.toBe(old.lease_id);
    await f.recovery.fail(a.id, "recovery_binding_changed", old.lease_id!);
    expect((await f.recovery.read(a.id))!.phase).toBe("waiting");
    expect(await f.recovery.workspace(a.id, next.lease_id!, 60000)).toMatchObject({ id: f.workspace.id });
  });

  it("pins the replacement image, retains the source until setup/readiness, then purges only the reconciled 24-hour receipt", async () => {
    const f = await fixture(), a = (await f.recovery.begin(f.route))!;
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const build = await computers.enqueue(f.org, f.user, { repositories: [{ repository: "fixture/repo", branch: "main", commit: "a".repeat(40) }] });
    await computers.claim(); await computers.setRuntime(build.id, "a".repeat(64)); await computers.activate(build.id, "snapshot-fixture");
    await f.recovery.fence(a.id); await f.recovery.request(f.token, f.boot, { op: "seal", id: a.id, generation: 4 });
    const lease = (await f.recovery.claim(a.id, 60000))!.lease_id!;
    await f.recovery.startCapture(a.id, lease); await f.recovery.stopped(a.id, lease);
    const object = cloudV2CheckpointObject(f.workspace.id, randomUUID());
    await f.recovery.upload(a.id, lease, { object, key: sealCheckpointKey(Buffer.alloc(32, 8), f.workspace.id, object, keys), until: new Date(Date.now() + 60000) });
    await f.recovery.captured(a.id, lease, { object, sha256: "a".repeat(64), bytes: 16 });
    const token = newCloudV2Token("worker");
    expect(await f.recovery.prepare(a.id, lease, { name: "fixture-recovery", env: {}, runtime: "a".repeat(64),
      tokenHash: token.hash, token: sealPortToken(token.token, f.workspace.id, keys) })).toBe(true);
    expect(await computers.resources(build.id)).toMatchObject({ pinned: true });
    expect((await f.recovery.read(a.id))!.replacement_create).toMatchObject({ setupBuildId: null });
    expect((await f.store.get(f.workspace.id, f.user)).boatSandboxId).toBe(a.source_sandbox_id);
    await f.recovery.creating(a.id, lease);
    await f.recovery.created(a.id, "bx_replacementfixture");
    expect(await f.recovery.claimRestore(a.id, lease)).toBe(true);
    expect(await f.recovery.restored(a.id, lease)).toBe(true);
    expect(await f.recovery.publish(a.id, lease, { url: "https://replacement.example.test", token: sealPortToken("replacement-port-token", f.workspace.id, keys) })).toBe(true);
    const boot = randomUUID();
    expect(await f.recovery.hello(token.token, boot, "a".repeat(64), true, a.id)).toBe(true);
    await pool.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2 WHERE id=$1", [f.workspace.id, boot]);
    expect(await f.recovery.ready(a.id, lease, boot)).toBe(true);
    expect(await f.recovery.succeed(a.id, lease)).toBe(false);
    await f.recovery.setup(token.token, boot, a.id, { state: "succeeded", startedAt: 1, finishedAt: 2 });
    expect(await f.recovery.succeed(a.id, lease)).toBe(true);
    expect(await f.recovery.sourceDisposable(a.id)).toBe(true);
    const after = await f.store.get(f.workspace.id, f.user);
    expect(after).toMatchObject({ id: f.workspace.id, number: f.workspace.number, name: f.workspace.name,
      boatSandboxId: "bx_replacementfixture", state: "running" });
    const removeVm = vi.fn(), removeArchive = vi.fn();
    const coordinator = new CloudRecovery({ store: f.recovery, compute: { delete: removeVm }, checkpoints: { storage: { delete: removeArchive } } } as never);
    await f.recovery.defer(a.id, lease, 0);
    await coordinator.run(a.id);
    expect(removeVm).toHaveBeenCalledExactlyOnceWith(a.source_sandbox_id);
    expect(removeArchive).not.toHaveBeenCalled();
    expect(await f.recovery.read(a.id)).toMatchObject({ phase: "succeeded", source_deleted_at: expect.any(Date) });
    await pool.query("UPDATE cloud_v2_recovery_attempts SET completed_at=clock_timestamp()-interval '25 hours',next_attempt_at=clock_timestamp() WHERE id=$1", [a.id]);
    await coordinator.run(a.id);
    expect(await f.recovery.read(a.id)).toBeNull();
    expect((await f.store.get(f.workspace.id, f.user)).boatSandboxId).toBe("bx_replacementfixture");
  });
});
