import { describe, expect, it } from "vitest";
import { CodexAppServerTranslator } from "../app-server-translator";

function setup() {
  return new CodexAppServerTranslator({
    sessionId: "execution",
    emit: () => {},
  });
}
function usage(
  t: CodexAppServerTranslator,
  total: number,
  last: number,
  turnId = "a",
) {
  t.handle("thread/tokenUsage/updated", {
    threadId: "native",
    turnId,
    tokenUsage: {
      total: {
        inputTokens: total,
        outputTokens: total / 2,
        cachedInputTokens: total / 4,
        cacheWriteInputTokens: 0,
        totalTokens: total * 1.5,
      },
      last: {
        inputTokens: last,
        outputTokens: last / 2,
        cachedInputTokens: last / 4,
        cacheWriteInputTokens: 0,
        totalTokens: last * 1.5,
      },
    },
  });
}
function start(t: CodexAppServerTranslator, id: string) {
  t.startTurn();
  t.handle("turn/started", { threadId: "native", turn: { id } });
}
describe("Codex turn usage", () => {
  it("counts all requests in a turn, not only the final request", () => {
    const t = setup();
    start(t, "a");
    usage(t, 100, 100);
    usage(t, 240, 140);
    expect(t.turnUsage).toMatchObject({
      inputTokens: 240,
      outputTokens: 120,
      cacheReadTokens: 60,
    });
    expect(t.turnUsage?.totalCostUsd).toBeUndefined();
    // Same native snapshot is also emitted for rate-limit updates.
    usage(t, 240, 140);
    expect(t.turnUsage?.inputTokens).toBe(240);
    start(t, "b");
    usage(t, 280, 40, "b");
    expect(t.turnUsage?.inputTokens).toBe(40);
  });
  it("does not count restored thread totals or late results from a prior turn", () => {
    const t = setup();
    usage(t, 1000, 100, "old");
    start(t, "new");
    usage(t, 1100, 100, "old");
    usage(t, 1040, 40, "new");
    expect(t.turnUsage?.inputTokens).toBe(40);
  });
  it("keeps billed work through context-only compaction snapshots", () => {
    const t = setup();
    start(t, "a");
    usage(t, 100, 100);
    t.handle("thread/tokenUsage/updated", {
      threadId: "native",
      turnId: "a",
      tokenUsage: {
        total: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 40000,
        },
        last: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 40000,
        },
      },
    });
    usage(t, 40, 40);
    expect(t.turnUsage).toMatchObject({ inputTokens: 140, outputTokens: 70 });
  });
  it("does not charge restored history when resume omitted a baseline notification", () => {
    const t = new CodexAppServerTranslator({
      sessionId: "execution",
      emit: () => {},
      resumed: true,
    });
    start(t, "new");
    usage(t, 1040, 40, "new");
    usage(t, 1100, 60, "new");
    expect(t.turnUsage?.inputTokens).toBe(100);
  });
  it("does not report negative or nonfinite usage", () => {
    const t = setup();
    start(t, "a");
    usage(t, 100, 100);
    usage(t, 80, -20);
    usage(t, Number.NaN, Number.NaN);
    expect(t.turnUsage?.inputTokens).toBe(100);
  });
});
