import { Hono } from "hono";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, withSystemTx } from "./db.js";
import { requestTiming } from "./request-timing.js";
import { budgetTable, deferred, holdLoadStream, LOAD_BUDGETS, LoadBudgetProbe, routeTable, scenarioTotals, type LoadScenario } from "./test-support/load-budget.js";
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
  let fixture: Awaited<ReturnType<typeof loadBudgetFixture>> | undefined;
  beforeEach(() => {
    pool = createPool(process.env.TEST_DATABASE_URL!, { maxConnections: 10 });
    probe = new LoadBudgetProbe(pool);
  });
  afterEach(async () => {
    await fixture?.close(); fixture = undefined;
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

  it("enforces the idle, turn-lease, complete turn path, renewal and workspace-list budgets", async () => {
    fixture = await loadBudgetFixture(pool, probe);
    await fixture.assertTransportCancellation();
    const statementDelayMs = Number(process.env.LOAD_BUDGET_STATEMENT_DELAY_MS ?? 0);
    probe.setDelay(statementDelayMs);
    const wallClock = process.env.LOAD_BUDGET_WALL_CLOCK === "1";
    const scenarios = new Map<string, LoadScenario>();
    const list = await probe.measure("workspace-list", () => fixture!.workspaceList());
    scenarios.set("workspace-list", list.cost);
    const turn = await probe.measure("turn-path", () => fixture!.turnStart());
    scenarios.set("turn-path", turn.cost);
    const lease = turn.cost.requests.filter(request => request.route === "/v2/cloud/worker/turn-lease");
    expect(lease).toHaveLength(1);
    scenarios.set("turn-lease", { ...turn.cost, requests: lease, background: { ...turn.cost.background,
      queries: 0, statements: 0, transactions: 0, commits: 0, rollbacks: 0, failures: 0, inFlight: 0, injectedDelayMs: 0 } });
    const renewal = await probe.measure("renewal", () => fixture!.renew());
    scenarios.set("renewal", renewal.cost);
    await fixture.finishTurn(turn.value);
    const idle = await probe.measure("idle", () => fixture!.idleReplay(wallClock));
    scenarios.set("idle", idle.cost);

    console.info(`Idle profile: observed Alpha; 300000 simulated ms; ${wallClock ? "wall-paced" : "compressed request replay (periodic server work is a lower bound)"}`);
    for (const [name, cost] of scenarios) {
      if (name === "turn-lease") continue;
      console.info(`Load scenario: ${name}; statement delay ${statementDelayMs} ms`);
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
    const budgets = budgetTable(scenarios);
    console.table(budgets);
    expect.soft(fixture.pollWaits(), "real empty-poll waiter/recheck branch").toBe(OBSERVED_IDLE_REPLAY.find(row => row.operation === "pull")!.count);
    for (const budget of budgets) expect.soft(budget.observed, `${budget.scenario}: ${budget.metric}`).toBeLessThanOrEqual(budget.maximum);
  }, 600_000);
});
