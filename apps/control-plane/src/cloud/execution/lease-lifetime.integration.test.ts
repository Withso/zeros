import { randomUUID } from "node:crypto";
import pg from "pg";
import { withSystemTx } from "../../db.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const FLOOR = 25_000;
database("usable execution lifetimes through the real router", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const age = async (seconds: number, user = f.creator) => {
    await f.cp.execution.deps.authority.admit(f.workspace.id, user.id);
    await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-$3::int*interval '1 second'
      WHERE org_id=$1 AND owner_user_id=$2`, [f.organizationId, user.id, seconds]);
  };
  const expiry = async (id: string) => (await pool.query(`SELECT expires_at,extract(epoch FROM(expires_at-created_at))*1000 AS lifetime,
    extract(epoch FROM(expires_at-clock_timestamp()))*1000 AS remaining FROM cloud_v2_execution_contexts WHERE id=$1`, [id])).rows[0];
  const ticket = async (user = f.viewer) => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, user, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const reply = await response.json();
    const grant = await f.cp.store.consumeConnectTicket(reply.protocols[1].slice(7), f.workspace.id); expect(grant).not.toBeNull();
    return grant!;
  };
  const open = async (user = f.viewer) => {
    const grant = await ticket(user), clientId = randomUUID();
    return { clientId, context: await f.cp.execution.clients.open(f.workspace.id, clientId, grant) };
  };
  const operation = async (client: Awaited<ReturnType<typeof open>>, op: string) => {
    const requestId = randomUUID();
    await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "WORKSPACE_REQUEST", id: requestId, op });
    const response = await f.worker("client-lease", { clientId: client.clientId, requestId, operation: op });
    expect(response.status).toBe(200); return response.json();
  };
  const terminal = async (client: Awaited<ReturnType<typeof open>>) => {
    const requestId = randomUUID(), terminalId = randomUUID();
    await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "PTY_CREATE", id: requestId, sessionId: terminalId });
    const response = await f.worker("terminal-lease", { clientId: client.clientId, requestId, terminalId });
    expect(response.status).toBe(200); return response.json();
  };

  it("reverifies a cached tail before issuing a client handle", async () => {
    await age(21, f.viewer);
    const client = await open();
    expect(Number((await expiry(client.context.contextId)).lifetime)).toBeGreaterThanOrEqual(FLOOR);
  });

  it("issues a turn with a usable lifetime even when admission saw an old source cache", async () => {
    await age(21);
    const turn = await f.dispatch();
    expect(Number((await expiry(turn.begun.contextId)).lifetime)).toBeGreaterThanOrEqual(FLOOR);
  });

  it.each(["file.write", "git.commit", "codeReview.create", "codeReview.reply", "codeReview.setResolved"])("refreshes a short continuation before the %s operation", async op => {
    const client = await open(); await age(3591, f.viewer);
    const lease = await operation(client, op);
    expect(lease.expiresAt - Date.now()).toBeGreaterThanOrEqual(FLOOR);
  });

  it("refreshes a short continuation before terminal issuance", async () => {
    const client = await open(); await age(3591, f.viewer);
    const lease = await terminal(client);
    expect(lease.expiresAt - Date.now()).toBeGreaterThanOrEqual(FLOOR);
  });

  it("uses a fresh proof when renewing would shorten a handle below the floor", async () => {
    const client = await open(); await age(3591, f.viewer);
    const response = await f.worker("execution-leases/renew", { contextIds: [client.context.contextId] });
    expect(response.status).toBe(200);
    expect((await response.json()).leases[0].expiresAt - Date.now()).toBeGreaterThanOrEqual(FLOOR);
  });

  it("refreshes a live parent's deadline for steering without replacing its identity", async () => {
    const turn = await f.dispatch();
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()+interval '9 seconds' WHERE id=$1", [turn.begun.contextId]));
    const steer = await f.dispatch(f.prompt(randomUUID(), { mode: "steer" }));
    expect(steer.begun.contextId).toBe(turn.begun.contextId);
    const response = await f.worker("turn-lease", steer.lease); expect(response.status).toBe(200);
    expect((await response.json()).expiresAt - Date.now()).toBeGreaterThanOrEqual(FLOOR);
  });

  it("does not deliver a short lease when time passed between turn dispatch and material delivery", async () => {
    const turn = await f.dispatch();
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()+interval '9 seconds' WHERE id=$1", [turn.begun.contextId]));
    const response = await f.worker("turn-lease", turn.lease); expect(response.status).toBe(200);
    expect((await response.json()).expiresAt - Date.now()).toBeGreaterThanOrEqual(FLOOR);
  });

  it("refuses a short desktop-token ceiling without issuing a context or extending the token", async () => {
    const grant = await ticket(); grant.execution!.tokenEnd = Date.now() + 9000;
    await expect(f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant)).rejects.toMatchObject({ status: 503 });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='client'", [f.workspace.id])).rowCount).toBe(0);
  });

  it("refuses when both observations are short instead of extending a proof at insert", async () => {
    const grant = await ticket(), original = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
    const admit = vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementation(async (...args) => ({ ...(await original(...args)), until: Date.now() + 9000 }));
    await expect(f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant)).rejects.toMatchObject({ status: 503 });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='client'", [f.workspace.id])).rowCount).toBe(0);
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("rolls back a renewal whose final proof is too short and retains the original deadline", async () => {
    const client = await open(), before = await expiry(client.context.contextId);
    const original = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
    const admit = vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementation(async (...args) => ({ ...(await original(...args)), until: Date.now() + 9000 }));
    expect((await f.worker("execution-leases/renew", { contextIds: [client.context.contextId] })).status).toBe(503);
    expect((await expiry(client.context.contextId)).expires_at).toEqual(before.expires_at);
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("rolls back a new handle and obtains a new proof after the final check consumes its budget", async () => {
    const grant = await ticket(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const assert = f.cp.execution.assertContext.bind(f.cp.execution);
    vi.spyOn(f.cp.execution, "assertContext").mockImplementationOnce(async (...args) => {
      const row = await assert(...args); entered.resolve(); await release.promise; return row;
    });
    const pending = f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant);
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("final authority check was not held"); })]);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    } finally { release.resolve(); }
    const context = await pending;
    expect(context.expiresAt - Date.now()).toBeGreaterThanOrEqual(FLOOR);
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='client'", [f.workspace.id])).rowCount).toBe(1);
  });

  it("does not commit material or tokens after materialization consumes the usable budget", async () => {
    const turn = await f.dispatch(), before = await expiry(turn.begun.contextId);
    const material = f.cp.execution.deps.material;
    vi.spyOn(f.cp.execution.deps, "material").mockImplementation(async (...args) => {
      const value = await material(...args);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000); return value;
    });
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(503);
    const row = (await pool.query(`SELECT material,expires_at,
      (SELECT count(*)::int FROM cloud_v2_execution_tokens WHERE context_id=c.id) AS tokens
      FROM cloud_v2_execution_contexts c WHERE id=$1`, [turn.begun.contextId])).rows[0];
    expect(row).toMatchObject({ material: null, tokens: 0, expires_at: before.expires_at });
  });
});
