import type { TurnUsage } from "@zeros/protocol/agent-events";

const fields = {
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  cachedInputTokens: "cacheReadTokens",
  cacheWriteInputTokens: "cacheWriteTokens",
  reasoningOutputTokens: "reasoningTokens",
} as const;
type Counters = Partial<Record<keyof typeof fields, number>> & {
  totalTokens?: number;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** TokenUsage.last is one inference, and can be re-emitted unchanged. Use
 * cumulative deltas for the turn; the last snapshot still owns context fill. */
export class CodexTurnUsage {
  private previous: Counters = {};
  private current: TurnUsage | undefined;
  private nativeTurnId: string | undefined;
  private needsBaseline: boolean;
  constructor(resumed = false) {
    this.needsBaseline = resumed;
  }
  private readonly retiredTurns = new Set<string>();

  start(): void {
    if (this.nativeTurnId) {
      this.retiredTurns.add(this.nativeTurnId);
      if (this.retiredTurns.size > 256)
        this.retiredTurns.delete(this.retiredTurns.values().next().value!);
    }
    this.nativeTurnId = undefined;
    this.current = undefined;
  }

  bind(turnId: string): void {
    if (!this.retiredTurns.has(turnId)) this.nativeTurnId = turnId;
  }

  record(
    turnId: unknown,
    total?: Counters,
    last?: Counters,
  ): TurnUsage | undefined {
    if (typeof turnId === "string") {
      if (
        this.retiredTurns.has(turnId) ||
        (this.nativeTurnId && this.nativeTurnId !== turnId)
      )
        return this.current;
      this.nativeTurnId = turnId;
    }
    // Compaction/context-capacity reports can reset usage counters without
    // running inference. Rebase future deltas without erasing billed work.
    const contextOnly =
      last?.inputTokens === 0 &&
      last.outputTokens === 0 &&
      finite(last.totalTokens) &&
      last.totalTokens > 0;
    const seedFromLast = this.needsBaseline;
    this.needsBaseline = false;
    for (const [native, canonical] of Object.entries(fields) as Array<
      [keyof typeof fields, (typeof fields)[keyof typeof fields]]
    >) {
      const next = total?.[native];
      if (finite(next)) {
        if (!contextOnly) {
          const delta = seedFromLast
            ? finite(last?.[native])
              ? last[native]
              : 0
            : next - (this.previous[native] ?? 0);
          if (delta < 0) continue;
          this.current ??= {};
          this.current[canonical] = (this.current[canonical] ?? 0) + delta;
        }
        this.previous[native] = next;
      }
      // A missing cumulative field cannot be reconstructed by summing last:
      // the native protocol repeats last for non-inference notifications.
    }
    return this.current;
  }
}
