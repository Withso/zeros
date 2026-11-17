import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { observeTransactionTiming } from "../../request-timing.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// Every send of every busy workspace pays these; PS-10 saturates near 350 transactions a minute (Alpha, 2026-11-17).
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("an active-mode prompt send's transactions", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(async () => { f = await executionFixture(pool, { teamOwnership: true }); await f.login(); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); await f?.cp.teamSharing.signals.close(); });
  afterAll(() => pool.end());

  const counted = async (run: () => Promise<Response>) => {
    let transactions = -1;
    const response = await observeTransactionTiming(run, summary => { transactions = summary.transactions; });
    return { status: response.status, transactions };
  };

  it("reads the execution mode once per request: mode, admission, enqueue", async () => {
    expect((await f.send()).status).toBe(201);
    expect(await counted(() => f.send())).toEqual({ status: 201, transactions: 3 });
  });
});
