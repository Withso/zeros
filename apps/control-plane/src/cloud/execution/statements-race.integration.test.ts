import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// statements-1 dropped re-reads of rows a transaction holds FOR UPDATE. This pins the lock those drops rely on: a removal
// waits for the lease's transaction. Refusal codes and rows for every cut are pinned in statements-precedence and
// statements-turn-lease.
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

});
