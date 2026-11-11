import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localCommandsFixture, type LocalCommandsFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("local command sender binding through prompts", () => {
  let pool: pg.Pool, f: LocalCommandsFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 3000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => { f = await localCommandsFixture(pool); });
  afterEach(() => f.signals.close());
  const sender = async () => (await pool.query(`SELECT creator_user_id,sender_device_id,sender_registration_id,sender_binding_generation::text
    FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 ORDER BY sequence DESC LIMIT 1`, [f.workspaceId])).rows[0];

  it("records the verified desktop beside the prompt and auto-connects it without changing payload", async () => {
    const mac = await f.register(), input = f.prompt();
    expect((await f.submit(input, mac.headers)).status).toBe(201);
    expect(await sender()).toMatchObject({ creator_user_id: f.owner.id, sender_device_id: mac.device.deviceId,
      sender_registration_id: mac.device.registrationId, sender_binding_generation: "0" });
    expect((await pool.query("SELECT payload FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspaceId])).rows[0].payload).toEqual(input);
    expect((await (await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/macs`)).json()).macs[0]).toMatchObject({ active: true, connected: true });
  });

  it("verifies all supplied headers and refuses foreign or stale registrations", async () => {
    const mac = await f.register(), foreign = await f.register(undefined, f.other);
    expect((await f.submit(f.prompt(), { "x-zeros-device-id": mac.device.deviceId })).status).toBe(400);
    expect((await f.submit(f.prompt(), { ...foreign.headers, "x-test-actor": f.owner.id })).status).toBe(404);
    await f.register(mac.device.deviceId);
    expect((await f.submit(f.prompt(), mac.headers)).status).toBe(409);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_prompt_outbox")).rows[0].n).toBe(0);
  });

  it("never retargets or auto-connects another Mac on an idempotent replay", async () => {
    const first = await f.register(), second = await f.register(), input = f.prompt();
    expect((await f.submit(input, first.headers)).status).toBe(201);
    expect((await f.submit(input, second.headers)).status).toBe(200);
    expect((await sender()).sender_device_id).toBe(first.device.deviceId);
    expect((await pool.query("SELECT device_id FROM cloud_v2_connected_macs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ device_id: first.device.deviceId }]);
  });

  it("inherits the verified Mac across same-person API and headerless sends until another desktop moves it", async () => {
    const first = await f.register(), second = await f.register();
    expect((await f.submit(f.prompt(), first.headers)).status).toBe(201);
    const api = { chatId: "chat", userMessageId: "api-message", agentId: "codex" as const, message: "API fixture" };
    await f.store.prompts.enqueueApi(f.workspaceId, f.owner.id, api);
    expect(await sender()).toMatchObject({ creator_user_id: f.owner.id, sender_device_id: first.device.deviceId,
      sender_registration_id: first.device.registrationId, sender_binding_generation: "0" });
    expect((await f.submit()).status).toBe(201);
    expect((await sender()).sender_device_id).toBe(first.device.deviceId);
    expect((await f.submit(f.prompt(), second.headers)).status).toBe(201);
    expect((await f.store.prompts.enqueueApi(f.workspaceId, f.owner.id, api)).replay).toBe(true);
    expect((await f.submit()).status).toBe(201);
    expect(await sender()).toMatchObject({ sender_device_id: second.device.deviceId,
      sender_registration_id: second.device.registrationId, sender_binding_generation: "0" });
  });

  it("keeps the Mac for a new turn after chat Stop without reviving the cancelled prompt", async () => {
    const mac = await f.register(), prompt = f.prompt();
    expect((await f.submit(prompt, mac.headers)).status).toBe(201);
    expect(await f.store.prompts.stop(f.workspaceId, f.owner.id, "chat", "0")).toEqual({ chatId: "chat", epoch: "1" });
    expect((await f.submit()).status).toBe(201);
    expect((await sender()).sender_device_id).toBe(mac.device.deviceId);
    expect((await pool.query("SELECT cancel_requested,state,epoch::text FROM cloud_v2_prompt_outbox WHERE user_message_id=$1", [prompt.userMessageId])).rows[0])
      .toEqual({ cancel_requested: true, state: "cancelled", epoch: "0" });
    expect((await pool.query("SELECT epoch::text FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 ORDER BY sequence DESC LIMIT 1", [f.workspaceId])).rows[0].epoch).toBe("1");
  });

  it("does not invent a binding for a chat that has never had a desktop message", async () => {
    await f.register();
    expect((await f.submit()).status).toBe(201);
    expect(await sender()).toMatchObject({ sender_device_id: null, sender_registration_id: null, sender_binding_generation: null });
  });

  it("never inherits another person's binding or searches past a different sender", async () => {
    const own = await f.register(), other = await f.register(undefined, f.other);
    expect((await f.submit(f.prompt(), own.headers)).status).toBe(201);
    expect((await f.submit(f.prompt(), other.headers)).status).toBe(404);
    const previous = f.prompt(); expect((await f.submit(previous, own.headers)).status).toBe(201);
    // Model a persisted turn by another person without widening creator-only writes.
    await pool.query(`UPDATE cloud_v2_prompt_outbox SET creator_user_id=$2,sender_device_id=$3,sender_registration_id=$4
      WHERE user_message_id=$1`, [previous.userMessageId, f.other.id, other.device.deviceId, other.device.registrationId]);
    expect((await f.submit()).status).toBe(201);
    expect(await sender()).toMatchObject({ creator_user_id: f.owner.id, sender_device_id: null,
      sender_registration_id: null, sender_binding_generation: null });
  });

  it.each(["access", "legacy"])("does not revive a binding retired by %s authority", async change => {
    const mac = await f.register();
    expect((await f.submit(f.prompt(), mac.headers)).status).toBe(201);
    if (change === "legacy") await f.store.prompts.retireLocalSender(f.workspaceId, f.owner.id, "0", null);
    else await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [f.workspaceId]);
    expect((await f.submit()).status).toBe(201);
    expect(await sender()).toMatchObject({ sender_device_id: null, sender_registration_id: null, sender_binding_generation: null });
  });

  it("rechecks a desktop session after waiting for the enqueue mutation lock", async () => {
    const mac = await f.register(), tx = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      pending = f.submit(f.prompt(), mac.headers);
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%cloud_v2_workspaces%'`)).rowCount).toBeGreaterThan(0));
      await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]);
      await tx.query("COMMIT");
      expect((await pending).status).toBe(401);
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_prompt_outbox")).rows[0].n).toBe(0);
    } finally { await tx.query("ROLLBACK"); tx.release(); await pending; }
  });

  it("retires all legacy bindings on the control plane and fences stale relay authority", async () => {
    const mac = await f.register();
    await f.submit(f.prompt("one"), mac.headers); await f.submit(f.prompt("two"), mac.headers);
    await expect(f.store.prompts.retireLocalSender(f.workspaceId, f.owner.id, "99", f.owner.authentication.sessionId)).rejects.toMatchObject({ code: "session_revoked" });
    await f.store.prompts.retireLocalSender(f.workspaceId, f.owner.id, "0", f.owner.authentication.sessionId);
    expect((await pool.query("SELECT local_command_generation::text FROM cloud_v2_prompt_chats WHERE workspace_id=$1 ORDER BY chat_id", [f.workspaceId])).rows)
      .toEqual([{ local_command_generation: "1" }, { local_command_generation: "1" }]);
    expect((await sender()).sender_binding_generation).toBe("0");
  });
});
