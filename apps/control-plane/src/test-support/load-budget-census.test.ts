import pg from "pg";
import { describe, expect, it } from "vitest";
import { backgroundLimitFor, LOAD_BACKGROUND_BUDGETS, LOAD_BUDGETS, LoadBudgetProbe } from "./load-budget.js";
import { CENSUS_CAPTURE, CENSUS_PROFILES, CENSUS_ROUTES, censusCaptureTable, censusSchedule } from "./load-budget-census.js";

describe("captured app census profiles", () => {
  it.each([
    { name: "census-stopped", requests: 18, appTransactions: 49, allTransactions: 53 },
    { name: "census-connected", requests: 41, appTransactions: 114, allTransactions: 151 },
  ])("retains the count-only capture for $name without inventing worker HTTP counts", expected => {
    const profile = CENSUS_PROFILES.find(value => value.name === expected.name)!;
    const rows = censusCaptureTable().filter(row => row.scenario === profile.name);
    expect(rows.filter(row => row.replayed).reduce((sum, row) => sum + row.requests!, 0)).toBe(expected.requests);
    expect(rows.filter(row => row.replayed).reduce((sum, row) => sum + row.capturedTransactions, 0)).toBe(expected.appTransactions);
    expect(rows.reduce((sum, row) => sum + row.capturedTransactions, 0)).toBe(expected.allTransactions);
    expect(rows.filter(row => !row.replayed).every(row => row.requests === null)).toBe(true);
    const schedule = censusSchedule(profile);
    expect(schedule).toHaveLength(expected.requests);
    expect(schedule.every(row => row.at >= 0 && row.at < CENSUS_CAPTURE.windowMs)).toBe(true);
    for (const row of profile.routes) {
      expect(schedule.filter(value => value.operation === row.operation)).toHaveLength(row.requests);
      expect(CENSUS_ROUTES[row.operation].route.startsWith("/v1/")).toBe(true);
    }
  });

  it("permits only captured stream startup counts and one sequential timer window", () => {
    const authority = LOAD_BACKGROUND_BUDGETS.find(row => row.operation === "team-authority")!;
    const auth = LOAD_BACKGROUND_BUDGETS.find(row => row.operation === "auth-read")!;
    expect(backgroundLimitFor("idle", authority)).toEqual(authority);
    expect(backgroundLimitFor("census-connected", authority)).toMatchObject({ initialCalls: 2, periodsMs: authority.periodsMs });
    expect(backgroundLimitFor("census-connected", auth)).toEqual(auth);
    for (const limit of LOAD_BACKGROUND_BUDGETS) expect(backgroundLimitFor("census-stopped", limit))
      .toMatchObject({ initialCalls: 0, periodsMs: [], queries: 0, statements: 0, transactions: 0 });
    expect(backgroundLimitFor("idle", auth)).toMatchObject({ initialCalls: 0, periodsMs: [], queries: 0, statements: 0, transactions: 0 });
  });

  it.each([
    { scenario: "census-stopped", baseline: 18, maximum: 6 },
    { scenario: "census-connected", baseline: 41, maximum: 10 },
  ])("keeps the observed requests and R1 target for $scenario", ({ scenario, baseline, maximum }) => {
    expect(LOAD_BUDGETS.find(row => row.scenario === scenario && row.metric === "requests"))
      .toMatchObject({ phase: "R1", baseline, maximum, expectedFailure: true });
  });

  it.each([
    { method: "GET", route: "/v1/auth/snapshot" },
    { method: "GET", route: "/v1/auth/events" },
    { method: "POST", route: "/v1/cloud-v2/workspaces/:id/github" },
  ])("accounts for the captured $method $route route", async ({ method, route }) => {
    const pool = new pg.Pool(), probe = new LoadBudgetProbe(pool);
    try {
      const request = new Request(`https://api.example.test${route.replace(":id", "workspace")}`, { method });
      const { cost } = await probe.measure("census-connected", () => probe.request(request, () => new Response()));
      expect(cost.requests).toMatchObject([{ method, route, status: 200 }]);
    } finally { probe.close(); await pool.end(); }
  });
});
