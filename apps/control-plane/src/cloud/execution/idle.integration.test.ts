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
  const openClient = async () => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const reply = await response.json();
    const grant = await f.cp.store.consumeConnectTicket(reply.protocols[1].slice(7), f.workspace.id);
    const clientId = randomUUID(), handle = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    return { reply, clientId, handle };
  };

  it("keeps a live bootstrap from being stopped during setup", async () => {
    await ageActivity();
    expect(await idle()).toBe(false);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("running");
    await setupDone();
    expect(await idle()).toBe(true);
  });

  it("announces relay presence and rechecks a connection opened after idle discovery", async () => {
    await setupDone(); await ageActivity();
    expect(await idle()).toBe(true);
    const { reply, clientId, handle } = await openClient();
    expect(reply.features).toEqual(["relay-presence-v1"]);
    expect(handle.expiresAt - Date.now()).toBeLessThanOrEqual(30_000);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("running");
    expect(await idle()).toBe(false);
    await f.cp.execution.clients.close(f.workspace.id, clientId);
    expect(await idle()).toBe(true);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("stopping");
  });

  it.each([
    ["unrenewed lease", "expires_at=clock_timestamp()-interval '1 second'"],
    ["expired authentication", "client_token_expires_at=clock_timestamp()-interval '1 second'"],
    ["old boot", "worker_boot_id=gen_random_uuid()"],
    ["old epoch", "access_epoch=access_epoch+1"],
    ["old stop generation", "stop_generation=stop_generation+1"],
    ["rotated worker token", "worker_token_hash=decode(repeat('00',32),'hex')"],
    ["sync handle", "sync_device_id=gen_random_uuid(),sync_registration_id=gen_random_uuid(),sync_instance_id=gen_random_uuid(),sync_connected_at=clock_timestamp()"],
  ])("does not retain relay presence with %s", async (_name, update) => {
    await setupDone();
    const { handle } = await openClient();
    await ageActivity();
    expect(await idle()).toBe(false);
    await pool.query(`UPDATE cloud_v2_execution_contexts SET ${update} WHERE id=$1`, [handle.contextId]);
    expect(await idle()).toBe(true);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("stopping");
  });

  it.each(["membership", "session"])("ends presence when %s is revoked", async kind => {
    await setupDone();
    await openClient(); await ageActivity();
    expect(await idle()).toBe(false);
    if (kind === "membership")
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    else await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId]);
    expect(await idle()).toBe(true);
  });

  it("keeps admitted operations awake without counting a disconnected terminal shell", async () => {
    await setupDone();
    const { clientId, handle } = await openClient();
    await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, { type: "PTY_CREATE", id: "terminal", sessionId: "terminal" });
    expect((await f.worker("terminal-lease", { clientId, requestId: "terminal", terminalId: "terminal" })).status).toBe(200);
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND operation='terminal.create'", [f.workspace.id]);
    await f.cp.execution.maintenance.publish(f.workspace.id, async () => {});
    await ageActivity();
    expect(await idle()).toBe(false);
    await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, { type: "WORKSPACE_REQUEST", id: "write", op: "file.write" });
    const operation = await f.worker("client-lease", { clientId, requestId: "write", operation: "file.write" });
    expect(operation.status).toBe(200);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("running");
    expect(await idle()).toBe(false);
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [(await operation.json()).contextId]);
    expect(await idle()).toBe(false);
    await f.cp.execution.clients.close(f.workspace.id, clientId);
    expect(await idle()).toBe(true);
    await f.cp.store.stopIdle(f.workspace.id, before());
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("stopping");
  });
});
