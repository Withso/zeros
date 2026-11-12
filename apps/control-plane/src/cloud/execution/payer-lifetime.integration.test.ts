import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseCloudAgentCredentialService } from "../../agent-credentials/agent-credentials.js";
import { DatabaseCodexAuthRenewal } from "../../agent-credentials/codex-auth-renewal.js";
import { syntheticCodexCache } from "../../agent-credentials/codex-auth-test-fixture.js";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("pinned payer lifetime and rolling-deploy compatibility", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const row = async (id: string) => (await pool.query("SELECT state,selection,credential_id,material IS NOT NULL AS has_material FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0];
  const reassign = (id: string) => withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspace.id, id]));
  const begin = async (input: ReturnType<ExecutionFixture["prompt"]>) => {
    const delivery = (await (await f.worker("prompts/pull", { waitMs: 0, held: [] })).json()).prompts.find((value: any) => value.payload.userMessageId === input.userMessageId);
    expect(delivery).toBeDefined();
    expect((await f.worker("prompts/ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId })).status).toBe(200);
    return f.worker("prompts/begin", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() });
  };

  it.each(["codex", "cursor"] as const)("selects the Creator's %s login for an actor with no login", async agentId => {
    const payer = await f.login(f.creator, agentId);
    const turn = await f.dispatch(f.prompt(randomUUID(), { agentId }), f.viewer);
    const response = await f.worker("turn-lease", turn.lease);
    expect(response.status).toBe(200);
    const lease = await response.json();
    expect(lease.userId).toBe(f.viewer.id);
    expect(await row(turn.begun.contextId)).toMatchObject({ credential_id: payer.id, selection: { payer: { userId: f.creator.id } } });
    if (agentId === "codex") expect((await f.cp.execution.proxyAccess(lease.agents.codex.token)).login).toMatchObject({ apiKey: payer.secret });
    else expect(lease.agents.cursor).toMatchObject({ apiKey: payer.secret });
  });

  it("refreshes the Creator's Codex OAuth material without changing B's payer pin or retiring the turn", async () => {
    const keys = { ...f.keys, refreshFingerprints: { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 29).toString("base64url") } } };
    const vault = new DatabaseCloudAgentCredentialService(pool, keys), id = randomUUID();
    await vault.importCodex({ ownerUserId: f.creator.id, organizationId: f.organizationId, credentialId: id, operationId: randomUUID(), expectedRevision: 0,
      displayName: "Fixture", nativeCache: syntheticCodexCache({ expiresAt: Math.floor(Date.now() / 1000) + 20 }) });
    await vault.setOrganizationConnection(f.creator.id, f.organizationId, "codex", { expectedRevision: 0, credentialId: id, credentialRevision: 1,
      models: ["gpt-5.4"], consent: "zeros-managed" });
    const turn = await f.dispatch(f.prompt(randomUUID(), { agentId: "codex" }), f.viewer);
    const lease = await (await f.worker("turn-lease", turn.lease)).json(), before = await row(turn.begun.contextId);
    const original = DatabaseCodexAuthRenewal.prototype.complete;
    const rotated = syntheticCodexCache({ refresh: "synthetic-new-refresh-seed" });
    vi.spyOn(DatabaseCodexAuthRenewal.prototype, "complete").mockImplementation(function (reservation) {
      expect(reservation.credential.owner_user_id).toBe(f.creator.id);
      const renewal = new DatabaseCodexAuthRenewal(pool, keys, async (_cache, dispatch) => { await dispatch(); return rotated; });
      return original.call(renewal, reservation);
    });
    const access = await f.cp.execution.proxyAccess(lease.agents.codex.token);
    expect(access.login).toMatchObject({ kind: "codex-chatgpt", accessToken: rotated.tokens.access_token });
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", selection: before.selection, credential_id: id });
    expect((await pool.query("SELECT current_version,revision FROM cloud_agent_credentials WHERE id=$1", [id])).rows[0]).toEqual({ current_version: 2, revision: "1" });
    expect(await (await f.worker("execution-leases/renew", { contextIds: [turn.begun.contextId] })).json())
      .toEqual({ leases: [{ contextId: turn.begun.contextId, expiresAt: expect.any(Number) }] });
  });

  it("cuts B's turn when its pinned payer goes on Hold while B's client handle stays usable", async () => {
    for (let n = 0; n < 5; n++) {
      const id = randomUUID();
      await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role,created_at) VALUES($1,$2,'member',now()-interval '1 day')", [f.organizationId, id]);
    }
    const turn = await f.dispatch(f.prompt(), f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const { protocols } = await response.json(), grant = await f.cp.store.consumeConnectTicket(protocols[1].slice(7), f.workspace.id);
    const handle = await f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant!);
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; SELECT set_config('app.system','on',true)");
      await tx.query("UPDATE account_entitlements SET status='cancelled',cloud_workspaces_allowed=false WHERE user_id=$1", [f.creator.id]);
      await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
    expect(await (await f.worker("execution-leases/renew", { contextIds: [handle.contextId] })).json())
      .toEqual({ leases: [{ contextId: handle.contextId, expiresAt: expect.any(Number) }] });
  });

  it("keeps a running turn and same-person steer on the earlier Creator; the next turn uses the new Creator", async () => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    const first = await (await f.worker("turn-lease", turn.lease)).json();
    await reassign(f.admin.id);
    expect((await f.worker("prompts/begin", turn.begin)).status).toBe(200);
    const missing = await f.send(f.prompt(randomUUID(), { chatId: "next" }), f.viewer);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: { code: "agent_login_required", loginRequiredFrom: "creator" } });
    const steer = await f.dispatch(f.prompt(randomUUID(), { mode: "steer" }), f.viewer);
    expect(steer.begun.contextId).toBe(turn.begun.contextId);
    expect(await (await f.worker("turn-lease", steer.lease)).json()).toEqual(first);
    const newPayer = await f.login(f.admin);
    const next = await f.dispatch(f.prompt(randomUUID(), { chatId: "next" }), f.viewer);
    expect((await (await f.worker("turn-lease", next.lease)).json()).agents.claude.apiKey).toBe(newPayer.secret);
    expect((await row(turn.begun.contextId)).selection.payer.userId).toBe(f.creator.id);
  });

  it("keeps an earlier Creator's turn after a later Creator leaves, while refusing new turns", async () => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    const first = await (await f.worker("turn-lease", turn.lease)).json();
    await reassign(f.admin.id);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.admin.id]));
    expect((await (await f.worker("turn-lease", turn.lease)).json()).agents).toEqual(first.agents);
    expect((await row(turn.begun.contextId)).state).toBe("active");
    const next = await f.send(f.prompt(randomUUID(), { chatId: "next" }), f.viewer);
    expect(next.status).toBe(409); expect(await next.json()).toMatchObject({ error: { code: "workspace_creator_required" } });
  });

  it("chooses the payer at dispatch for a queued message", async () => {
    const input = f.prompt(); expect((await f.send(input, f.viewer)).status).toBe(201);
    const payer = await f.login(f.admin); await reassign(f.admin.id);
    const begun = await begin(input); expect(begun.status).toBe(200);
    expect(await row((await begun.json()).contextId)).toMatchObject({ credential_id: payer.id, selection: { payer: { userId: f.admin.id } } });
  });

  it("persists the failed dispatch when a queued message's new Creator has no login", async () => {
    const input = f.prompt(); expect((await f.send(input, f.viewer)).status).toBe(201);
    await reassign(f.admin.id);
    const begun = await begin(input); expect(begun.status).toBe(409);
    expect(await begun.json()).toMatchObject({ error: { code: "agent_login_required", loginRequiredFrom: "creator" } });
    expect((await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, input.userMessageId])).rows[0].state).toBe("failed");
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn'", [f.workspace.id])).rowCount).toBe(0);
  });

  it("rechecks the Creator after the preflight selection without falling back or queuing", async () => {
    const choose = f.cp.execution.deps.logins.forWorkspace.bind(f.cp.execution.deps.logins);
    vi.spyOn(f.cp.execution.deps.logins, "forWorkspace").mockImplementationOnce(async (...args) => {
      const selection = await choose(...args); await reassign(f.admin.id); return selection;
    });
    const sent = await f.send(f.prompt(), f.viewer);
    expect(sent.status).toBe(409);
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it.each(["session", "github"])("does not treat the payer's %s loss as login loss", async change => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    await withSystemTx(pool, tx => change === "session"
      ? tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.creator.authentication.sessionId])
      : tx.query("UPDATE cloud_github_credentials SET generation=gen_random_uuid() WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id]));
    const renewed = await f.worker("execution-leases/renew", { contextIds: [turn.begun.contextId] });
    expect(await renewed.json()).toEqual({ leases: [{ contextId: turn.begun.contextId, expiresAt: expect.any(Number) }] });
  });

  it.each(["account", "disconnect", "rotation"])("cuts the pinned payer on %s even after Reassign", async change => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    await reassign(f.admin.id);
    await withSystemTx(pool, tx => change === "account"
      ? tx.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.creator.id])
      : change === "disconnect"
        ? tx.query("DELETE FROM cloud_agent_organization_connections WHERE owner_user_id=$1 AND org_id=$2", [f.creator.id, f.organizationId])
        : tx.query("UPDATE cloud_agent_credentials SET revision=revision+1 WHERE owner_user_id=$1", [f.creator.id]));
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(409);
  });

  it("keeps an old-format actor-owned context's original login after the upgrade", async () => {
    const own = await f.login(f.viewer); await reassign(f.viewer.id);
    const old = vi.spyOn(f.cp.execution.deps.logins, "forWorkspace").mockImplementation((_id, actor, agent, expected, tx) =>
      f.cp.execution.deps.logins.select(f.organizationId, actor, agent, expected, tx));
    const turn = await f.dispatch(f.prompt(), f.viewer); old.mockRestore();
    expect((await row(turn.begun.contextId)).selection).not.toHaveProperty("version");
    await reassign(f.creator.id);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    const leased = await f.worker("turn-lease", turn.lease); expect(leased.status).toBe(200);
    expect((await leased.json()).agents.claude.apiKey).toBe(own.secret);
  });

  it("refuses renewal after a clock-driven payer Hold with no notification", async () => {
    await f.cp.loginChanges.stop();
    for (let n = 0; n < 5; n++) {
      const id = randomUUID();
      await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role,created_at) VALUES($1,$2,'member',now()-interval '1 day')", [f.organizationId, id]);
    }
    await pool.query("UPDATE account_entitlements SET valid_until=clock_timestamp()+interval '2 seconds' WHERE user_id=$1", [f.creator.id]);
    const turn = await f.dispatch(f.prompt(), f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    await expect.poll(async () => (await withSystemTx(pool, tx => tx.query("SELECT organization_member_on_hold($1,$2,10,5) AS held", [f.organizationId,f.creator.id]))).rows[0].held,
      { timeout: 4000 }).toBe(true);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", has_material: true });
    expect(await (await f.worker("execution-leases/renew", { contextIds: [turn.begun.contextId] })).json())
      .toEqual({ leases: [{ contextId: turn.begun.contextId, refused: "actor_changed" }] });
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
  });

  it("blocks an N-1 dispatch that would newly fund B's turn with B's login in A's workspace", async () => {
    await f.login(f.viewer);
    const input = f.prompt(); expect((await f.send(input, f.viewer)).status).toBe(201);
    vi.spyOn(f.cp.execution.deps.logins, "forWorkspace").mockImplementation((_id, actor, agent, expected, tx) =>
      f.cp.execution.deps.logins.select(f.organizationId, actor, agent, expected, tx));
    const begun = await begin(input); expect(begun.status).toBe(500);
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn'", [f.workspace.id])).rowCount).toBe(0);
  });

  it("cuts the payer under an N-1 membership writer whose workspace rows are hidden", async () => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rowCount).toBe(0);
      expect((await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id])).rowCount).toBe(1);
      await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
  });
});
