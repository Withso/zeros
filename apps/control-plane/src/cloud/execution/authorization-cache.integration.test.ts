import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { EXECUTION_AUTHORIZATION_INPUTS, ExecutionAuthorizationCache } from "./authorization-cache.js";
import type { CachedTokenContext } from "./store.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("in-memory execution token verdicts", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { authCache: "on" });
    await f.login(f.creator, "codex"); await f.login(f.viewer, "codex"); await f.activate(); expect((await f.hello()).status).toBe(200);
  });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  afterAll(() => pool.end());

  const turn = async () => {
    const dispatched = await f.dispatch(f.prompt(randomUUID(), { agentId: "codex" }), f.viewer);
    const lease = await (await f.worker("turn-lease", dispatched.lease)).json();
    const end = () => f.worker("prompts/outcome", { userMessageId: dispatched.input.userMessageId, dispatchId: dispatched.begin.dispatchId, state: "completed" });
    return { proxy: lease.agents.codex.token as string, api: lease.api?.token as string | undefined, end };
  };
  const transactions = async (run: () => Promise<unknown>) => {
    const scope = new AsyncLocalStorage<boolean>(), query = pg.Client.prototype.query;
    let count = 0;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if (scope.getStore() && typeof args[0] === "string" && /^BEGIN\b/.test(args[0])) count += 1;
      return (query as (...values: unknown[]) => unknown).apply(this, args);
    } as never);
    try { await scope.run(true, run); } finally { spy.mockRestore(); }
    return count;
  };
  const refusedWithin = async (check: () => Promise<unknown>, ms: number) => {
    const started = performance.now();
    while (performance.now() - started < ms) {
      try { await check(); } catch { return performance.now() - started; }
      await delay(10);
    }
    throw new Error(`still allowed after ${ms} ms`);
  };

  it("serves a repeated proxy check from memory and refuses it as soon as the turn ends", async () => {
    const { proxy, end } = await turn();
    const access = await f.cp.execution.proxyAccess(proxy);
    expect(await transactions(() => access.check())).toBe(1);
    expect(await transactions(() => access.check())).toBe(0);
    expect((await end()).status).toBe(200);
    // The outcome's commit notifies; the 5 s age bound alone would take far longer.
    expect(await refusedWithin(() => access.check(), 2_000)).toBeLessThan(1_000);
  });

  it("refuses a cached API token as soon as API access is turned off", async () => {
    const { api } = await turn();
    expect(api).toBeTruthy();
    if (!api) return;
    await f.cp.execution.cachedTokenContext("api", { token: api });
    expect(await transactions(() => f.cp.execution.cachedTokenContext("api", { token: api }))).toBe(0);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET api_access=false WHERE id=$1", [f.workspace.id]));
    expect(await refusedWithin(() => f.cp.execution.cachedTokenContext("api", { token: api }), 2_000)).toBeLessThan(1_000);
  });

  it("bounds a lost notification by the age limit", async () => {
    const { proxy, end } = await turn();
    // No listener at all: only the age bound can drop the entry.
    const lost = new ExecutionAuthorizationCache<CachedTokenContext>({ mode: "on", healthy: () => true, maxAgeMs: 300 });
    lost.invalidate = () => {}; lost.flush = () => {};
    f.cp.execution.authorizations = lost;
    const access = await f.cp.execution.proxyAccess(proxy);
    await access.check();
    expect((await end()).status).toBe(200);
    await access.check();
    const waited = await refusedWithin(() => access.check(), 2_000);
    expect(waited).toBeGreaterThan(100);
    expect(waited).toBeLessThan(1_000);
  });

  it("knows every table the token check reads and how each one drops a verdict", async () => {
    const { proxy, api } = await turn();
    const fresh = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      const read = new Set<string>();
      for (const [kind, token] of [["proxy", proxy], ["api", api]] as const) {
        if (!token) continue;
        // Pending statistics of earlier work on a connection are flushed after a second of idleness.
        await delay(1_100);
        const tables = await withSystemTx(fresh, async tx => {
          await (f.cp.execution as unknown as { tokenContextOnce: (...args: unknown[]) => Promise<unknown> }).tokenContextOnce(kind, { token }, tx);
          return (await tx.query<{ relname: string }>(`SELECT relname FROM pg_stat_xact_user_tables
            WHERE coalesce(seq_scan,0)+coalesce(idx_scan,0)>0`)).rows.map(row => row.relname);
        });
        for (const table of tables) read.add(table);
      }
      expect(read.has("cloud_v2_execution_contexts")).toBe(true);
      expect([...read].filter(table => !(table in EXECUTION_AUTHORIZATION_INPUTS)).sort()).toEqual([]);
      const triggers = (await pool.query<{ relname: string; proname: string }>(`SELECT c.relname,p.proname FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal`)).rows;
      const has = (table: string, proname: string) => triggers.some(row => row.relname === table && row.proname === proname);
      for (const [table, ways] of Object.entries(EXECUTION_AUTHORIZATION_INPUTS) as [string, readonly string[]][]) {
        if (ways.includes("hint")) expect(has(table, "notify_cloud_v2_authorization"), table).toBe(true);
        if (ways.includes("fence")) expect(has(table, "fence_cloud_execution_authority"), table).toBe(true);
        if (ways.includes("context")) expect(table === "cloud_v2_execution_tokens" || has(table, "erase_cloud_execution_material"), table).toBe(true);
      }
    } finally { await fresh.end(); }
  });

  it("hints the settings the fence does not see, and stays silent on renewals", async () => {
    const { proxy } = await turn();
    const context = (await pool.query<{ id: string }>(`SELECT c.id FROM cloud_v2_execution_tokens t JOIN cloud_v2_execution_contexts c ON c.id=t.context_id
      WHERE t.kind='proxy' ORDER BY c.created_at DESC LIMIT 1`)).rows[0]!;
    expect(proxy).toBeTruthy();
    const listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", notice => { if (notice.channel === "zeros_cloud_v2_authorization" || notice.channel === "zeros_cloud_v2_execution") heard.push(`${notice.channel}|${notice.payload}`); });
    await listener.query("LISTEN zeros_cloud_v2_authorization; LISTEN zeros_cloud_v2_execution");
    const after = async (sql: string, values: unknown[]) => {
      heard.length = 0; await withSystemTx(pool, tx => tx.query(sql, values)); await delay(150); return [...heard];
    };
    const authorization = (payload: string) => `zeros_cloud_v2_authorization|${payload}`;
    try {
      expect(await after("UPDATE cloud_v2_execution_contexts SET expires_at=expires_at+interval '1 minute' WHERE id=$1", [context.id])).toEqual([]);
      expect(await after("UPDATE cloud_v2_workspaces SET api_access=api_access WHERE id=$1", [f.workspace.id])).toEqual([]);
      expect(await after("UPDATE cloud_v2_workspaces SET api_access=NOT api_access WHERE id=$1", [f.workspace.id])).toEqual([authorization(`w:${f.workspace.id}`)]);
      expect(await after("UPDATE cloud_v2_execution_contexts SET sender_ended_at=clock_timestamp() WHERE id=$1", [context.id])).toEqual([authorization(`w:${f.workspace.id}`)]);
      expect(await after("UPDATE cloud_v2_execution_contexts SET sender_ended_at=clock_timestamp() WHERE id=$1", [context.id])).toEqual([]);
      expect(await after(`INSERT INTO cloud_api_access_settings (org_id,user_id,workspace_api_access) VALUES ($1,$2,true)
        ON CONFLICT (org_id,user_id) DO UPDATE SET workspace_api_access=NOT cloud_api_access_settings.workspace_api_access`, [f.organizationId, f.viewer.id]))
        .toEqual([authorization(`u:${f.viewer.id}`)]);
    } finally { await listener.end(); }
  });
});
