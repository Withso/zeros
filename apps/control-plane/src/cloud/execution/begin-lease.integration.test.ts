import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
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

database("begin-lease-v1: what lands between begin's commit and the lease", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const withLease = () => `${f.features},begin-lease-v1`;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool, { teamOwnership: true }); await f.login(); await f.activate(); expect((await f.hello(withLease())).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
  afterAll(() => pool.end());

  const delivered = async (user = f.viewer, extra: Record<string, unknown> = {}) => {
    const input = f.prompt(randomUUID(), extra);
    const sent = await f.send(input, user);
    expect([200, 201]).toContain(sent.status);
    const pulled = (await (await f.worker("prompts/pull", { waitMs: 0, held: [] }, { features: withLease() })).json()).prompts;
    const delivery = pulled.find((value: { payload: { userMessageId: string } }) => value.payload.userMessageId === input.userMessageId);
    expect((await f.worker("prompts/ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId }, { features: withLease() })).status).toBe(200);
    return { input, begin: { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() } };
  };
  const context = async (messageId: string) => (await pool.query(`SELECT id,state,reason,material IS NOT NULL AS has_material,sender_ended_at IS NOT NULL AS sender_ended
    FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND user_message_id=$2`, [f.workspace.id, messageId])).rows[0];
  /** Runs `action` after begin committed, while the embedded lease resolves its material (before its final transaction). */
  const duringLease = (action: () => Promise<unknown>) => {
    const deps = f.cp.execution.deps, original = deps.material;
    let calls = 0;
    vi.spyOn(deps, "material").mockImplementation(async (...args: Parameters<typeof original>) => {
      if (calls++ === 0) await action();
      return original.apply(deps, args);
    });
    return () => calls;
  };
  const turnLease = (input: { chatId: string; userMessageId: string }, begin: { dispatchId: string }, reply: { contextId: string; actingUser: { generation: string } }) =>
    f.worker("turn-lease", { chatId: input.chatId, userMessageId: input.userMessageId, dispatchId: begin.dispatchId,
      generation: reply.actingUser.generation, contextId: reply.contextId }, { features: withLease() });

  it("sender removed (fence) between begin's commit and the lease's final transaction: no lease", async () => {
    const { input, begin } = await delivered();
    duringLease(() => withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id])));
    const response = await f.worker("prompts/begin", begin, { features: withLease() });
    const reply = await response.json();
    expect(reply).not.toHaveProperty("lease");
    expect(await context(input.userMessageId)).toMatchObject({ state: "revoked", has_material: false, sender_ended: false });
    if (response.status === 200) expect((await turnLease(input, begin, reply)).status).toBeGreaterThanOrEqual(400);
  });

  it("chat stopped during the lease: no lease", async () => {
    const { input, begin } = await delivered();
    duringLease(async () => {
      const stop = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts/stop`, "POST", { chatId: input.chatId, throughEpoch: "0" }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
      expect(stop.ok).toBe(true);
    });
    const response = await f.worker("prompts/begin", begin, { features: withLease() });
    const reply = await response.json();
    expect(reply).not.toHaveProperty("lease");
    expect(await context(input.userMessageId)).toMatchObject({ state: "revoked", has_material: false });
  });

  it("workspace starts stopping during the lease: no lease", async () => {
    const { input, begin } = await delivered();
    duringLease(() => withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id])));
    const response = await f.worker("prompts/begin", begin, { features: withLease() });
    const reply = await response.json();
    expect(reply).not.toHaveProperty("lease");
    expect(await context(input.userMessageId)).toMatchObject({ has_material: false });
  });

  it("another person takes the chat's next turn: each begin's lease names its own sender", async () => {
    const first = await delivered(f.viewer);
    const a = await (await f.worker("prompts/begin", first.begin, { features: withLease() })).json();
    expect(a.lease.userId).toBe(f.viewer.id);
    expect((await f.worker("prompts/outcome", { userMessageId: first.input.userMessageId, dispatchId: first.begin.dispatchId, state: "completed" })).status).toBe(200);
    expect((await f.worker(`execution-leases/${a.contextId}/retired`, { retirementId: randomUUID(), reason: "outcome", processes: 0 })).status).toBe(200);
    const second = await delivered(f.creator);
    const b = await (await f.worker("prompts/begin", second.begin, { features: withLease() })).json();
    expect(b.actingUser).toMatchObject({ userId: f.creator.id, generation: "2" });
    expect(b.lease).toMatchObject({ contextId: b.contextId, userId: f.creator.id, generation: "2" });
    expect(b.contextId).not.toBe(a.contextId);
  });

  it("active mode: an unknown boot or token is refused 401 before anything is read or written", async () => {
    const { input, begin } = await delivered();
    const stale = await f.worker("prompts/begin", begin, { features: withLease(), boot: randomUUID() });
    expect(stale.status).toBe(401);
    expect(JSON.stringify(await stale.json())).not.toContain(f.viewer.id);
    const forged = await f.worker("prompts/begin", begin, { features: withLease(), token: `${f.token.slice(0, -4)}AAAA` });
    expect(forged.status).toBe(401);
    expect(await context(input.userMessageId)).toBeUndefined();
    expect((await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, input.userMessageId])).rows[0].state).toBe("inboxed");
  });

  it("a steer never carries a lease in its begin reply", async () => {
    const first = await delivered(f.viewer);
    const a = await (await f.worker("prompts/begin", first.begin, { features: withLease() })).json();
    expect(a.lease).toBeDefined();
    const steer = f.prompt(randomUUID(), { mode: "steer" });
    expect([200, 201]).toContain((await f.send(steer, f.viewer)).status);
    const pulled = (await (await f.worker("prompts/pull", { waitMs: 0, held: [first.input.userMessageId] }, { features: withLease() })).json()).prompts;
    expect(pulled).toHaveLength(1);
    expect((await f.worker("prompts/ack", { userMessageId: steer.userMessageId, deliveryId: pulled[0].deliveryId }, { features: withLease() })).status).toBe(200);
    const b = await (await f.worker("prompts/begin", { userMessageId: steer.userMessageId, deliveryId: pulled[0].deliveryId, dispatchId: randomUUID() }, { features: withLease() })).json();
    expect(b).toMatchObject({ dispatch: true, mode: "steer", contextId: a.contextId });
    expect(b).not.toHaveProperty("lease");
  });
});
