import type { TurnUsage } from "@zeros/protocol/agent-events";

const counters = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalCostUsd",
] as const;

/** A bounded, execution-owned ledger. Native per-result deltas can extend a
 * completed user turn, while delayed billing replaces that turn's snapshot. */
export class TurnUsageLedger {
  private readonly turns = new Map<string, TurnUsage>();
  constructor(
    private readonly emit: (turnId: string, usage: TurnUsage) => void,
  ) {}

  get(turnId: string | undefined): TurnUsage | undefined {
    return turnId ? this.turns.get(turnId) : undefined;
  }

  add(
    turnId: string | undefined,
    delta: TurnUsage | undefined,
    costKind: TurnUsage["costKind"],
  ): TurnUsage | undefined {
    if (!delta) return this.get(turnId);
    if (!turnId) return this.replace(undefined, delta, costKind);
    const previous = this.turns.get(turnId);
    const next = { ...previous };
    for (const key of counters) {
      const value = delta[key];
      const valid =
        typeof value === "number" && Number.isFinite(value) && value >= 0;
      if (previous && (!valid || previous[key] === undefined)) delete next[key];
      else if (valid)
        next[key] = Math.round(((previous?.[key] ?? 0) + value) * 1e12) / 1e12;
    }
    if (delta.perModel) {
      const rows = new Map(
        (previous?.perModel ?? []).map((row) => [row.model, row]),
      );
      for (const row of delta.perModel) {
        const prev = rows.get(row.model);
        const merged = { ...prev, model: row.model };
        for (const key of [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
          "costUsd",
        ] as const) {
          if (row[key] !== undefined)
            merged[key] =
              Math.round(((prev?.[key] ?? 0) + row[key]) * 1e12) / 1e12;
        }
        rows.set(row.model, merged);
      }
      next.perModel = [...rows.values()].slice(0, 128);
    }
    return this.replace(turnId, next, costKind);
  }

  replace(
    turnId: string | undefined,
    usage: TurnUsage | undefined,
    costKind: TurnUsage["costKind"],
  ): TurnUsage | undefined {
    if (!usage) return this.get(turnId);
    const previous = this.get(turnId);
    const next: TurnUsage = { ...usage, accountingVersion: 1, costKind };
    delete next.revision;
    if (!turnId) return next;
    const comparable = { ...previous };
    delete comparable.revision;
    if (JSON.stringify(comparable) === JSON.stringify(next)) return previous;
    next.revision = (previous?.revision ?? 0) + 1;
    this.turns.set(turnId, next);
    if (this.turns.size > 128)
      this.turns.delete(this.turns.keys().next().value!);
    this.emit(turnId, next);
    return next;
  }
}
