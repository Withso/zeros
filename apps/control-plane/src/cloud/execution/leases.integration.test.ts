import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("execution lease and retirement authority through the router", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.login(f.viewer); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const retire = (id: string, input = { retirementId: randomUUID(), reason: "outcome", processes: 0 }) => f.worker(`execution-leases/${id}/retired`, input);

  it("does not let a different person's steer enter the active turn", async () => {
    const a = await f.dispatch();
    const b = f.prompt(randomUUID(), { mode: "steer" });
    expect((await f.send(b, f.viewer)).status).toBe(201);
    const pull = await f.worker("prompts/pull", { waitMs: 0, held: [] });
    expect((await pull.json()).prompts).toEqual([]);
    expect((await pool.query("SELECT acting_user_id,active_context_id FROM cloud_v2_prompt_chats WHERE workspace_id=$1", [f.workspace.id])).rows[0])
      .toEqual({ acting_user_id: f.creator.id, active_context_id: a.begun.contextId });
  });

  it("returns the parent's exact material and expiry for same-person steering", async () => {
    const a = await f.dispatch(), before = await (await f.worker("turn-lease", a.lease)).json();
    const steer = await f.dispatch(f.prompt(randomUUID(), { mode: "steer" }));
    expect(steer.begun).toMatchObject({ mode: "steer", parentContextId: a.begun.contextId, contextId: a.begun.contextId,
      actingUser: a.begun.actingUser });
    expect(await (await f.worker("turn-lease", steer.lease)).json()).toEqual(before);
    expect((await f.worker("turn-lease", { ...steer.lease, dispatchId: a.begin.dispatchId })).status).toBe(409);
    expect((await f.worker("prompts/outcome", { ...steer.begin, deliveryId: undefined, state: "completed" })).status).toBe(200);
    expect((await f.worker("turn-lease", a.lease)).status).toBe(200);
  });

  it("rechecks a steer's own dispatch after a held login read", async () => {
    const parent = await f.dispatch();
    expect((await f.worker("turn-lease", parent.lease)).status).toBe(200);
    const steer = await f.dispatch(f.prompt(randomUUID(), { mode: "steer" }));
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const select = f.cp.execution.deps.logins.select.bind(f.cp.execution.deps.logins);
    vi.spyOn(f.cp.execution.deps.logins, "select").mockImplementationOnce(async (...args) => {
      const value = await select(...args); entered.resolve(); await release.promise; return value;
    });
    const pending = f.worker("turn-lease", steer.lease);
    try {
      await Promise.race([entered.promise, pending.then(response => { throw new Error(`login read was not held: ${response.status}`); })]);
      const ended = await f.worker("prompts/outcome", { userMessageId: steer.input.userMessageId, dispatchId: steer.begin.dispatchId, state: "completed" });
      expect(ended.status).toBe(200);
      expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [parent.begun.contextId])).rows[0].state).toBe("active");
    } finally { release.resolve(); }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "actor_changed" } });
    expect((await f.worker("turn-lease", parent.lease)).status).toBe(200);
  });

  it("requires both a terminal outcome and a zero-process receipt before handing over", async () => {
    const a = await f.dispatch();
    expect((await f.worker("turn-lease", a.lease)).status).toBe(200);
    expect((await f.worker("prompts/outcome", { userMessageId: a.input.userMessageId, dispatchId: a.begin.dispatchId, state: "completed" })).status).toBe(200);
    const b = f.prompt(); expect((await f.send(b, f.viewer)).status).toBe(201);
    const offered = (await (await f.worker("prompts/pull", { waitMs: 0 })).json()).prompts[0];
    const begin = { userMessageId: b.userMessageId, deliveryId: offered.deliveryId, dispatchId: randomUUID() };
    expect((await f.worker("prompts/ack", { userMessageId: b.userMessageId, deliveryId: offered.deliveryId })).status).toBe(200);
    const blocked = await f.worker("prompts/begin", begin);
    expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ error: { code: "actor_busy" } });
    const receipt = { retirementId: randomUUID(), reason: "outcome", processes: 1 };
    const busy = await retire(a.begun.contextId, receipt); expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "execution_not_retired" } });
    receipt.processes = 0;
    expect(await (await retire(a.begun.contextId, receipt)).json()).toEqual({ retired: true });
    expect(await (await retire(a.begun.contextId, receipt)).json()).toEqual({ retired: true });
    expect((await retire(a.begun.contextId, { ...receipt, retirementId: randomUUID() })).status).toBe(409);
    const admitted = await f.worker("prompts/begin", begin); expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({ mode: "prompt", actingUser: { userId: f.viewer.id, generation: "2" } });
    expect((await f.worker("turn-lease", a.lease)).status).toBe(409);
    const row = (await pool.query("SELECT material,environment_version_id FROM cloud_v2_execution_contexts WHERE id=$1", [a.begun.contextId])).rows[0];
    expect(row).toEqual({ material: null, environment_version_id: null });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_tokens WHERE context_id=$1", [a.begun.contextId])).rowCount).toBe(0);
  });

  it("keeps a generation for the same person but never reuses a turn's context", async () => {
    const a = await f.dispatch();
    expect((await f.worker("prompts/outcome", { userMessageId: a.input.userMessageId, dispatchId: a.begin.dispatchId, state: "completed" })).status).toBe(200);
    expect((await retire(a.begun.contextId)).status).toBe(200);
    const next = await f.dispatch();
    expect(next.begun.actingUser.generation).toBe(a.begun.actingUser.generation);
    expect(next.begun.contextId).not.toBe(a.begun.contextId);
    expect((await f.worker("turn-lease", { ...next.lease, contextId: a.begun.contextId })).status).toBe(409);
  });

  it("renews in order without replacing tokens, material or activity timestamps", async () => {
    const a = await f.dispatch(), lease = await (await f.worker("turn-lease", a.lease)).json();
    const row = (await pool.query("SELECT active_at,updated_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    const now = Date.now() + 10_000; vi.spyOn(Date, "now").mockReturnValue(now);
    const missing = randomUUID();
    const renewed = await f.worker("execution-leases/renew", { contextIds: [missing, a.begun.contextId] });
    expect(renewed.status).toBe(200);
    const result = await renewed.json();
    expect(result.leases).toEqual([{ contextId: missing, refused: "actor_changed" }, { contextId: a.begun.contextId, expiresAt: expect.any(Number) }]);
    expect(result.leases[1].expiresAt).toBeGreaterThan(lease.expiresAt);
    expect(result.leases[1].expiresAt).toBeLessThanOrEqual(now + 30_000);
    const after = await (await f.worker("turn-lease", a.lease)).json();
    expect(after).toEqual({ ...lease, expiresAt: result.leases[1].expiresAt });
    expect((await pool.query("SELECT active_at,updated_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0]).toEqual(row);
  });

  it("never renews expired or stopped authority", async () => {
    const a = await f.dispatch(); await f.worker("turn-lease", a.lease);
    await pool.query("UPDATE cloud_v2_execution_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [a.begun.contextId]);
    expect((await (await f.worker("execution-leases/renew", { contextIds: [a.begun.contextId] })).json()).leases)
      .toEqual([{ contextId: a.begun.contextId, refused: "expired" }]);
    expect((await f.worker("turn-lease", a.lease)).status).toBe(409);
    const stop = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts/stop`, "POST", { chatId: "chat", throughEpoch: "0" }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(stop.status).toBe(200);
    expect((await f.worker("turn-lease", a.lease)).status).toBe(409);
  });

  it("keeps the original expiry during a temporary vault failure", async () => {
    const a = await f.dispatch(), before = (await pool.query("SELECT expires_at FROM cloud_v2_execution_contexts WHERE id=$1", [a.begun.contextId])).rows[0];
    await pool.query("UPDATE cloud_agent_credential_versions SET auth_tag=decode(repeat('ff',16),'hex') WHERE credential_id IN (SELECT credential_id FROM cloud_v2_execution_contexts WHERE id=$1)", [a.begun.contextId]);
    const response = await f.worker("execution-leases/renew", { contextIds: [a.begun.contextId] });
    expect(response.status).toBe(503);
    expect((await pool.query("SELECT expires_at FROM cloud_v2_execution_contexts WHERE id=$1", [a.begun.contextId])).rows[0]).toEqual(before);
  });

  it("delivers only the persisted initiator's bootstrap material", async () => {
    const config = (await (await f.worker("config", undefined, { method: "GET" })).json()).config;
    const response = await f.worker("bootstrap-lease", { contextId: config.bootstrapContextId });
    expect(response.status).toBe(200);
    const lease = await response.json(); expect(lease.userId).toBe(f.creator.id);
    for (const field of ["agents", "api", "mcpServers"]) expect(lease).not.toHaveProperty(field);
    expect((await retire(config.bootstrapContextId, { retirementId: randomUUID(), reason: "setup_done", processes: 0 })).status).toBe(200);
    expect((await f.worker("bootstrap-lease", { contextId: config.bootstrapContextId })).status).toBe(409);
  });
});
