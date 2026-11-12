import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("execution leases and idle stop", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const ageActivity = () => pool.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [f.workspace.id]);
  const before = () => new Date(Date.now() - 15 * 60_000);
  const idle = async () => (await f.cp.store.idleSince(before())).some(row => row.id === f.workspace.id);
  const setupDone = async () => {
    const id = (await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='bootstrap'", [f.workspace.id])).rows[0].id;
    expect((await f.worker(`execution-leases/${id}/retired`, { retirementId: randomUUID(), reason: "setup_done", processes: 0 })).status).toBe(200);
  };

  it("keeps a live bootstrap from being stopped during setup", async () => {
    await ageActivity();
    expect(await idle()).toBe(false);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("running");
    await setupDone();
    expect(await idle()).toBe(true);
  });

  it("rechecks a newly forwarded operation without keeping idle clients or shells awake", async () => {
    await setupDone();
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const grant = await f.cp.store.consumeConnectTicket((await response.json()).protocols[1].slice(7), f.workspace.id);
    const clientId = randomUUID(), handle = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, { type: "PTY_CREATE", id: "terminal", sessionId: "terminal" });
    expect((await f.worker("terminal-lease", { clientId, requestId: "terminal", terminalId: "terminal" })).status).toBe(200);
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND operation='terminal.create'", [f.workspace.id]);
    await f.cp.execution.maintenance.publish(f.workspace.id, async () => {});
    await ageActivity();
    expect(await idle()).toBe(true);
    await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, { type: "WORKSPACE_REQUEST", id: "write", op: "file.write" });
    const operation = await f.worker("client-lease", { clientId, requestId: "write", operation: "file.write" });
    expect(operation.status).toBe(200);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("running");
    expect(await idle()).toBe(false);
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [(await operation.json()).contextId]);
    expect(await idle()).toBe(true);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("stopping");
  });
});
