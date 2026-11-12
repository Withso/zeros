import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("activated turns use the Creator's selected agent login", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const row = async (id: string) => (await pool.query("SELECT * FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0];
  const turn = (user = f.viewer, extra: Record<string, unknown> = {}) => f.dispatch(f.prompt(randomUUID(), { chatId: randomUUID(), ...extra }), user);
  const noWork = async () => {
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn'", [f.workspace.id])).rows[0].n).toBe(0);
  };
  const client = async () => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const { protocols } = await response.json();
    const grant = await f.cp.store.consumeConnectTicket(protocols[1].slice(7), f.workspace.id);
    const clientId = randomUUID(), context = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    await f.cp.execution.clients.forward(f.workspace.id, context.contextId, { type: "PTY_CREATE", id: "terminal", sessionId: "terminal" });
    const terminal = await f.worker("terminal-lease", { clientId, requestId: "terminal", terminalId: "terminal" });
    expect(terminal.status).toBe(200);
    return { clientId, contextId: context.contextId, terminal: await terminal.json() };
  };

  it("runs B without an agent login as B, using A's selected login only", async () => {
    const payer = await f.login();
    await pool.query("UPDATE account_entitlements SET status='cancelled',cloud_workspaces_allowed=false WHERE user_id=$1", [f.viewer.id]);
    const sent = await turn();
    const leased = await f.worker("turn-lease", sent.lease);
    expect(leased.status).toBe(200);
    expect(await leased.json()).toMatchObject({ userId: f.viewer.id, agents: { claude: { apiKey: payer.secret } } });
    expect(await row(sent.begun.contextId)).toMatchObject({ user_id: f.viewer.id, credential_id: payer.id,
      selection: { version: 2, payer: { userId: f.creator.id }, credentialId: payer.id } });
    expect(sent.begun.actingUser.userId).toBe(f.viewer.id);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_organization_connections WHERE owner_user_id=$1", [f.viewer.id])).rows[0].n).toBe(0);
  });

  it.each(["self", "creator"] as const)("identifies who must connect (%s) with no saved or leased work", async from => {
    const response = await f.send(f.prompt(), from === "self" ? f.creator : f.viewer);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "agent_login_required", agent: "claude", loginRequiredFrom: from } });
    await noWork();
  });

  it("never falls back to the sender's own agent login", async () => {
    await f.login(f.viewer);
    const response = await f.send(f.prompt(), f.viewer);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "agent_login_required", loginRequiredFrom: "creator" } });
    await noWork();
  });

  it("refuses turns with an ineligible Creator but still allows B's terminal and file operations", async () => {
    await f.login(f.viewer);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    const response = await f.send(f.prompt(), f.viewer);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "workspace_creator_required" } });
    await noWork();
    const opened = await client();
    await f.cp.execution.clients.forward(f.workspace.id, opened.contextId, { type: "WORKSPACE_REQUEST", id: "write", op: "file.write" });
    expect((await f.worker("client-lease", { clientId: opened.clientId, requestId: "write", operation: "file.write" })).status).toBe(200);
  });

  it("publishes only the current Creator's availability to capable active workers", async () => {
    await f.login(f.creator, "claude"); await f.login(f.viewer, "cursor");
    const old = await f.worker("config", undefined, { method: "GET" });
    expect(old.status).toBe(200); expect((await old.json()).config).not.toHaveProperty("agentLogins");
    const capable = await f.worker("config", undefined, { method: "GET", features: `${f.features},creator-agent-logins-v1` });
    expect(capable.status).toBe(200);
    expect((await capable.json()).config).toMatchObject({ agents: {}, agentLogins: { claude: true } });
  });

  it("cuts B's A-funded turn on A's membership loss without cutting B's other contexts or the VM", async () => {
    await f.login(); await f.login(f.viewer);
    const sent = await turn(), opened = await client();
    expect((await f.worker("turn-lease", sent.lease)).status).toBe(200);
    const state = async () => (await pool.query("SELECT state,access_epoch,worker_token_hash,worker_boot_id,stop_generation FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    const before = await state();
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    expect(await row(sent.begun.contextId)).toMatchObject({ state: "revoked", material: null });
    expect(await state()).toEqual(before);
    const renewed = await f.worker("execution-leases/renew", { contextIds: [opened.contextId, opened.terminal.contextId] });
    expect(await renewed.json()).toEqual({ leases: [
      { contextId: opened.contextId, expiresAt: expect.any(Number) }, { contextId: opened.terminal.contextId, expiresAt: expect.any(Number) },
    ] });
    await withSystemTx(pool, tx => tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [f.organizationId, f.creator.id]));
    expect((await f.worker("turn-lease", sent.lease)).status).toBe(409);
  });

  it("does not cut an A-funded B turn when B disconnects their unused login", async () => {
    await f.login(); await f.login(f.viewer);
    const sent = await turn();
    expect((await f.worker("turn-lease", sent.lease)).status).toBe(200);
    await withSystemTx(pool, tx => tx.query("DELETE FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.viewer.id]));
    const renewed = await f.worker("execution-leases/renew", { contextIds: [sent.begun.contextId] });
    expect(await renewed.json()).toEqual({ leases: [{ contextId: sent.begun.contextId, expiresAt: expect.any(Number) }] });
  });
});
