import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("acting-user live client authority", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool, { teamOwnership: true }); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const open = async (user = f.viewer) => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, user, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const { protocols } = await response.json();
    const grant = await f.cp.store.consumeConnectTicket(protocols[1].slice(7), f.workspace.id); expect(grant).not.toBeNull();
    const clientId = randomUUID(), context = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    return { clientId, context, grant: grant! };
  };

  it("allows members to connect without agent credentials and binds every operation to its forwarded request", async () => {
    const client = await open();
    expect(client.context.userId).toBe(f.viewer.id);
    const input = { clientId: client.clientId, requestId: "commit", operation: "git.commit" };
    expect((await f.worker("client-lease", input)).status).toBe(409);
    await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "WORKSPACE_REQUEST", id: "commit", op: "git.commit" });
    const response = await f.worker("client-lease", input); expect(response.status).toBe(200);
    const lease = await response.json(); expect(lease.userId).toBe(f.viewer.id);
    expect(lease.gitIdentity.name).toBe("fixture");
    for (const field of ["agents", "api", "environment", "mcpServers"]) expect(lease).not.toHaveProperty(field);
    expect(await (await f.worker("client-lease", input)).json()).toEqual(lease);
    expect((await f.worker("client-lease", { ...input, operation: "git.push" })).status).toBe(409);
    expect((await f.worker("client-lease", { ...input, clientId: randomUUID() })).status).toBe(409);
  });

  it("keeps a terminal with its opener across EOF and cannot transfer it to another member", async () => {
    const first = await open(), input = { clientId: first.clientId, requestId: "open-terminal", terminalId: "terminal" };
    await f.cp.execution.clients.forward(f.workspace.id, first.context.contextId, { type: "PTY_CREATE", id: input.requestId, sessionId: input.terminalId });
    const response = await f.worker("terminal-lease", input); expect(response.status).toBe(200);
    const lease = await response.json(); expect(lease.userId).toBe(f.viewer.id);
    expect(lease.api.token).toMatch(/^zw2x_/); expect(lease).not.toHaveProperty("agents");
    await f.cp.execution.clients.close(f.workspace.id, first.clientId);
    expect((await (await f.worker("execution-leases/renew", { contextIds: [lease.contextId] })).json()).leases[0]).not.toHaveProperty("refused");
    const next = await open();
    await f.cp.execution.clients.forward(f.workspace.id, next.context.contextId, { type: "PTY_CREATE", id: "reattach", sessionId: "terminal" });
    expect((await (await f.worker("terminal-lease", { ...input, clientId: next.clientId, requestId: "reattach" })).json()).contextId).toBe(lease.contextId);
    const other = await open(f.creator);
    await expect(f.cp.execution.clients.forward(f.workspace.id, other.context.contextId, { type: "PTY_CREATE", id: "adopt", sessionId: "terminal" })).rejects.toMatchObject({ code: "actor_changed" });
    await expect(f.cp.execution.clients.forward(f.workspace.id, other.context.contextId, { type: "PTY_WRITE", sessionId: "terminal", data: "forbidden" })).rejects.toMatchObject({ code: "actor_changed" });
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId]);
    expect((await (await f.worker("execution-leases/renew", { contextIds: [lease.contextId] })).json()).leases[0]).toHaveProperty("refused");
  });

  it("expires a client handle with the desktop token while leaving its terminal alive", async () => {
    const client = await open();
    await pool.query("UPDATE cloud_v2_execution_contexts SET client_token_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [client.context.contextId]);
    await expect(f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "WORKSPACE_REQUEST", id: "read", op: "files.read" })).rejects.toMatchObject({ code: "actor_changed" });
  });

  it("keeps personal terminals, files and Git usable without a Creator while refusing agent turns", async () => {
    const client = await open();
    const before = (await pool.query("SELECT state,worker_token_hash,access_epoch,stop_generation FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    expect((await pool.query("SELECT creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].creator_user_id).toBeNull();
    const turn = await f.send(f.prompt(), f.viewer);
    expect(turn.status).toBe(409); expect(await turn.json()).toMatchObject({ error: { code: "workspace_creator_required" } });
    await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "PTY_CREATE", id: "terminal", sessionId: "terminal" });
    const opened = await f.worker("terminal-lease", { clientId: client.clientId, requestId: "terminal", terminalId: "terminal" });
    expect(opened.status).toBe(200);
    const terminal = await opened.json(); expect(terminal.userId).toBe(f.viewer.id); expect(terminal).not.toHaveProperty("agents");
    for (const operation of ["file.write", "git.commit", "git.push"]) {
      await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "WORKSPACE_REQUEST", id: operation, op: operation });
      const response = await f.worker("client-lease", { clientId: client.clientId, requestId: operation, operation });
      expect(response.status).toBe(200);
      const lease = await response.json(); expect(lease.userId).toBe(f.viewer.id);
      if (operation === "git.push") {
        const token = await f.worker("github-token", { contextId: lease.contextId, purpose: "git" });
        expect(token.status).toBe(200); expect((await token.json()).token).toBe(`synthetic-${f.viewer.id}`);
      }
    }
    const renewed = await f.worker("execution-leases/renew", { contextIds: [client.context.contextId, terminal.contextId] });
    expect((await renewed.json()).leases).toEqual([
      { contextId: client.context.contextId, expiresAt: expect.any(Number) }, { contextId: terminal.contextId, expiresAt: expect.any(Number) },
    ]);
    expect((await pool.query("SELECT state,worker_token_hash,access_epoch,stop_generation FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0]).toEqual(before);
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/stop`, "POST", {}, f.viewer, { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" })).status).toBe(202);
  });

  it("retires a closed handle but retains an operation's cleanup barrier and recent receipt", async () => {
    const client = await open();
    await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "WORKSPACE_REQUEST", id: "write", op: "file.write" });
    const response = await f.worker("client-lease", { clientId: client.clientId, requestId: "write", operation: "file.write" });
    expect(response.status).toBe(200); const operation = await response.json();
    await f.cp.execution.clients.close(f.workspace.id, client.clientId);
    const state = async (id: string) => (await pool.query("SELECT state,reason FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0];
    expect(await state(client.context.contextId)).toEqual({ state: "retired", reason: "client_closed" });
    expect(await state(operation.contextId)).toEqual({ state: "revoked", reason: "client_closed" });
    await pool.query("UPDATE cloud_v2_execution_contexts SET retired_at=clock_timestamp()-interval '8 days' WHERE id=$1", [client.context.contextId]);
    await f.cp.execution.maintenance.sweep(async () => {});
    expect(await state(client.context.contextId)).toBeDefined(); expect(await state(operation.contextId)).toBeDefined();
    expect((await f.worker(`execution-leases/${operation.contextId}/retired`, { retirementId: randomUUID(), reason: "operation_done", processes: 0 })).status).toBe(200);
    await f.cp.execution.maintenance.sweep(async () => {});
    expect(await state(operation.contextId)).toMatchObject({ state: "retired" });
    await pool.query("UPDATE cloud_v2_execution_contexts SET retired_at=clock_timestamp()-interval '8 days' WHERE id=$1", [operation.contextId]);
    await f.cp.execution.maintenance.sweep(async () => {});
    expect(await state(client.context.contextId)).toBeUndefined(); expect(await state(operation.contextId)).toBeUndefined();
  });

  it("retires expired handles and terminal-create receipts after publishing their revocation", async () => {
    const client = await open();
    await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "PTY_CREATE", id: "terminal", sessionId: "terminal" });
    const response = await f.worker("terminal-lease", { clientId: client.clientId, requestId: "terminal", terminalId: "terminal" });
    expect(response.status).toBe(200); const terminal = await response.json();
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND kind='client'", [f.workspace.id]);
    const published: string[] = [];
    await f.cp.execution.maintenance.publish(f.workspace.id, async (_id, frames) => { published.push(...frames.map(frame => frame.contextId)); });
    expect(published).toContain(client.context.contextId);
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='client'", [f.workspace.id])).rows)
      .toEqual([{ state: "retired" }, { state: "retired" }]);
    expect((await (await f.worker("execution-leases/renew", { contextIds: [terminal.contextId] })).json()).leases[0]).not.toHaveProperty("refused");
  });

  it("rejects a connect ticket after Stop and refuses legacy prompt frames in an activated client", async () => {
    const client = await open();
    await expect(f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "AGENT_PROMPT", id: "legacy" })).rejects.toMatchObject({ code: "client_update_required" });
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    const { protocols } = await response.json();
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id]);
    expect(await f.cp.store.consumeConnectTicket(protocols[1].slice(7), f.workspace.id)).toBeNull();
  });
});
