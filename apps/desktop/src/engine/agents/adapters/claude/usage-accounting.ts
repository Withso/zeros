import type { TurnModelUsage, TurnUsage } from "@zeros/protocol/agent-events";

type NativeModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
};

export interface ClaudeUsageResult {
  is_error?: boolean;
  total_cost_usd?: number;
  modelUsage?: Record<string, NativeModelUsage>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Query generations, not turns or system/init frames, own these counters.
 * modelUsage includes the main loop, children and query-owned auxiliary work.
 * Never add main-loop usage or child results on top of those totals. */
export class ClaudeQueryUsage {
  private counters = new Map<string, number>();
  private modelBaselineKnown = true;
  private costBaselineKnown = true;

  reset(): void {
    this.counters.clear();
    this.modelBaselineKnown = true;
    this.costBaselineKnown = true;
  }

  private delta(key: string, value: unknown): number | undefined {
    const next = number(value);
    if (next === undefined) return undefined;
    const before = this.counters.get(key) ?? 0;
    // A regressed/zeroed crash snapshot is not a reset. Retain the last
    // confirmed baseline so the next real result cannot bill it again.
    if (next < before) return undefined;
    this.counters.set(key, next);
    return Math.round((next - before) * 1e12) / 1e12;
  }

  record(event: ClaudeUsageResult): TurnUsage | undefined {
    const models =
      event.modelUsage && typeof event.modelUsage === "object"
        ? Object.entries(event.modelUsage).slice(0, 128)
        : [];
    // Fatal SDK results can contain an entirely zeroed estimate. It is
    // unavailable accounting, not proof the failed work was free.
    if (
      event.is_error &&
      !(number(event.total_cost_usd) ?? 0) &&
      !models.some(
        ([, v]) => v && Object.values(v).some((n) => (number(n) ?? 0) > 0),
      )
    ) {
      return undefined;
    }
    const cost = this.delta("totalCostUsd", event.total_cost_usd);
    const totalCostUsd = this.costBaselineKnown ? cost : undefined;
    this.costBaselineKnown = number(event.total_cost_usd) !== undefined;
    const hadModelBaseline = this.modelBaselineKnown;
    this.modelBaselineKnown =
      !!event.modelUsage && typeof event.modelUsage === "object";
    const perModel: TurnModelUsage[] = [];
    for (const [model, value] of models) {
      if (!model || model.length > 200 || !value || typeof value !== "object")
        continue;
      // A bounded model ledger is deliberately conservative if a malformed
      // provider invents unbounded model names during a persistent query.
      const prefix = `${model}:`;
      if (
        this.counters.size > 768 &&
        !this.counters.has(`${prefix}inputTokens`)
      )
        continue;
      const input = this.delta(`${prefix}inputTokens`, value.inputTokens);
      const cacheReadTokens = this.delta(
        `${prefix}cacheReadTokens`,
        value.cacheReadInputTokens,
      );
      const cacheWriteTokens = this.delta(
        `${prefix}cacheWriteTokens`,
        value.cacheCreationInputTokens,
      );
      const row: TurnModelUsage = {
        model,
        inputTokens:
          input === undefined
            ? undefined
            : input + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
        outputTokens: this.delta(`${prefix}outputTokens`, value.outputTokens),
        cacheReadTokens,
        cacheWriteTokens,
        costUsd: this.delta(`${prefix}costUsd`, value.costUSD),
      };
      if (
        hadModelBaseline &&
        Object.entries(row).some(
          ([key, value]) => key !== "model" && value !== undefined,
        )
      )
        perModel.push(row);
    }
    const sum = (
      key:
        | "inputTokens"
        | "outputTokens"
        | "cacheReadTokens"
        | "cacheWriteTokens",
    ) => {
      const values = perModel
        .map((row) => row[key])
        .filter((n): n is number => n !== undefined);
      return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
    };
    // Aggregate `usage` covers only the main loop. Substituting it here
    // would mix scopes with query-wide dollars and double-count a later full
    // modelUsage snapshot. Unknown intervals establish a fresh baseline only.
    const result: TurnUsage = {
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      ...(perModel.length
        ? {
            perModel: perModel.sort(
              (a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0),
            ),
          }
        : {}),
    };
    if (totalCostUsd !== undefined) result.totalCostUsd = totalCostUsd;
    return Object.values(result).some((v) => v !== undefined)
      ? result
      : undefined;
  }
}
