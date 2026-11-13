import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("shared execution lifecycle and metadata", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool, { teamOwnership: true }); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const call = (action: string, body?: unknown, user = f.viewer) => f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/${action}`, "POST", body, user, { "X-Zeros-Team-Sharing": "1" });
  it("persists a member's start and restart intent before lifecycle work", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [f.workspace.id]);
    const response = await call("start"); expect(response.status).toBe(202);
    let row = (await pool.query("SELECT execution_initiator_user_id,execution_intent_id,state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    expect(row).toMatchObject({ execution_initiator_user_id: f.viewer.id, state: "starting" }); expect(row.execution_intent_id).toEqual(expect.any(String));
    expect((await f.hello()).status).toBe(401);
    const token = await f.cp.store.rotateWorkerToken(f.workspace.id), boot = randomUUID();
    expect((await f.worker("hello", { protocol: 2, bootId: boot, runtimeSha256: "b".repeat(64) }, { boot, token })).status).toBe(200);
    expect((await call("restart", undefined, f.admin)).status).toBe(202);
    row = (await pool.query("SELECT execution_initiator_user_id,state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    expect(row).toEqual({ execution_initiator_user_id: f.admin.id, state: "stopping" });
  });
  it("lets a member Stop without an agent login or GitHub call and keeps workspace archive restricted", async () => {
    f.fetcher.mockClear();
    expect((await call("stop")).status).toBe(202);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await call("archive")).status).toBe(403);
  });
  it("starts a workspace with no Creator using only the waking member's bootstrap authority", async () => {
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [f.workspace.id]);
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/start`, "POST", {}, f.viewer,
      { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ teamSharing: 1, teamOwnership: 1, workspace: {
      creatorUserId: null, teamOwnership: 1, creatorRevision: "2", noCreatorReason: "left", canReassign: false,
    } });
    expect((await pool.query("SELECT creator_user_id,execution_initiator_user_id,state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0])
      .toEqual({ creator_user_id: null, execution_initiator_user_id: f.viewer.id, state: "starting" });
    const token = await f.cp.store.rotateWorkerToken(f.workspace.id), boot = randomUUID();
    const options = { token, boot, features: `${f.features},creator-agent-logins-v1` };
    const hello = await f.worker("hello", { protocol: 2, bootId: boot, runtimeSha256: "b".repeat(64) }, options);
    expect(hello.status).toBe(200);
    const { config } = await hello.json();
    expect(config).toMatchObject({ actingUser: 1, agents: {}, agentLogins: {}, gitIdentity: null, bootstrapContextId: expect.any(String) });
    expect(config).not.toHaveProperty("environment");
    expect((await f.worker("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, options)).status).toBe(200);
    const bootstrap = await f.worker("bootstrap-lease", { contextId: config.bootstrapContextId }, options);
    expect(bootstrap.status).toBe(200);
    const lease = await bootstrap.json();
    expect(lease.userId).toBe(f.viewer.id); expect(lease).not.toHaveProperty("agents");
    const github = await f.worker("github-token", { contextId: lease.contextId, purpose: "git" }, options);
    expect(github.status).toBe(200); expect((await github.json()).token).toBe(`synthetic-${f.viewer.id}`);
    expect((await f.worker(`execution-leases/${lease.contextId}/retired`, { retirementId: randomUUID(), reason: "setup_done", processes: 0 }, options)).status).toBe(200);
    f.fetcher.mockClear();
    const stopped = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST", {}, f.viewer,
      { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" });
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({ teamOwnership: 1, workspace: { creatorUserId: null, teamOwnership: 1, state: "stopping" } });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("refuses an unnegotiated no-Creator lifecycle request before changing its state", async () => {
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [f.workspace.id]);
    const response = await call("start");
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("team_ownership_required");
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].state).toBe("stopped");
  });
  it.each(["left", "erased"])("refreshes credential-free config after the completed setup initiator is %s", async state => {
    await f.activate(f.viewer);
    const before = await f.worker("config", undefined, { method: "GET" });
    expect(before.status).toBe(200);
    const { bootstrapContextId } = (await before.json()).config;
    expect((await f.worker("bootstrap-lease", { contextId: bootstrapContextId })).status).toBe(200);
    expect((await f.worker(`execution-leases/${bootstrapContextId}/retired`, { retirementId: randomUUID(), reason: "setup_done", processes: 0 })).status).toBe(200);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    if (state === "erased") {
      await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.own.id]);
      await pool.query("DELETE FROM users WHERE id=$1", [f.viewer.id]);
    }
    await pool.query("UPDATE cloud_v2_execution_contexts SET retired_at=clock_timestamp()-interval '8 days' WHERE id=$1", [bootstrapContextId]);
    await f.cp.execution.maintenance.sweep(() => {});
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE id=$1", [bootstrapContextId])).rowCount).toBe(1);
    const response = await f.worker("config", undefined, { method: "GET" });
    expect(response.status).toBe(200);
    const config = (await response.json()).config;
    expect(config).toMatchObject({ actingUser: 1, agents: {}, gitIdentity: null });
    expect(config).not.toHaveProperty("bootstrapContextId");
    expect((await f.worker("bootstrap-lease", { contextId: bootstrapContextId })).status).toBe(409);
    await pool.query("UPDATE cloud_v2_workspaces SET execution_intent_id=$2 WHERE id=$1", [f.workspace.id, randomUUID()]);
    await f.cp.execution.maintenance.sweep(() => {});
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE id=$1", [bootstrapContextId])).rowCount).toBe(0);
  });
  it("records the waking sender as initiator and exposes write capability only under the sharing opt-in", async () => {
    await f.login();
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [f.workspace.id]);
    expect((await f.send(f.prompt(), f.viewer)).status).toBe(201);
    expect((await pool.query("SELECT execution_initiator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].execution_initiator_user_id).toBe(f.viewer.id);
    const shared = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}`, "GET", undefined, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect((await shared.json()).workspace).toMatchObject({ teamWriting: 1, canExecute: true, readOnly: false });
    const creator = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}`);
    expect((await creator.json()).workspace).not.toHaveProperty("teamWriting");
  });
  it("permits member chat metadata edits while the worker capability remains required", async () => {
    const chatId = randomUUID();
    await f.cp.store.writeHistory(f.workspace.id, { chats: [{ id: chatId, title: "Before", agentId: "claude" } as never] });
    await pool.query("UPDATE cloud_v2_workspaces SET chat_edit_boot_ids=ARRAY[$2::uuid] WHERE id=$1", [f.workspace.id, f.boot]);
    const response = await call(`chats/${chatId}/edit`, { title: "After" }); expect(response.status).toBe(200);
    expect((await response.json()).chat.title).toBe("After");
  });

  it("overlays the live actor only on opted-in history, without trusting a worker-supplied actor", async () => {
    await f.login(); const active = await f.dispatch(f.prompt(), f.viewer);
    await f.cp.store.writeHistory(f.workspace.id, { chats: [{ id: "chat", agentId: "claude", actingUser: { userId: f.creator.id } }] });
    const history = () => call("history", { op: "chats.list", params: {} });
    const result = await history(); expect(result.status).toBe(200);
    expect((await result.json()).result.chats).toMatchObject([{ id: "chat", actingUser: active.begun.actingUser }]);
    const plain = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/history`, "POST", { op: "chats.list", params: {} });
    expect(plain.status).toBe(200);
    expect((await plain.json()).result.chats[0]).not.toHaveProperty("actingUser");
    expect((await f.worker("prompts/outcome", { userMessageId: active.input.userMessageId, dispatchId: active.begin.dispatchId, state: "completed" })).status).toBe(200);
    expect((await (await history()).json()).result.chats[0].actingUser).toBeNull();
  });

  it("defers active in-place runtime adoption before any Creator source lookup or provider command", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET worker_runtime_sha256=$2,worker_runtime_boot_id=worker_boot_id WHERE id=$1", [f.workspace.id, "a".repeat(64)]);
    await pool.query("DELETE FROM cloud_github_source_verifications WHERE owner_user_id=$1", [f.creator.id]);
    f.fetcher.mockClear();
    const exec = vi.spyOn(f.cp.compute, "execLong").mockResolvedValue({ exitCode: 0, stdout: "", timedOut: false });
    const revision = (await f.cp.store.loginRevision(f.workspace.id))!;
    const response = await f.worker("runtime", { op: "prepare", instanceId: randomUUID(), revision, generation: 1 },
      { features: `${f.features},runtime-update-v1` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unavailable" });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
