import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, withSystemTx } from "./db.js";
import { configuredDatabaseContext, SYSTEM_DATABASE_CONTEXT } from "./db-context.js";
import { requestTiming } from "./request-timing.js";
import { budgetTable, deferred, holdLoadStream, LOAD_BUDGETS, LoadBudgetProbe, routeTable, scenarioTotals, selectLoadRequests, type LoadScenario } from "./test-support/load-budget.js";
import { loadBudgetFixture, OBSERVED_IDLE_REPLAY } from "./test-support/load-budget-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describe("load replay stream lifetime", () => {
  it("rejects an early EOF after ready instead of silently measuring a disconnected desktop", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) {
      controller = value; controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
    } });
    const stream = await holdLoadStream(body, new AbortController());
    controller.close();
    await expect(stream.done).rejects.toThrow("Load fixture: event stream ended during replay");
    await expect(stream.stop()).rejects.toThrow("Load fixture: event stream ended during replay");
  });
  it("closes a live stream deliberately without reporting a false disconnect", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
    } });
    const stream = await holdLoadStream(body, new AbortController());
    await expect(stream.stop()).resolves.toBeUndefined();
    await expect(stream.done).resolves.toBeUndefined();
  });
  it("accepts the native HTTP reader's AbortError from deliberate cancellation", async () => {
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
      abort.signal.addEventListener("abort", () => controller.error(new DOMException("synthetic HTTP cancellation", "AbortError")), { once: true });
    } });
    const stream = await holdLoadStream(body, abort);
    await expect(stream.stop()).resolves.toBeUndefined();
  });
});
database("control-plane load budgets through the router and PostgreSQL", () => {
  let pool: pg.Pool, probe: LoadBudgetProbe;
  beforeEach(() => {
    pool = createPool(process.env.TEST_DATABASE_URL!, { maxConnections: 10 });
    probe = new LoadBudgetProbe(pool);
  });
  afterEach(async () => {
    probe.close(); await pool.end(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("counts batches, callbacks, concurrent requests, rollback, background work and injected delay exactly", async () => {
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: Infinity, databasePool: pool, costObserver: probe.observe }));
    app.get("/_load-budget/:id", async c => {
      if (c.req.param("id") === "callback") {
        await new Promise<void>((resolve, reject) => pool.query("SELECT 1", error => error ? reject(error) : resolve()));
      } else {
        const rollback = c.req.param("id") === "rollback";
        await withSystemTx(pool, async tx => {
          const result = await tx.query("SELECT 1; SELECT 2");
          expect(Array.isArray(result)).toBe(true);
          if (rollback) throw new Error("synthetic rollback");
        }).catch(error => { if (!rollback) throw error; });
      }
      return c.json({ ok: true });
    });
    probe.setDelay(5);
    const { cost } = await probe.measure("counter-control", async () => {
      await pool.query("SELECT 1");
      await Promise.all(["committed", "rollback", "callback"].map(id => {
        const request = new Request(`https://api.example.test/_load-budget/${id}`);
        return probe.request(request, () => app.fetch(request));
      }));
    });
    expect(cost.background).toMatchObject({ queries: 1, statements: 1, transactions: 0, failures: 0, inFlight: 0, injectedDelayMs: 5 });
    expect(cost.requests.map(value => ({ statements: value.statements, transactions: value.transactions,
      commits: value.commits, rollbacks: value.rollbacks }))).toEqual([
      { statements: 6, transactions: 1, commits: 1, rollbacks: 0 },
      { statements: 6, transactions: 1, commits: 0, rollbacks: 1 },
      { statements: 1, transactions: 0, commits: 0, rollbacks: 0 },
    ]);
    for (const request of cost.requests) {
      expect(request.observer).toMatchObject({ sqlStatements: request.statements, transactions: request.transactions, queriesFailed: 0 });
      expect(request.injectedDelayMs).toBe(request.statements * 5);
      expect(request.elapsedMs).toBeGreaterThanOrEqual(request.injectedDelayMs - 2);
    }
    expect(scenarioTotals(cost)).toMatchObject({ requests: 3, statements: 14, transactions: 2, failures: 0, inFlight: 0, injectedDelayMs: 70 });
  });

  it("charges detached SQL to background and refuses failed-route or incomplete SQL measurements", async () => {
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: Infinity, databasePool: pool, costObserver: probe.observe }));
    const release = deferred<void>();
    let detached: Promise<unknown> = Promise.resolve();
    app.get("/_load-budget/:id", c => {
      if (c.req.param("id") === "refused") return c.json({ error: "unauthorized" }, 401);
      detached = release.promise.then(() => pool.query("SELECT 1"));
      return c.json({ ok: true });
    });
    const observed = await probe.measure("detached", async () => {
      const request = new Request("https://api.example.test/_load-budget/detached");
      await probe.request(request, () => app.fetch(request));
      release.resolve(); await detached;
    });
    expect(observed.cost.requests[0]).toMatchObject({ statements: 0, transactions: 0 });
    expect(observed.cost.background).toMatchObject({ statements: 1, queries: 1, failures: 0 });
    await expect(probe.measure("refused", async () => {
      const request = new Request("https://api.example.test/_load-budget/refused");
      return probe.request(request, () => app.fetch(request));
    })).rejects.toThrow("Load replay failed: GET /_load-budget/:id (401)");
    const incomplete = await probe.measure("idle", async () => {
      await pool.query("SELECT load_budget_missing_column").catch(() => {});
    });
    expect(incomplete.cost.background.failures).toBe(1);
    expect(() => budgetTable(new Map(LOAD_BUDGETS.map(budget => [budget.scenario, incomplete.cost]))))
      .toThrow("Incomplete SQL observation: idle");
  });

  it("counts writing transactions and hidden CTE/trigger mutations without charging its census queries", async () => {
    const schema = `load_writes_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.items (id integer PRIMARY KEY, value integer NOT NULL);
      CREATE TABLE ${schema}.audit (id integer);
      CREATE FUNCTION ${schema}.audit_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO ${schema}.audit VALUES (NEW.id); RETURN NEW; END $$;
      CREATE TRIGGER audit_update AFTER UPDATE ON ${schema}.items
        FOR EACH ROW EXECUTE FUNCTION ${schema}.audit_update();
      GRANT USAGE ON SCHEMA ${schema} TO zeros_app;
      GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO zeros_app`);
    try {
      const app = new Hono();
      app.use("*", requestTiming({ slowMs: Infinity, databasePool: pool, costObserver: probe.observe }));
      app.get("/_load-budget/:id", async c => {
        await withSystemTx(pool, async tx => {
          if (c.req.param("id") === "write") {
            await new Promise<void>((resolve, reject) => tx.query(`INSERT INTO ${schema}.items VALUES (1, 0)`, error => error ? reject(error) : resolve()));
            await tx.query(`WITH changed AS (UPDATE ${schema}.items SET value=1 WHERE id=1 RETURNING id) SELECT id FROM changed`);
          }
          await tx.query(`SELECT count(*) FROM ${schema}.items`);
        });
        return c.json({ ok: true });
      });
      const { cost } = await probe.measure("write-control", async () => {
        for (const id of ["write", "read"]) {
          const request = new Request(`https://api.example.test/_load-budget/${id}`);
          await probe.request(request, () => app.fetch(request));
        }
      }, { writes: true });
      expect(cost.requests[0]).toMatchObject({ writeTransactions: 1, writeStatements: 2, rowMutations: 3, maxWriteStatementsPerTransaction: 2 });
      expect(cost.requests[1]).toMatchObject({ writeTransactions: 0, writeStatements: 0, rowMutations: 0 });
      for (const request of cost.requests) expect(request.observer).toMatchObject({ sqlStatements: request.statements, transactions: request.transactions });
      expect(scenarioTotals(cost)).toMatchObject({ writeTransactions: 1, writeStatements: 2, rowMutations: 3, maxWriteStatementsPerTransaction: 2 });
      const background = await probe.measure("write-background", () => withSystemTx(pool,
        tx => tx.query(`UPDATE ${schema}.items SET value=2 WHERE id=1`)), { writes: true });
      expect(background.cost.background).toMatchObject({ writeTransactions: 1, writeStatements: 1, rowMutations: 2 });
      const queued = await probe.measure("write-queued", () => withSystemTx(pool, tx => Promise.all([
        tx.query(`SELECT count(*) FROM ${schema}.items`),
        tx.query(`UPDATE ${schema}.items SET value=3 WHERE id=1`),
      ])), { writes: true });
      expect(queued.cost.background).toMatchObject({ writeTransactions: 1, writeStatements: 1, rowMutations: 2 });
      for (const write of [true, false]) {
        const statement = write ? `WITH changed AS (UPDATE ${schema}.items SET value=4 WHERE id=1 RETURNING id) SELECT id FROM changed`
          : `SELECT count(*) FROM ${schema}.items`;
        const batched = await probe.measure("write-batched", () => pool.query(
          `BEGIN; SET LOCAL ROLE zeros_app; ${configuredDatabaseContext(pool, SYSTEM_DATABASE_CONTEXT)}; ${statement}\n; COMMIT`), { writes: true });
        expect(batched.value).toHaveLength(5);
        expect(batched.cost.background).toMatchObject({ queries: 1, statements: 5, transactions: 1, commits: 1,
          writeTransactions: Number(write), writeStatements: Number(write), rowMutations: write ? 2 : 0, censusQueries: 2 });
      }
      const client = await pool.connect();
      try {
        for (const statements of [
          [`BEGIN; UPDATE ${schema}.items SET value=5 WHERE id=1`],
          ["BEGIN", `UPDATE ${schema}.items SET value=5 WHERE id=1; ROLLBACK`],
          ["BEGIN", `TRUNCATE ${schema}.items`],
        ]) {
          await expect(probe.measure("unsupported-write-shape", async () => {
            try { for (const statement of statements) await client.query(statement); }
            finally { await client.query("ROLLBACK"); }
          }, { writes: true })).rejects.toThrow("Load write census");
        }
      } finally { client.release(true); }
      await pool.query(`CREATE CONSTRAINT TRIGGER deferred_audit AFTER UPDATE ON ${schema}.items
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${schema}.audit_update()`);
      await expect(probe.measure("unsupported-deferred", () => withSystemTx(pool,
        tx => tx.query(`UPDATE ${schema}.items SET value=3 WHERE id=1`)), { writes: true })).rejects.toThrow("deferred trigger");
    } finally { await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
  });
});

database("load-budget workload", () => {
  let pool: pg.Pool, probe: LoadBudgetProbe;
  let fixture: Awaited<ReturnType<typeof loadBudgetFixture>> | undefined;
  let measured: ReturnType<typeof budgetTable>;
  afterAll(async () => {
    try { await fixture?.close(); }
    finally { probe?.close(); await pool?.end(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
  // Setup and accounting failures must not satisfy an expected target failure.
  beforeAll(async () => {
    pool = createPool(process.env.TEST_DATABASE_URL!, { maxConnections: 10 });
    probe = new LoadBudgetProbe(pool);
    fixture = await loadBudgetFixture(pool, probe);
    await fixture.assertTransportCancellation();
    const statementDelayMs = Number(process.env.LOAD_BUDGET_STATEMENT_DELAY_MS ?? 0);
    probe.setDelay(statementDelayMs);
    const wallClock = process.env.LOAD_BUDGET_WALL_CLOCK === "1";
    const scenarios = new Map<string, LoadScenario>();
    const list = await probe.measure("workspace-list", () => fixture!.workspaceList());
    scenarios.set("workspace-list", list.cost);
    const turn = await probe.measure("turn-path", () => fixture!.turnStart(), { writes: true });
    scenarios.set("turn-path", turn.cost);
    const lease = turn.cost.requests.filter(request => request.route === "/v2/cloud/worker/turn-lease");
    expect(lease).toHaveLength(1);
    scenarios.set("turn-lease", selectLoadRequests(turn.cost, request => lease.includes(request)));
    const renewal = await probe.measure("renewal", () => fixture!.renew());
    scenarios.set("renewal", renewal.cost);
    const running = await fixture.runningTurn(turn.value);
    const historyStart = await probe.measure("turn-history-start", running.prepare, { writes: true });
    scenarios.set("turn-history-start", historyStart.cost);
    const stream = await probe.measure("running-turn", running.stream, { writes: true });
    scenarios.set("running-turn", stream.cost);
    expect(stream.cost.background.writeTransactions, "running-stream background writes need attribution").toBe(0);
    scenarios.set("running-stream", selectLoadRequests(stream.cost, request => request.route === "/v2/cloud/worker/history"));
    const end = await probe.measure("turn-end", running.finish, { writes: true });
    scenarios.set("turn-end", end.cost);
    console.info("Running turn:", await running.verify());
    const idle = await probe.measure("idle", () => fixture!.idleReplay(wallClock));
    scenarios.set("idle", idle.cost);
    scenarios.set("periodic-renewals", selectLoadRequests({ ...idle.cost, requests: [...idle.cost.requests, ...stream.cost.requests],
      elapsedMs: idle.cost.elapsedMs + stream.cost.elapsedMs }, request => request.route === "/v2/cloud/worker/execution-leases/renew"));

    console.info(`Idle profile: observed Alpha; 300000 simulated ms; ${wallClock ? "wall-paced" : "compressed request replay (periodic server work is a lower bound)"}`);
    for (const [name, cost] of scenarios) {
      if (["turn-lease", "running-stream", "periodic-renewals"].includes(name)) continue;
      console.info(`Load scenario: ${name}; statement delay ${statementDelayMs} ms; write census ${cost.writesObserved ? "enabled (diagnostic queries excluded)" : "disabled"}`);
      console.table(routeTable(cost));
      console.table([{ scope: "background", ...cost.background, elapsedMs: Math.round(cost.elapsedMs) }]);
      expect(scenarioTotals(cost).failures).toBe(0);
      for (const request of cost.requests) {
        expect(request.status).toBeGreaterThanOrEqual(200);
        expect(request.status).toBeLessThan(300);
        if (!request.streaming) expect(request.observer).toMatchObject({ method: request.method, route: request.route,
          sqlStatements: request.statements, transactions: request.transactions, queriesFailed: 0, queriesInFlight: 0,
          uncheckedClientCheckouts: 0, checkoutsInFlight: 0 });
      }
    }
    expect(fixture.observerStatus()).toEqual({ enabled: true, pending: 0, dropped: 0, errors: 0 });
    measured = budgetTable(scenarios);
    expect(measured.map(row => [row.scenario, row.metric])).toEqual(LOAD_BUDGETS.map(row => [row.scenario, row.metric]));
    console.table(measured, ["phase", "scenario", "metric", "observed", "baseline", "ratchet", "maximum", "result"]);
    expect(fixture.pollWaits(), "real empty-poll waiter/recheck branch").toBe(OBSERVED_IDLE_REPLAY.find(row => row.operation === "pull")!.count);
  }, 600_000);

  it("RATCHET stays within every recorded baseline", () => {
    for (const budget of measured) {
      expect.soft(budget.observed, `RATCHET ${budget.scenario}: ${budget.metric}`).toBeLessThanOrEqual(budget.baseline);
    }
  });

  for (const budget of LOAD_BUDGETS) {
    const target = budget.expectedFailure ? it.fails : it;
    target(`${budget.phase} TARGET ${budget.scenario}: ${budget.metric} <= ${budget.maximum}${budget.expectedFailure ? " — set expectedFailure=false when met" : ""}`, () => {
      const result = measured.find(row => row.scenario === budget.scenario && row.metric === budget.metric)!;
      expect(result.observed).toBeLessThanOrEqual(budget.maximum);
    });
  }
});
