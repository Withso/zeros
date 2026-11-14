import pg from "pg";
import { describe, expect, it } from "vitest";
import { budgetTable, LOAD_BUDGETS, LoadBudgetProbe, scenarioTotals, workspaceUpdateLocks } from "./load-budget.js";

describe("request and background ratchets", () => {
  it("keeps the recorded HTTP cost independent of a background timer landing in the window", async () => {
    const pool = new pg.Pool(), probe = new LoadBudgetProbe(pool);
    try {
      const { cost } = await probe.measure("idle", async () => {
        await probe.request(new Request("https://api.example.test/_load-budget/request"), async () => new Response());
      }, { writes: true, locks: true });
      cost.requests[0]!.statements = 4425;
      for (const statements of [25, 30]) {
        cost.background.statements = statements;
        const measured = budgetTable(new Map(LOAD_BUDGETS.map(row => [row.scenario, cost])));
        expect(measured.find(row => row.scenario === "idle" && row.metric === "statements"))
          .toMatchObject({ observed: 4425, baseline: 4425, ratchet: "PASS", targetObserved: 4425 + statements });
      }
      cost.requests[0]!.statements++;
      expect(budgetTable(new Map(LOAD_BUDGETS.map(row => [row.scenario, cost])))
        .find(row => row.scenario === "idle" && row.metric === "statements"))
        .toMatchObject({ observed: 4426, ratchet: "FAIL" });
    } finally { probe.close(); await pool.end(); }
  });
});

it("refuses an unregistered route even when the client catches the failed request", async () => {
  const pool = new pg.Pool();
  const probe = new LoadBudgetProbe(pool);
  try {
    await expect(probe.measure("unknown-route", async () => {
      await probe.request(new Request("https://api.example.test/unknown-route"), () => new Response(null, { status: 200 })).catch(() => {});
    })).rejects.toThrow("Load replay reached an unregistered route");
  } finally { probe.close(); await pool.end(); }
});

describe("workspace update-lock measurement", () => {
  it.each([
    ["SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", 1],
    ['SELECT w.id FROM public."cloud_v2_workspaces" AS w FOR NO KEY UPDATE OF w NOWAIT', 1],
    ["SELECT w.id FROM cloud_v2_workspaces w JOIN cloud_v2_execution_contexts c ON c.workspace_id=w.id FOR UPDATE OF c", 0],
    ["SELECT w.id FROM cloud_v2_workspaces w JOIN cloud_v2_execution_contexts c ON c.workspace_id=w.id FOR UPDATE OF w,c", 1],
    ["SELECT 1 FROM cloud_v2_workspaces FOR KEY SHARE", 0],
    ["SELECT 'FROM cloud_v2_workspaces FOR UPDATE', $$FOR UPDATE$$", 0],
    ["SELECT 1 FROM cloud_v2_workspaces /* FOR UPDATE /* nested */ */ -- FOR UPDATE\n", 0],
    ["WITH locked AS (SELECT id FROM cloud_v2_execution_contexts FOR UPDATE) SELECT id FROM cloud_v2_workspaces", 0],
    ["WITH locked AS (SELECT id FROM cloud_v2_workspaces FOR UPDATE) SELECT id FROM locked", 1],
    ["SELECT w.id FROM cloud_v2_execution_contexts c, cloud_v2_workspaces w FOR UPDATE OF w", 1],
    ["SELECT id FROM ONLY (cloud_v2_workspaces) FOR UPDATE", 1],
    ["SELECT w.id FROM (SELECT id FROM cloud_v2_workspaces) AS w FOR UPDATE OF w", 1],
    ["SELECT c.id FROM cloud_v2_execution_contexts c WHERE EXISTS (SELECT 1 FROM cloud_v2_workspaces) FOR UPDATE OF c", 0],
    ["BEGIN; SELECT id FROM cloud_v2_workspaces FOR UPDATE; SELECT 'a;b'; SELECT id FROM cloud_v2_workspaces FOR UPDATE; COMMIT", 2],
  ])("counts workspace lock statements without retaining SQL: %s", (sql, count) => {
    expect(workspaceUpdateLocks(sql)).toBe(count);
  });

  it("rejects unobserved or incomplete SQL instead of returning a false zero", () => {
    for (const sql of [undefined, "SELECT 'unterminated", "/* unterminated", "SELECT $$unterminated"]) {
      expect(() => workspaceUpdateLocks(sql)).toThrow("Load lock observation");
    }
  });
});

describe("GitHub request measurement", () => {
  it("counts actual transport calls, including failures and detached work, without storing URLs or credentials", async () => {
    const pool = new pg.Pool();
    const probe = new LoadBudgetProbe(pool);
    try {
      const { cost } = await probe.measure("github-control", async () => {
        await probe.githubRequest(() => Promise.resolve(new Response(null, { status: 404 })));
        const request = new Request("https://api.example.test/_load-budget/github");
        await probe.request(request, async () => {
          await probe.githubRequest(() => Promise.resolve(new Response(null, { status: 200 })));
          await probe.githubRequest(() => Promise.reject(new Error("synthetic network failure"))).catch(() => {});
          return new Response(null, { status: 200 });
        });
      });
      expect(cost.background.githubCalls).toBe(1);
      expect(cost.requests[0]?.githubCalls).toBe(2);
      expect(scenarioTotals(cost).githubCalls).toBe(3);
      expect(JSON.stringify(cost)).not.toContain("synthetic network failure");
    } finally { probe.close(); await pool.end(); }
  });
});
