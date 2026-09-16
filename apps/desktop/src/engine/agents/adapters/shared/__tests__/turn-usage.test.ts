import { expect, it, vi } from "vitest";
import { TurnUsageLedger } from "../turn-usage";

it("adds continuations to one turn, retains missing snapshots and emits absolute revisions", () => {
  const emit = vi.fn();
  const ledger = new TurnUsageLedger(emit);
  ledger.add("a", { inputTokens: 100, totalCostUsd: 0.1 }, "estimated");
  const second = ledger.add(
    "a",
    { inputTokens: 50, totalCostUsd: 0.05 },
    "estimated",
  );
  expect(second).toMatchObject({
    revision: 2,
    inputTokens: 150,
    totalCostUsd: 0.15,
  });
  expect(ledger.add("a", undefined, "estimated")).toEqual(second);
  ledger.replace("a", second, "estimated");
  expect(emit).toHaveBeenCalledTimes(2);
  expect(ledger.add("b", { totalCostUsd: 0 }, "estimated")).toMatchObject({
    revision: 1,
    totalCostUsd: 0,
  });
});

it("does not present a partially reported continuation as a complete total", () => {
  const ledger = new TurnUsageLedger(() => {});
  ledger.add("a", { inputTokens: 100, totalCostUsd: 0.1 }, "estimated");
  const partial = ledger.add("a", { inputTokens: 50 }, "estimated");
  expect(partial?.inputTokens).toBe(150);
  expect(partial?.totalCostUsd).toBeUndefined();
  const next = ledger.add(
    "a",
    { inputTokens: 20, totalCostUsd: 0.05 },
    "estimated",
  );
  expect(next?.totalCostUsd).toBeUndefined();
});
