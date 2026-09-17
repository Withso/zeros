import { describe, expect, it } from "vitest";
import { turnUsageDisplay } from "../turn-usage-card";

describe("timer usage details", () => {
  it("shows one estimated cost and cache-inclusive input without counting cache twice", () => {
    expect(
      turnUsageDisplay("claude", {
        accountingVersion: 1,
        inputTokens: 415,
        outputTokens: 20,
        cacheReadTokens: 300,
        totalCostUsd: 5.34,
      }),
    ).toEqual({
      name: "Claude",
      input: "415",
      output: "20",
      cacheRead: "300",
      cost: "$5.34",
      estimated: true,
    });
  });
  it("distinguishes included Cursor usage from unknown cost and rejects invalid amounts", () => {
    expect(
      turnUsageDisplay("cursor", { accountingVersion: 1, totalCostUsd: 0 })
        .cost,
    ).toBe("$0.00");
    for (const amount of [undefined, -1, Number.NaN, Infinity]) {
      expect(
        turnUsageDisplay("cursor", {
          accountingVersion: 1,
          totalCostUsd: amount,
        }).cost,
      ).toBe("Unavailable");
    }
  });
  it("does not fabricate Codex USD or display uncorrectable legacy totals as turn cost", () => {
    expect(
      turnUsageDisplay("codex", { accountingVersion: 1, totalCostUsd: 5 }).cost,
    ).toBe("Unavailable");
    expect(turnUsageDisplay("claude", { totalCostUsd: 5 }).cost).toBe(
      "Unavailable",
    );
    expect(turnUsageDisplay("cursor", null)).toMatchObject({
      input: "Unavailable",
      output: "Unavailable",
      cacheRead: "Unavailable",
      cost: "Unavailable",
    });
    expect(
      turnUsageDisplay("codex", { inputTokens: 100, cacheReadTokens: 80 })
        .input,
    ).toBe("100");
  });
});
