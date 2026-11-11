import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("boot cleanup through the real worker router", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.login(f.viewer); await f.activate(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const hello = (boot = f.boot) => f.worker("hello", { protocol: 2, bootId: boot, runtimeSha256: "b".repeat(64) }, { boot });
  const clean = (boot = f.boot, input = { retirementId: randomUUID(), processes: 0 }) => f.worker("execution-leases/boot-clean", input, { boot });

  it("gates begin and every material lease until this boot has a clean receipt", async () => {
    const response = await hello(); expect(response.status).toBe(200);
    const { config } = await response.json();
    for (const [route, body] of [
      ["bootstrap-lease", { contextId: config.bootstrapContextId }],
      ["turn-lease", { contextId: randomUUID(), chatId: "chat", userMessageId: "message", dispatchId: randomUUID(), generation: "1" }],
      ["terminal-lease", { clientId: randomUUID(), terminalId: "terminal", requestId: "request" }],
      ["client-lease", { clientId: randomUUID(), requestId: "request", operation: "git.push" }],
      ["execution-leases/renew", { contextIds: [config.bootstrapContextId] }],
    ] as const) {
      const blocked = await f.worker(route, body);
      expect([route, blocked.status, (await blocked.json()).error?.code]).toEqual([route, 409, "actor_busy"]);
    }
    const prompt = f.prompt(); expect((await f.send(prompt)).status).toBe(201);
    const delivery = (await (await f.worker("prompts/pull", { waitMs: 0 })).json()).prompts[0];
    expect((await f.worker("prompts/ack", { userMessageId: prompt.userMessageId, deliveryId: delivery.deliveryId })).status).toBe(200);
    const begin = { userMessageId: prompt.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() };
    const blocked = await f.worker("prompts/begin", begin);
    expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ error: { code: "actor_busy" } });
    expect(await (await clean()).json()).toEqual({ retired: 0 });
    expect((await f.worker("prompts/begin", begin)).status).toBe(200);
  });

  it("does not issue a live client context before boot-clean", async () => {
    expect((await hello()).status).toBe(200);
    const ticket = await f.cp.execution.clients.ticket(f.workspace.id, f.viewer, false);
    const grant = await f.cp.store.consumeConnectTicket(ticket.token, f.workspace.id);
    await expect(f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant!)).rejects.toMatchObject({ code: "actor_busy" });
  });

  it("records survivors and retires only replaced-boot contexts after a successful proof", async () => {
    expect((await hello()).status).toBe(200); expect((await clean()).status).toBe(200);
    const a = await f.dispatch(); expect((await f.worker("turn-lease", a.lease)).status).toBe(200);
    const boot = randomUUID(), response = await hello(boot); expect(response.status).toBe(200);
    const currentBootstrap = (await response.json()).config.bootstrapContextId;
    const failed = { retirementId: randomUUID(), processes: 1 };
    const refused = await clean(boot, failed); expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "execution_not_retired" } });
    expect((await pool.query("SELECT last_processes FROM cloud_v2_execution_boots WHERE workspace_id=$1 AND boot_id=$2", [f.workspace.id, boot])).rows[0]).toEqual({ last_processes: 1 });
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [a.begun.contextId])).rows[0].state).not.toBe("retired");
    expect((await f.worker("bootstrap-lease", { contextId: currentBootstrap }, { boot })).status).toBe(409);
    const receipt = { retirementId: randomUUID(), processes: 0 };
    const accepted = await clean(boot, receipt); expect(accepted.status).toBe(200);
    const result = await accepted.json(); expect(result.retired).toBeGreaterThan(0);
    expect((await pool.query("SELECT state,material,environment_version_id FROM cloud_v2_execution_contexts WHERE id=$1", [a.begun.contextId])).rows[0])
      .toEqual({ state: "retired", material: null, environment_version_id: null });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_tokens WHERE context_id=$1", [a.begun.contextId])).rowCount).toBe(0);
    expect((await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, a.input.userMessageId])).rows[0].state).toBe("interrupted");
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [currentBootstrap])).rows[0].state).toBe("active");
    expect(await (await clean(boot, receipt)).json()).toEqual(result);
    expect((await clean(boot)).status).toBe(409);
    expect((await f.worker("bootstrap-lease", { contextId: currentBootstrap }, { boot })).status).toBe(200);
    expect((await hello()).status).toBe(401);
    expect((await clean(f.boot)).status).toBe(401);
    expect((await pool.query("SELECT worker_boot_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].worker_boot_id).toBe(boot);
  });

  it("rechecks the run fence after a workspace lock wait and never treats Stop intent as cleanup", async () => {
    expect((await hello()).status).toBe(200); expect((await clean()).status).toBe(200);
    const a = await f.dispatch(), boot = randomUUID(); expect((await hello(boot)).status).toBe(200);
    const held = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await held.query("BEGIN"); await held.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      pending = clean(boot);
      await vi.waitFor(async () => {
        expect((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%cloud_v2_workspaces%' AND pid<>pg_backend_pid()")).rowCount).toBeGreaterThan(0);
      });
      await held.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [f.workspace.id]);
      await held.query("COMMIT");
      expect((await pending).status).toBe(409);
      expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [a.begun.contextId])).rows[0].state).not.toBe("retired");
    } finally { await held.query("ROLLBACK"); held.release(); await pending; }
  });
});
