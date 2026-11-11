import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("begin-time actors through the real desktop and worker routes", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("delivers no Creator-wide credentials on an activated boot", async () => {
    await f.login(); await f.activate();
    const response = await f.hello(); expect(response.status).toBe(200);
    const { config } = await response.json();
    expect(config).toMatchObject({ actingUser: 1, agents: {}, gitIdentity: null });
    expect(config.bootstrapContextId).toEqual(expect.any(String));
    for (const field of ["api", "environment", "mcpServers", "codeReview"]) expect(config).not.toHaveProperty(field);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_tokens WHERE workspace_id=$1 AND kind IN ('api','proxy')", [f.workspace.id])).rows[0].n).toBe(0);
  });

  it("refuses a missing personal agent login before queuing or waking", async () => {
    await f.login(f.creator); await f.activate();
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [f.workspace.id]);
    const response = await f.send(f.prompt(), f.viewer);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "agent_login_required", agent: "claude" } });
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].state).toBe("stopped");
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it("selects at begin and retains A's lease while B queues in the same chat", async () => {
    const a = await f.login(f.creator), b = await f.login(f.viewer);
    await f.activate(); expect((await f.hello()).status).toBe(200);
    const first = f.prompt(), second = f.prompt();
    expect((await f.send(first)).status).toBe(201);
    expect((await pool.query("SELECT acting_user_id FROM cloud_v2_prompt_chats WHERE workspace_id=$1", [f.workspace.id])).rows[0].acting_user_id).toBeNull();
    const pull = await f.worker("prompts/pull", { waitMs: 0 }); expect(pull.status).toBe(200);
    const delivery = (await pull.json()).prompts[0];
    expect(delivery.senderUserId).toBe(f.creator.id);
    expect((await f.worker("prompts/ack", { userMessageId: first.userMessageId, deliveryId: delivery.deliveryId })).status).toBe(200);
    const input = { userMessageId: first.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() };
    const begin = await f.worker("prompts/begin", input); expect(begin.status).toBe(200);
    const begun = await begin.json();
    expect(begun).toMatchObject({ dispatch: true, mode: "prompt", actingUser: { userId: f.creator.id, generation: "1", userMessageId: first.userMessageId } });
    expect(await (await f.worker("prompts/begin", input)).json()).toEqual(begun);
    const leaseInput = { chatId: "chat", userMessageId: first.userMessageId, dispatchId: input.dispatchId, generation: "1", contextId: begun.contextId };
    const response = await f.worker("turn-lease", leaseInput); expect(response.status).toBe(200);
    const lease = await response.json(); expect(lease.agents).toEqual({ claude: { apiKey: a.secret } });
    expect((await f.send(second, f.viewer)).status).toBe(201);
    expect((await (await f.worker("turn-lease", leaseInput)).json()).agents).toEqual(lease.agents);
    expect(JSON.stringify(lease)).not.toContain(b.secret);
    const actor = (await pool.query("SELECT acting_user_id,acting_generation::text FROM cloud_v2_prompt_chats WHERE workspace_id=$1", [f.workspace.id])).rows[0];
    expect(actor).toEqual({ acting_user_id: f.creator.id, acting_generation: "1" });
  });
});
