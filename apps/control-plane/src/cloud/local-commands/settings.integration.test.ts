import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localCommandsFixture, type LocalCommandsFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("organization local-command setting through the router and PostgreSQL", () => {
  let pool: pg.Pool, f: LocalCommandsFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL,max: 7,statement_timeout: 3000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => { f = await localCommandsFixture(pool); });
  afterEach(() => f.signals.close());
  const setting = (method = "GET",body?: unknown,userId?: string,organizationId = f.organizationId) =>
    f.call(`/v1/cloud-v2/organizations/${organizationId}/local-commands`,method,body,userId ? { "x-test-actor": userId } : {});

  it("defaults on, lets members read and limits writes to the current owner or admin", async () => {
    const first = await setting(); expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store"); expect(await first.json()).toEqual({ localCommandsEnabled: true });
    expect((await setting("GET",undefined,f.other.id)).status).toBe(200);
    expect((await setting("PUT",{ localCommandsEnabled: false },f.other.id)).status).toBe(403);
    expect((await setting("PUT",{ localCommandsEnabled: false,extra: true })).status).toBe(400);
    expect((await setting("PUT")).status).toBe(400);
    expect(await (await setting("PUT",{ localCommandsEnabled: false })).json()).toEqual({ localCommandsEnabled: false });
    await pool.query("UPDATE organization_members SET role='admin' WHERE org_id=$1 AND user_id=$2",[f.organizationId,f.other.id]);
    expect(await (await setting("PUT",{ localCommandsEnabled: true },f.other.id)).json()).toEqual({ localCommandsEnabled: true });
    expect((await f.store.get(f.workspaceId,f.owner.id)).state).toBe("stopped");
  });

  it("hides foreign organizations and revokes reads and writes with the session", async () => {
    expect((await setting("GET",undefined,undefined,randomUUID())).status).toBe(404);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",[f.organizationId,f.other.id]);
    expect((await setting("GET",undefined,f.other.id)).status).toBe(404);
    expect((await setting("PUT",{ localCommandsEnabled: false },f.other.id)).status).toBe(404);
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[f.owner.authentication.sessionId]);
    expect((await setting()).status).toBe(401);
    expect((await setting("PUT",{ localCommandsEnabled: false })).status).toBe(401);
  });

  it("reads without a mutation lock and rechecks an admin removed while a write waits", async () => {
    const tx = await pool.connect(); let waiting: Promise<Response> | undefined;
    try {
      await tx.query("BEGIN"); await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[f.organizationId]);
      expect((await setting()).status).toBe(200);
      waiting = setting("PUT",{ localCommandsEnabled: false });
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%organizations%'`)).rowCount).toBeGreaterThan(0));
      await tx.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2",[f.organizationId,f.owner.id]);
      await tx.query("COMMIT"); expect((await waiting).status).toBe(403);
      expect(await (await setting()).json()).toEqual({ localCommandsEnabled: true });
    } finally { await tx.query("ROLLBACK"); tx.release(); await waiting; }
  });

  it("disables pending and claimed requests, refreshes configuration, and never wakes a stopped workspace", async () => {
    const mac = await f.register(); await f.submit(f.prompt(),mac.headers);
    const token = await f.store.rotateWorkerToken(f.workspaceId),boot = randomUUID();
    await f.store.acceptWorkerHello(token,boot);
    await pool.query("UPDATE cloud_v2_workspaces SET local_command_boot_ids=ARRAY[$2::uuid] WHERE id=$1",[f.workspaceId,boot]);
    const commands = [randomUUID(),randomUUID()];
    for (const requestId of commands) await f.requests.create(token,boot,{ requestId,chatId: "chat",executionId: "execution",input: { command: "x" } });
    await f.requests.claim(f.owner,mac.device,commands[0]!,"approve");
    const revision = await f.store.loginRevision(f.workspaceId);
    const disabled = await setting("PUT",{ localCommandsEnabled: false }); expect(disabled.status).toBe(200);
    expect(await f.store.loginRevision(f.workspaceId)).not.toBe(revision);
    for (const id of commands) expect((await f.requests.read(token,boot,id)).receipt.result?.outcome).toBe("disabled");
    await expect(f.requests.claim(f.owner,mac.device,commands[1]!,"approve")).rejects.toMatchObject({ code: "local_command_not_pending" });
    expect((await f.requests.create(token,boot,{ requestId: randomUUID(),chatId: "chat",executionId: "execution",input: { command: "x" } })).receipt.result)
      .toEqual({ outcome: "disabled" });
    await f.store.transition(f.workspaceId,["running"],"stopped");
    await setting("PUT",{ localCommandsEnabled: true });
    expect((await f.store.get(f.workspaceId,f.owner.id)).state).toBe("stopped");
  });
});
