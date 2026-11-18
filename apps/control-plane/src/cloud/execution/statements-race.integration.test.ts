import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// statements-1 dropped re-reads that only failed earlier than a later check in the same transaction. These pin that a
// removal landing inside the shortened transactions still stops the work exactly as before.
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("removals inside the shortened begin, lease and send transactions", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const features = () => `${f.features},begin-lease-v1`;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true }); await f.activate(); expect((await f.hello(features())).status).toBe(200);
    await f.login(f.viewer); await f.login(f.creator);
  });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); await f?.cp.teamSharing.signals.close(); });
  afterAll(() => pool.end());

  const delivered = async () => {
    const input = f.prompt();
    expect((await f.send(input, f.viewer)).status).toBe(201);
    const delivery = (await (await f.worker("prompts/pull", { waitMs: 0, held: [] }, { features: features() })).json()).prompts[0];
    expect((await f.worker("prompts/ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId }, { features: features() })).status).toBe(200);
    return { input, begin: { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() } };
  };
  const remove = () => pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
  const hold = () => {
    let entered!: () => void, release!: () => void;
    const seen = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    return { seen, held, entered: () => entered(), release: () => release() };
  };

  it("begin: a removal committed after the admission read, while begin holds its locks, still refuses the turn", async () => {
    const { begin } = await delivered();
    const gate = hold();
    const store = f.cp.execution as unknown as { agent: (...args: unknown[]) => Promise<unknown> };
    const agent = store.agent.bind(store);
    vi.spyOn(store, "agent").mockImplementationOnce(async (...args) => { gate.entered(); await gate.held; return agent(...args); });
    const response = f.worker("prompts/begin", begin, { features: features() });
    await gate.seen;
    await remove();
    gate.release();
    const reply = await response;
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND kind='turn'", [f.workspace.id])).rowCount).toBe(0);
  });

  it("lease: a removal waits for the lease's lock on the context row, then ends the sender on the context it just issued", async () => {
    const { begin } = await delivered();
    const gate = hold();
    const agentConfig = f.cp.execution.deps.agentConfig;
    vi.spyOn(f.cp.execution.deps, "agentConfig").mockImplementationOnce(async (...args) => { gate.entered(); await gate.held; return agentConfig(...args); });
    const response = f.worker("prompts/begin", begin, { features: features() });
    await gate.seen;
    // The removal's fence locks the person's active contexts: it waits for the lease's transaction to commit.
    const removed = remove();
    const raced = await Promise.race([removed.then(() => "removed"), new Promise(resolve => setTimeout(() => resolve("waiting"), 300))]);
    expect(raced).toBe("waiting");
    gate.release();
    const reply = await (await response).json();
    expect(reply.lease).toBeDefined();
    await removed;
    // 0254: a turn whose material was issued survives its sender's removal, moving to its payer.
    const context = (await pool.query("SELECT state,sender_ended_at IS NOT NULL AS sender_ended FROM cloud_v2_execution_contexts WHERE id=$1", [reply.contextId])).rows[0];
    expect(context.state !== "active" || context.sender_ended).toBe(true);
  });

  it("send: a removed member replaying an accepted message is refused, never handed the stored receipt", async () => {
    const input = f.prompt();
    expect((await f.send(input, f.viewer)).status).toBe(201);
    await remove();
    const replay = await f.send(input, f.viewer);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
    expect(JSON.stringify(await replay.json())).not.toContain("receipt");
  });
});
