import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CursorUsageReconciler,
  cursorRunUsage,
  cursorTokenUsage,
} from "../usage-accounting";

const tokens = {
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 50,
  cacheWriteTokens: 5,
  totalTokens: 165,
};
const entry = (runId: string, cents?: number) => ({
  runId,
  usage: tokens,
  ...(cents === undefined
    ? {}
    : { cost: { rawCostCents: cents, chargedCents: cents } }),
});
const snapshot = (runs: ReturnType<typeof entry>[]) => ({
  usage: tokens,
  cost: { rawCostCents: 100, chargedCents: 100 },
  runs,
});
afterEach(() => vi.useRealTimers());
describe("Cursor owned usage", () => {
  it("requires exact run identity, including when a prior bill arrives late", () => {
    expect(cursorRunUsage(snapshot([entry("a", 25)]), "b")).toBeUndefined();
    expect(cursorRunUsage(snapshot([]), "b")).toBeUndefined();
    expect(cursorRunUsage(snapshot([entry("b", 0)]), "b")).toMatchObject({
      totalCostUsd: 0,
      inputTokens: 155,
    });
    expect(
      cursorRunUsage(snapshot([entry("b")]), "b")?.totalCostUsd,
    ).toBeUndefined();
  });
  it("normalizes cache-inclusive input without inventing missing counts", () => {
    expect(cursorTokenUsage(tokens)).toMatchObject({
      inputTokens: 155,
      outputTokens: 10,
      cacheReadTokens: 50,
    });
    expect(cursorTokenUsage({ outputTokens: 0 })).toEqual({ outputTokens: 0 });
    expect(
      cursorTokenUsage({ inputTokens: Number.NaN, outputTokens: -1 }),
    ).toBeUndefined();
  });
  it("updates the earlier turn once when billing settles during the next turn", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(snapshot([]));
    const emit = vi.fn();
    const usage = new CursorUsageReconciler(read, emit);
    await usage.finish("turn-a", "a", cursorTokenUsage(tokens));
    await usage.finish("turn-b", "b", cursorTokenUsage(tokens));
    read.mockResolvedValue(snapshot([entry("a", 20), entry("b", 0)]));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(
      emit.mock.calls.filter(
        ([id, u]) => id === "turn-a" && u.totalCostUsd === 0.2,
      ),
    ).toHaveLength(1);
    expect(
      emit.mock.calls.filter(
        ([id, u]) => id === "turn-b" && u.totalCostUsd === 0,
      ),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    usage.dispose();
  });
  it("combines retried runs in one user turn when the earlier attempt bills late", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(snapshot([entry("retry", 10)]));
    const emit = vi.fn();
    const usage = new CursorUsageReconciler(read, emit);
    await usage.finish("turn", "first", cursorTokenUsage(tokens));
    await usage.finish("turn", "retry", cursorTokenUsage(tokens));
    read.mockResolvedValue(snapshot([entry("first", 20), entry("retry", 10)]));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({
      totalCostUsd: 0.3,
      inputTokens: 310,
    });
    usage.dispose();
  });

  it("bounds unavailable billing retries and cancels them on disposal", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(undefined);
    const emit = vi.fn();
    const usage = new CursorUsageReconciler(read, emit);
    await usage.finish("turn", "run", cursorTokenUsage(tokens));
    usage.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
