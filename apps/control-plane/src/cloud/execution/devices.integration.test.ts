import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("local commands and notifications follow the active turn's person", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.login(f.viewer); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  async function register(user = f.creator) {
    const deviceId = randomUUID(), response = await f.call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", { requestId: randomUUID(), name: user.id, capabilities: ["local-commands-v1"] }, user);
    expect(response.status).toBe(200);
    const { device } = await response.json();
    return { deviceId, headers: { "X-Zeros-Device-Id": deviceId, "X-Zeros-Device-Registration": device.registrationId, "X-Zeros-Device-Instance": device.instanceId } };
  }
  const send = (input: ReturnType<ExecutionFixture["prompt"]>, user: ExecutionFixture["creator"], headers: Record<string, string>) =>
    f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts`, "POST", input, user, { ...headers, "X-Zeros-Team-Sharing": "1" });
  const command = (contextId: string, requestId = randomUUID(), mac?: string) => f.worker("local-commands", {
    requestId, contextId, chatId: "chat", executionId: "native-session", input: { command: "true", ...(mac ? { mac } : {}) },
  });
  const end = async (turn: Awaited<ReturnType<ExecutionFixture["dispatch"]>>) => {
    expect((await f.worker("prompts/outcome", { userMessageId: turn.input.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed" })).status).toBe(200);
    expect((await f.worker(`execution-leases/${turn.begun.contextId}/retired`, { retirementId: randomUUID(), reason: "outcome", processes: 0 })).status).toBe(200);
  };

  it("keeps A's commands and notification target when B queues, then restores each person's own Mac", async () => {
    const aMac = await register(), bMac = await register(f.viewer), first = f.prompt();
    expect((await send(first, f.creator, aMac.headers)).status).toBe(201);
    const a = await f.dispatch(first), requestId = randomUUID();
    const created = await command(a.begun.contextId, requestId); expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ requestId, state: "pending", mac: f.creator.id });
    const second = f.prompt(); expect((await send(second, f.viewer, bMac.headers)).status).toBe(201);
    const pending = await f.worker(`local-commands/${requestId}`, undefined, { method: "GET" });
    expect(pending.status).toBe(200); expect(await pending.json()).toMatchObject({ state: "pending", mac: f.creator.id });
    const notificationId = randomUUID();
    const notification = await f.worker("notifications", { notificationId, contextId: a.begun.contextId, chatId: "chat", userMessageId: first.userMessageId,
      executionId: "native-session", kind: "review", title: "Finished", message: "Your turn is ready" });
    expect(notification.status).toBe(202);
    expect((await pool.query("SELECT sender_user_id,context_id FROM cloud_v2_notifications WHERE notification_id=$1", [notificationId])).rows[0])
      .toEqual({ sender_user_id: f.creator.id, context_id: a.begun.contextId });
    await end(a);
    expect((await (await f.worker(`local-commands/${requestId}`, undefined, { method: "GET" })).json()).result.outcome).toBe("cancelled");
    const b = await f.dispatch(second, f.viewer); expect((await command(b.begun.contextId)).status).toBe(201); await end(b);
    const again = await f.dispatch(f.prompt());
    const response = await command(again.begun.contextId); expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ state: "pending", mac: f.creator.id });
  });

  it("gives no target to a person who never sent a desktop-bound message, even with an explicit Mac", async () => {
    const aMac = await register(); await register(f.viewer);
    const input = f.prompt(); expect((await send(input, f.creator, aMac.headers)).status).toBe(201);
    const a = await f.dispatch(input); await end(a);
    const b = await f.dispatch(f.prompt(), f.viewer), response = await command(b.begun.contextId, randomUUID(), f.viewer.id);
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ state: "terminal", result: { outcome: "no_target" } });
    const stored = (await pool.query("SELECT sender_device_id FROM cloud_v2_execution_contexts WHERE id=$1", [b.begun.contextId])).rows[0];
    expect(stored.sender_device_id).toBeNull();
  });

  it("refuses missing, foreign or stale context identities rather than taking the latest queued sender", async () => {
    const a = await f.dispatch(), unrelated = await f.dispatch(f.prompt(randomUUID(), { chatId: "elsewhere" }), f.viewer);
    for (const contextId of [undefined, randomUUID(), unrelated.begun.contextId]) {
      const response = await f.worker("local-commands", { requestId: randomUUID(), contextId, chatId: "chat", executionId: "native-session", input: { command: "true" } });
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "actor_changed" } });
    }
    await end(a);
    const response = await command(a.begun.contextId); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "actor_changed" } });
  });
});
