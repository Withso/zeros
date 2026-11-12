import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { manageAccountPro } from "../../manage-account-pro.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("durable execution revocation", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.activate(); expect((await f.hello()).status).toBe(200); await f.login(f.viewer); await f.login(f.creator); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const read = async (id: string) => (await pool.query("SELECT state,reason,material,environment_version_id FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0];
  const turn = async () => {
    const active = await f.dispatch(f.prompt(), f.viewer);
    expect((await f.worker("turn-lease", active.lease)).status).toBe(200);
    return active;
  };

  it("revokes a removed member immediately, erases credentials, and leaves another actor alone", async () => {
    const active = await turn(), other = await f.dispatch(f.prompt(randomUUID(), { chatId: "other" }));
    expect((await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id])).rowCount).toBe(1);
    expect(await read(active.begun.contextId)).toMatchObject({ state: "revoked", reason: "access_revoked", material: null, environment_version_id: null });
    expect((await read(other.begun.contextId)).state).toBe("active");
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_tokens WHERE context_id=$1", [active.begun.contextId])).rowCount).toBe(0);
  });

  it("revokes the selected member credential even when that member owns no workspace", async () => {
    const active = await turn();
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.own.id]);
    await pool.query("UPDATE cloud_agent_credentials SET revoked_at=clock_timestamp(),revision=revision+1 WHERE owner_user_id=$1", [f.viewer.id]);
    expect(await read(active.begun.contextId)).toMatchObject({ state: "revoked", reason: "actor_changed", material: null });
  });

  it("revokes a member put on Hold by an entitlement change while keeping another person's turn", async () => {
    for (let n = 0; n < 5; n++) {
      const id = randomUUID();
      await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role,created_at) VALUES($1,$2,'member',now()-interval '1 day')", [f.organizationId, id]);
    }
    const active = await turn(), other = await f.dispatch(f.prompt(randomUUID(), { chatId: "other" }));
    const operator = await pool.connect();
    try {
      await operator.query("BEGIN; SELECT set_config('app.system','on',true)");
      await operator.query("UPDATE account_entitlements SET status='cancelled',cloud_workspaces_allowed=false WHERE user_id=$1", [f.viewer.id]);
      await operator.query("COMMIT");
    } catch (error) { await operator.query("ROLLBACK"); throw error; }
    finally { operator.release(); }
    expect(await read(active.begun.contextId)).toMatchObject({ state: "revoked", reason: "access_revoked", material: null });
    expect((await read(other.begun.contextId)).state).toBe("active");
    const refused = await f.worker("turn-lease", active.lease);
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: { code: "actor_changed" } });
    expect(await (await f.worker("execution-leases/renew", { contextIds: [active.begun.contextId] })).json())
      .toEqual({ leases: [{ contextId: active.begun.contextId, refused: "access_revoked" }] });
  });

  it("keeps queued work cancelled across the real operator's Pro revoke and restore during a listener gap", async () => {
    await f.cp.loginChanges.stop();
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.admin.id]);
    const input = f.prompt(); expect((await f.send(input, f.viewer)).status).toBe(201);
    const delivery = (await (await f.worker("prompts/pull", { waitMs: 0 })).json()).prompts[0];
    expect((await f.worker("prompts/ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId })).status).toBe(200);
    for (const enabled of [false, true]) {
      const change = { operationId: randomUUID(), channel: "development", actorUserId: f.admin.id, subjectUserId: f.viewer.id,
        expectedEmail: f.viewer.email, enabled, validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: null,
        reason: "Verify queued execution cannot survive revoked account authority" };
      const options = { databaseUrl: process.env.TEST_DATABASE_URL!, channel: "development" };
      const plan = await manageAccountPro(pool, change, options);
      expect((await manageAccountPro(pool, change, { ...options, execute: true, approval: plan.planSha256 })).state).toBe("changed");
    }
    const response = await f.worker("prompts/begin", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ dispatch: false, state: "cancelled" });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn'", [f.workspace.id])).rowCount).toBe(0);
  });

  it("treats source outage as unknown and a later denial as revocation", async () => {
    const active = await turn();
    await pool.query("UPDATE cloud_github_source_verifications SET failure_code='github_unavailable',failure_status=503 WHERE owner_user_id=$1", [f.viewer.id]);
    expect((await read(active.begun.contextId)).state).toBe("active");
    await pool.query("UPDATE cloud_github_source_verifications SET failure_code='github_repository_access_required',failure_status=403 WHERE owner_user_id=$1", [f.viewer.id]);
    expect(await read(active.begun.contextId)).toMatchObject({ state: "revoked", reason: "access_revoked", material: null });
  });

  it("keeps the cleanup barrier after Stop intent and releases it only after confirmed shutdown", async () => {
    const active = await turn();
    const stopped = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST", undefined, f.creator);
    expect(stopped.status).toBe(202);
    expect(await read(active.begun.contextId)).toMatchObject({ state: "revoked", reason: "cancelled" });
    const generation = (await pool.query("SELECT stop_generation FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].stop_generation;
    await f.cp.store.transition(f.workspace.id, ["stopping"], "stopped", { stopGeneration: generation, revoke: true });
    expect(await read(active.begun.contextId)).toMatchObject({ state: "retired", reason: "cancelled", material: null });
  });

  it("retains a durably accepted turn through exact desktop session sign-out", async () => {
    const active = await turn();
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId]);
    expect((await read(active.begun.contextId)).state).toBe("active");
    expect((await f.worker("turn-lease", active.lease)).status).toBe(200);
  });

  it("rechecks the context at the final authority read after an outcome wins during that await", async () => {
    const active = await turn();
    const access = await f.cp.execution.authorizedContext({ token: f.token, bootId: f.boot }, active.begun.contextId);
    let entered!: () => void, release!: () => void;
    const seen = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.cp.execution.deps.authority.assert.bind(f.cp.execution.deps.authority);
    vi.spyOn(f.cp.execution.deps.authority, "assert").mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const checked = access.check().then(() => null, error => error);
    try {
      await seen;
      expect((await f.worker("prompts/outcome", { userMessageId: active.input.userMessageId, dispatchId: active.begin.dispatchId, state: "completed" })).status).toBe(200);
      release();
      expect(await checked).toMatchObject({ code: "actor_changed" });
    } finally { release(); await checked; }
  });

  it("does not resurrect a queued send when a member leaves and rejoins during a listener gap", async () => {
    await f.cp.loginChanges.stop();
    const input = f.prompt(); expect((await f.send(input, f.viewer)).status).toBe(201);
    const delivery = (await (await f.worker("prompts/pull", { waitMs: 0 })).json()).prompts[0];
    expect((await f.worker("prompts/ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId })).status).toBe(200);
    expect((await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id])).rowCount).toBe(1);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [f.organizationId, f.viewer.id]);
    await f.login(f.viewer);
    const scope = { organizationId: f.organizationId, userId: f.viewer.id };
    await f.github.connections.store.save(scope, await f.github.connections.store.fingerprint(scope),
      { id: "12", login: "fixture" }, { method: "pat", accessToken: `synthetic-${f.viewer.id}`, expiresAt: null });
    const response = await f.worker("prompts/begin", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dispatch: false, state: "cancelled" });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn'", [f.workspace.id])).rowCount).toBe(0);
  });
});
