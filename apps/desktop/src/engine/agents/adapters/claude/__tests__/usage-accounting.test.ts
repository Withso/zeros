import { describe, expect, it } from "vitest";
import { ClaudeStreamTranslator } from "../translator";

function setup() {
  return new ClaudeStreamTranslator({ sessionId: "execution", emit: () => {} });
}

function result(uuid: string, cost: number, tokens = 100) {
  return {
    type: "result",
    subtype: "success",
    uuid,
    session_id: "native",
    total_cost_usd: cost,
    // Main-loop usage intentionally differs from the whole model tree.
    usage: { input_tokens: 7, output_tokens: 3 },
    modelUsage: {
      "claude-opus-5": {
        inputTokens: tokens,
        outputTokens: tokens / 2,
        cacheReadInputTokens: tokens * 2,
        cacheCreationInputTokens: tokens / 10,
        costUSD: cost,
      },
    },
  };
}

describe("Claude query usage accounting", () => {
  it("reports each result's increment with whole-tree tokens and inclusive input", () => {
    const t = setup();
    t.beginProcess();
    t.beginTurn();
    t.feed(result("first", 0.1));
    expect(t.turnUsage).toMatchObject({
      inputTokens: 310,
      outputTokens: 50,
      cacheReadTokens: 200,
      totalCostUsd: 0.1,
    });
    t.beginTurn();
    t.feed({ type: "system", subtype: "init", session_id: "native" });
    t.feed(result("second", 0.15, 150));
    expect(t.turnUsage?.totalCostUsd).toBeCloseTo(0.05);
    expect(t.turnUsage).toMatchObject({
      inputTokens: 155,
      outputTokens: 25,
      cacheReadTokens: 100,
    });
  });

  it("starts fresh on query replacement even when resuming the same conversation", () => {
    const t = setup();
    t.feed(result("old", 0.4));
    t.beginProcess();
    t.beginTurn();
    t.feed(result("resumed", 0.06, 20));
    expect(t.turnUsage?.totalCostUsd).toBe(0.06);
  });

  it("resets at a native conversation reset exactly once", () => {
    const t = setup();
    t.feed(result("old", 0.4));
    const reset = {
      type: "conversation_reset",
      uuid: "reset",
      session_id: "native",
      new_conversation_id: "cleared",
    };
    t.feed(reset);
    t.feed({ ...result("clear-result", 0.02, 10), session_id: "cleared" });
    t.feed(reset);
    t.feed({ ...result("next", 0.05, 30), session_id: "cleared" });
    expect(t.turnUsage?.totalCostUsd).toBeCloseTo(0.03);
  });

  it("does not lower a baseline for zeroed crash results or stale counters", () => {
    const t = setup();
    t.feed(result("old", 0.1));
    t.beginTurn();
    t.feed({
      ...result("crash", 0, 0),
      is_error: true,
      subtype: "error_during_execution",
      usage: {},
    });
    expect(t.turnUsage?.totalCostUsd).toBeUndefined();
    t.feed(result("stale", 0.08, 80));
    expect(t.turnUsage?.totalCostUsd).toBeUndefined();
    t.feed(result("recovered", 0.15, 150));
    expect(t.turnUsage?.totalCostUsd).toBeCloseTo(0.05);
  });

  it("deduplicates result IDs, counts repeated totals as zero, and clears turn-local usage", () => {
    const t = setup();
    const first = result("first", 0.1);
    t.feed(first);
    t.beginTurn();
    expect(t.turnUsage).toBeUndefined();
    expect(t.feed(first)).toBe(false);
    expect(t.turnUsage).toBeUndefined();
    t.feed(result("no-new-work", 0.1));
    expect(t.turnUsage?.totalCostUsd).toBe(0);
  });

  it("includes newly used child models once and never counts child result frames again", () => {
    const t = setup();
    t.feed(result("first", 0.1));
    const next = result("next", 0.2, 150);
    t.feed({
      ...result("child-result", 0.5, 500),
      parent_tool_use_id: "child",
    });
    t.feed({
      ...next,
      modelUsage: {
        ...next.modelUsage,
        "claude-haiku-4-5": {
          inputTokens: 20,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
        },
      },
    });
    expect(t.turnUsage).toMatchObject({ inputTokens: 175, outputTokens: 30 });
    expect(t.turnUsage?.totalCostUsd).toBeCloseTo(0.1);
  });

  it("does not assign an unobserved accounting interval to the next turn", () => {
    const t = setup();
    t.feed(result("a", 0.1));
    t.feed({
      type: "result",
      uuid: "missing",
      usage: { input_tokens: 999, output_tokens: 888 },
    });
    expect(t.turnUsage).toBeUndefined();
    t.feed(result("baseline", 0.3, 300));
    expect(t.turnUsage?.inputTokens).toBeUndefined();
    expect(t.turnUsage?.totalCostUsd).toBeUndefined();
    t.feed(result("c", 0.35, 350));
    expect(t.turnUsage).toMatchObject({ totalCostUsd: 0.05, inputTokens: 155 });
  });

  it("retains reported cost without aggregate usage and rejects invalid numbers", () => {
    const t = setup();
    t.feed({ type: "result", uuid: "cost-only", total_cost_usd: 0.1 });
    expect(t.turnUsage?.totalCostUsd).toBe(0.1);
    t.feed({
      ...result("invalid", Number.NaN),
      modelUsage: {
        opus: { inputTokens: -1, outputTokens: Number.POSITIVE_INFINITY },
      },
    });
    expect(t.turnUsage?.totalCostUsd).toBeUndefined();
    expect(t.turnUsage?.outputTokens).toBeUndefined();
  });
});
