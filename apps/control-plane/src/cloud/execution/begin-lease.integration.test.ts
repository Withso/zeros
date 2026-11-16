import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("begin-lease-v1: a new turn's lease in its begin reply", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const withLease = () => `${f.features},begin-lease-v1`;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
  afterAll(() => pool.end());

  const delivered = async (features: string) => {
    const input = f.prompt();
    expect((await f.send(input)).status).toBe(201);
    const delivery = (await (await f.worker("prompts/pull", { waitMs: 0, held: [] }, { features })).json()).prompts[0];
    expect((await f.worker("prompts/ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId }, { features })).status).toBe(200);
    return { input, begin: { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() } };
  };
  const state = async (userMessageId: string) =>
    (await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, userMessageId])).rows[0].state;

  it("answers a new turn's begin with its lease, the same one turn-lease then repeats", async () => {
    const login = await f.login(); await f.activate(); expect((await f.hello(withLease())).status).toBe(200);
    const { input, begin } = await delivered(withLease());
    const reply = await (await f.worker("prompts/begin", begin, { features: withLease() })).json();
    expect(reply).toMatchObject({ dispatch: true, mode: "prompt", actingUser: { userId: f.creator.id, generation: "1" } });
    expect(reply.lease).toMatchObject({ contextId: reply.contextId, userId: f.creator.id, generation: "1", agents: { claude: { apiKey: login.secret } } });
    expect(reply.lease.expiresAt).toBeGreaterThan(Date.now());
    // A lost reply: the retried begin answers without a lease, and turn-lease gives the same sealed material.
    const again = await (await f.worker("prompts/begin", begin, { features: withLease() })).json();
    expect(again.lease).toBeUndefined();
    const lease = await (await f.worker("turn-lease", { chatId: input.chatId, userMessageId: input.userMessageId, dispatchId: begin.dispatchId,
      generation: "1", contextId: reply.contextId }, { features: withLease() })).json();
    expect(lease.agents).toEqual(reply.lease.agents);
    expect(await state(input.userMessageId)).toBe("dispatching");
  });

  it("gives no lease to a worker that did not advertise begin-lease-v1", async () => {
    await f.login(); await f.activate(); expect((await f.hello()).status).toBe(200);
    const { begin } = await delivered(f.features);
    const reply = await (await f.worker("prompts/begin", begin)).json();
    expect(reply.dispatch).toBe(true);
    expect(reply).not.toHaveProperty("lease");
  });

  it("keeps the committed begin when its lease cannot be issued; the worker's turn-lease then succeeds", async () => {
    await f.login(); await f.activate(); expect((await f.hello(withLease())).status).toBe(200);
    const { input, begin } = await delivered(withLease());
    vi.spyOn(f.cp.execution.deps, "material").mockImplementationOnce(async () => { throw new Error("material unavailable"); });
    const response = await f.worker("prompts/begin", begin, { features: withLease() });
    expect(response.status).toBe(200);
    const reply = await response.json();
    expect(reply.dispatch).toBe(true);
    expect(reply).not.toHaveProperty("lease");
    expect(await state(input.userMessageId)).toBe("dispatching");
    const lease = await f.worker("turn-lease", { chatId: input.chatId, userMessageId: input.userMessageId, dispatchId: begin.dispatchId,
      generation: "1", contextId: reply.contextId }, { features: withLease() });
    expect(lease.status).toBe(200);
  });

  it("a workspace outside active execution mode still begins through the prompt outbox", async () => {
    expect((await f.hello(withLease())).status).toBe(200);
    const { input, begin } = await delivered(withLease());
    const reply = await (await f.worker("prompts/begin", begin, { features: withLease() })).json();
    expect(reply).toEqual({ dispatch: true, state: "dispatching" });
    expect(await state(input.userMessageId)).toBe("dispatching");
    // And a stale worker is refused there too.
    expect((await f.worker("prompts/begin", begin, { features: withLease(), boot: randomUUID() })).status).toBe(401);
  });
});
