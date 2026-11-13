import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeTransactionTiming, type TransactionTimingSummary } from "../../request-timing.js";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("lease recovery after database and admission waits", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); await f?.cp.routes.teamSharing?.signals.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const handle = async () => {
    const reply = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(reply.status).toBe(200);
    const ticket = await reply.json();
    const grant = await f.cp.store.consumeConnectTicket(ticket.protocols[1].slice(7), f.workspace.id);
    return f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant!);
  };
  const ageNextAdmission = () => {
    const admit = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
    return vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementationOnce(async (...args) => {
      const proof = await admit(...args);
      return { ...proof, until: proof.until - 7_000 };
    });
  };
  const measure = async (work: () => Promise<Response>, latencyMs = 0) => {
    const scope = new AsyncLocalStorage<{ queries: number }>(), observed = { queries: 0 };
    const query = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const active = scope.getStore();
      if (!active) return Reflect.apply(query, this, args);
      active.queries++;
      if (!latencyMs) return Reflect.apply(query, this, args);
      const callback = args.at(-1);
      if (typeof callback === "function") {
        void delay(latencyMs).then(() => Reflect.apply(query, this, args));
        return;
      }
      return delay(latencyMs).then(() => Reflect.apply(query, this, args));
    } as typeof query);
    let timing: TransactionTimingSummary | undefined;
    try {
      const response = await scope.run(observed, () => observeTransactionTiming(work, value => { timing = value; }));
      return { response, queries: observed.queries, ...timing! };
    } finally { spy.mockRestore(); }
  };

  it("records the real turn and renewal transaction budgets", async () => {
    const turn = await f.dispatch();
    const issued = await measure(() => f.worker("turn-lease", turn.lease));
    expect(issued.response.status).toBe(200);
    const renewed = await measure(() => f.worker("execution-leases/renew", { contextIds: [turn.begun.contextId] }));
    expect(renewed.response.status).toBe(200);
    expect(issued.transactions).toBeLessThanOrEqual(13);
    expect(issued.queries).toBeLessThanOrEqual(100);
    expect(renewed.transactions).toBeLessThanOrEqual(8);
    expect(renewed.queries).toBeLessThanOrEqual(45);
    console.info(JSON.stringify({ leaseCost: {
      turn: { transactions: issued.transactions, queries: issued.queries },
      renew: { transactions: renewed.transactions, queries: renewed.queries },
    } }));
  });

  it("takes new authority when a turn admission has aged below the issuance floor", async () => {
    const turn = await f.dispatch(), admit = ageNextAdmission();
    f.fetcher.mockClear();
    const response = await f.worker("turn-lease", turn.lease);
    expect(response.status).toBe(200);
    expect((await response.json()).expiresAt - Date.now()).toBeGreaterThanOrEqual(25_000);
    expect(admit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("takes new authority when a healthy handle renewal has aged below the floor", async () => {
    const client = await handle(), admit = ageNextAdmission();
    f.fetcher.mockClear();
    const response = await f.worker("execution-leases/renew", { contextIds: [client.contextId] });
    expect(response.status).toBe(200);
    const lease = (await response.json()).leases[0];
    expect(lease).not.toHaveProperty("refused");
    expect(lease.expiresAt - Date.now()).toBeGreaterThanOrEqual(25_000);
    expect(admit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("preserves access_revoked when membership ends after renewal admission", async () => {
    const client = await handle(), admit = f.cp.execution.deps.authority.admit.bind(f.cp.execution.deps.authority);
    vi.spyOn(f.cp.execution.deps.authority, "admit").mockImplementationOnce(async (...args) => {
      const proof = await admit(...args);
      await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId,f.viewer.id]));
      return proof;
    });
    const response = await f.worker("execution-leases/renew", { contextIds: [client.contextId] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ leases: [{ contextId: client.contextId,refused: "access_revoked" }] });
  });

  it("delivers a usable turn lease with latency at every real PostgreSQL query", async () => {
    const turn = await f.dispatch();
    const result = await measure(() => f.worker("turn-lease", turn.lease), 40);
    console.info(JSON.stringify({ delayedLease: { status: result.response.status, transactions: result.transactions, queries: result.queries, delayMs: 40 } }));
    expect(result.response.status).toBe(200);
    expect((await result.response.json()).expiresAt - Date.now()).toBeGreaterThanOrEqual(25_000);
  }, 30_000);
});
