import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { CloudV2PromptOutbox } from "./prompt-outbox.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("prompt cache locking across chats", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5, statement_timeout: 5000 }); });
  afterAll(() => pool.end());
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const prompt = (chatId: string) => ({ chatId, userMessageId: `message-${chatId}`, agentId: "claude" as const,
    startedAt: 1, prompt: [{ type: "text" as const, text: "Fixture" }] });
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true });
    await f.login(); await f.activate();
    expect((await f.hello(`${f.features},creator-agent-logins-v1`)).status).toBe(200);
    await f.cp.loginChanges.stop();
    for (const chatId of ["a", "b"]) expect((await f.send(prompt(chatId), f.viewer)).status).toBe(201);
    await pool.query(`UPDATE cloud_v2_prompt_outbox SET created_at=clock_timestamp()-
      CASE chat_id WHEN 'b' THEN interval '2 minutes' ELSE interval '1 minute' END WHERE workspace_id=$1`, [f.workspace.id]);
  });
  const cache = async () => (await pool.query("SELECT chat_id,revision::text FROM cloud_v2_prompt_cache WHERE workspace_id=$1 ORDER BY chat_id", [f.workspace.id])).rows;

  it.each(["claim", "cut"] as const)("finishes a member cut across two chats against a reverse-order worker claim with %s first", async first => {
    const workerPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, statement_timeout: 5000 });
    const workerClient = await workerPool.connect();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const query = workerClient.query.bind(workerClient);
    const workerPid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let held = false;
    workerClient.query = (async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (first === "claim" && !held && typeof sql === "string" && sql.includes("WHERE worker_token_hash=$1") && sql.includes("FOR UPDATE OF w")) {
        held = true; entered.resolve(); await release.promise;
      }
      return result;
    }) as typeof workerClient.query;
    workerClient.release();
    let claiming: ReturnType<CloudV2PromptOutbox["pull"]> | undefined;
    let cutting: ReturnType<ExecutionFixture["cp"]["execution"]["maintenance"]["workspace"]> | undefined;
    let cutPid = 0;
    const cancel = f.cp.execution.maintenance.cancelQueued.bind(f.cp.execution.maintenance);
    vi.spyOn(f.cp.execution.maintenance, "cancelQueued").mockImplementation(async (tx, id) => {
      await cancel(tx, id);
      if (first === "cut" && !held) {
        held = true; cutPid = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        entered.resolve(); await release.promise;
      }
    });
    const before = await cache();
    try {
      const remove = () => withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
      const claim = () => new CloudV2PromptOutbox(workerPool).pull(f.token, f.boot, []);
      if (first === "claim") {
        claiming = claim(); await entered.promise;
        expect((await remove()).rowCount).toBe(1);
        cutting = f.cp.execution.maintenance.workspace(f.workspace.id);
        await vi.waitFor(async () => expect((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [workerPid])).rowCount).toBeGreaterThan(0), { timeout: 3000 });
        release.resolve();
        const result = await claiming;
        expect(result.prompts.map(item => item.payload.chatId)).toEqual(["b", "a"]);
        await cutting;
      } else {
        expect((await remove()).rowCount).toBe(1);
        cutting = f.cp.execution.maintenance.workspace(f.workspace.id); await entered.promise;
        claiming = claim();
        await vi.waitFor(async () => expect((await pool.query("SELECT $1=ANY(pg_blocking_pids($2)) AS waiting", [cutPid, workerPid])).rows[0].waiting).toBe(true), { timeout: 3000 });
        release.resolve(); await cutting;
        expect((await claiming).prompts).toEqual([]);
      }
      const after = await cache();
      expect(after.map(row => row.chat_id)).toEqual(["a", "b"]);
      for (const [i, row] of after.entries()) expect(Number(row.revision)).toBeGreaterThan(Number(before[i]!.revision));
      expect((await pool.query("SELECT state,cancel_requested FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 ORDER BY chat_id", [f.workspace.id])).rows)
        .toEqual([{ state: "cancelled", cancel_requested: true }, { state: "cancelled", cancel_requested: true }]);
    } finally {
      release.resolve();
      await Promise.allSettled([claiming, cutting]);
      workerClient.query = query;
      await workerPool.end();
    }
  });

  it("skips retention in a locked workspace before touching any of its outbox or cache rows", async () => {
    await f.store.prompts.enqueue(f.own.id, f.viewer.id, prompt("free"));
    await pool.query("UPDATE cloud_v2_prompt_outbox SET state='completed',terminal_at=clock_timestamp()-interval '8 days'");
    const tx = await pool.connect(), before = await cache();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      await f.store.prompts.prune();
      expect((await pool.query("SELECT chat_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND payload IS NOT NULL ORDER BY chat_id", [f.workspace.id])).rows)
        .toEqual([{ chat_id: "a" }, { chat_id: "b" }]);
      expect(await cache()).toEqual(before);
      expect((await pool.query("SELECT payload FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.own.id])).rows).toEqual([{ payload: null }]);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    await f.store.prompts.prune();
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE payload IS NOT NULL")).rowCount).toBe(0);
  });

  it("rejects an N-1 child-first compactor without waiting on a foreground workspace fence", async () => {
    await pool.query("UPDATE cloud_v2_prompt_outbox SET state='completed',terminal_at=clock_timestamp()-interval '8 days'");
    const tx = await pool.connect(), before = await cache();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      await expect(withSystemTx(pool, writer => writer.query(`UPDATE cloud_v2_prompt_outbox SET payload=NULL,payload_bytes=0
        WHERE (workspace_id,user_message_id) IN (SELECT workspace_id,user_message_id FROM cloud_v2_prompt_outbox
          WHERE payload IS NOT NULL AND terminal_at<clock_timestamp()-interval '7 days' ORDER BY terminal_at LIMIT 1000)`)))
        .rejects.toMatchObject({ code: "55P03" });
      expect(await cache()).toEqual(before);
      expect((await tx.query("UPDATE cloud_v2_prompt_outbox SET cancel_requested=true WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(2);
      await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    await f.store.prompts.prune();
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE payload IS NOT NULL")).rowCount).toBe(0);
  });
});
