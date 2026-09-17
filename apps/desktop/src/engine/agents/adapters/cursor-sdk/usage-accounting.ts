import type { TurnUsage } from "@zeros/protocol/agent-events";
import type { CursorAgentUsage } from "./adapter";
import { TurnUsageLedger } from "../shared/turn-usage";

const fields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
const valid = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;

export function cursorTokenUsage(raw: unknown): TurnUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const result: TurnUsage = {};
  for (const key of fields) {
    const value = (raw as Record<string, unknown>)[key];
    if (valid(value)) result[key] = value;
  }
  // Native Cursor input excludes both cache buckets (SDK totalTokens sums all
  // three). Canonical input is inclusive; cache counts are subsets for display.
  if (result.inputTokens !== undefined)
    result.inputTokens +=
      (result.cacheReadTokens ?? 0) + (result.cacheWriteTokens ?? 0);
  return Object.keys(result).length ? result : undefined;
}

export function sumCursorUsage(
  a: TurnUsage | undefined,
  b: TurnUsage | undefined,
): TurnUsage | undefined {
  if (!b) return a;
  const result = { ...a };
  for (const key of fields)
    if (b[key] !== undefined) result[key] = (a?.[key] ?? 0) + b[key];
  return result;
}

/** Local billing UUIDs are not client run IDs. Never attribute agent-wide
 * differences, a sole recent bill, timestamps or matching token counts. */
export function cursorRunUsage(
  snapshot: CursorAgentUsage | undefined,
  runId: string | undefined,
): TurnUsage | undefined {
  if (!runId) return undefined;
  const matches =
    snapshot?.runs?.filter((entry) => entry.runId === runId) ?? [];
  if (matches.length !== 1) return undefined;
  const entry = matches[0];
  const tokens = cursorTokenUsage(entry.usage);
  return valid(entry.cost?.chargedCents)
    ? { ...tokens, totalCostUsd: entry.cost.chargedCents / 100 }
    : tokens;
}

/** One bounded polling lane per provider execution, independent of chat focus.
 * Delayed bills replace absolute snapshots for their original Zeros turn. */
export class CursorUsageReconciler {
  private readonly ledger: TurnUsageLedger;
  private readonly pending = new Map<
    string,
    { turnId: string; usage?: TurnUsage; attempts: number }
  >();
  private readonly runs = new Map<
    string,
    { turnId: string; usage?: TurnUsage }
  >();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(
    private readonly read: () => Promise<CursorAgentUsage | undefined>,
    emit: (turnId: string, usage: TurnUsage) => void,
  ) {
    this.ledger = new TurnUsageLedger(emit);
  }

  async finish(
    turnId: string | undefined,
    runId: string | undefined,
    usage: TurnUsage | undefined,
  ): Promise<TurnUsage | undefined> {
    if (this.disposed) return this.ledger.replace(undefined, usage, "reported");
    const billed = cursorRunUsage(await this.read(), runId);
    // RunResult usage is the sum of the run's native turns. The exact billing
    // entry owns its dollars; it may fill missing token data only.
    const combined =
      billed || usage
        ? {
            ...billed,
            ...usage,
            ...(billed?.totalCostUsd !== undefined
              ? { totalCostUsd: billed.totalCostUsd }
              : {}),
          }
        : undefined;
    if (this.disposed) return this.ledger.replace(undefined, combined, "reported");
    if (!turnId || !runId)
      return this.ledger.replace(turnId, combined, "reported");
    const previous = this.runs.get(runId);
    if (previous && previous.turnId !== turnId) return undefined;
    this.runs.set(runId, { turnId, usage: combined });
    if (this.runs.size > 128) {
      const oldest = this.runs.keys().next().value!;
      this.runs.delete(oldest);
      this.pending.delete(oldest);
    }
    const result = this.publish(turnId);
    if (turnId && runId && billed?.totalCostUsd === undefined) {
      this.pending.set(runId, { turnId, usage, attempts: 0 });
      if (this.pending.size > 128)
        this.pending.delete(this.pending.keys().next().value!);
      this.schedule();
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
    this.runs.clear();
  }

  private publish(turnId: string): TurnUsage | undefined {
    const parts = [...this.runs.values()]
      .filter((run) => run.turnId === turnId)
      .map((run) => run.usage);
    if (!parts.some(Boolean)) return this.ledger.get(turnId);
    const usage: TurnUsage = {};
    for (const key of [...fields, "totalCostUsd"] as const) {
      if (parts.every((part) => valid(part?.[key]))) {
        usage[key] =
          Math.round(parts.reduce((sum, part) => sum + part![key]!, 0) * 1e12) /
          1e12;
      }
    }
    return this.ledger.replace(turnId, usage, "reported");
  }

  private schedule(): void {
    if (this.timer || this.disposed || !this.pending.size) return;
    const attempts = Math.min(
      ...[...this.pending.values()].map((job) => job.attempts),
    );
    this.timer = setTimeout(
      () => {
        void this.reconcile();
      },
      [3_000, 10_000, 30_000, 60_000][attempts] ?? 60_000,
    );
    this.timer.unref?.();
  }

  private async reconcile(): Promise<void> {
    const snapshot = await this.read();
    this.timer = undefined;
    if (this.disposed) return;
    for (const [runId, job] of this.pending) {
      const billed = cursorRunUsage(snapshot, runId);
      if (billed?.totalCostUsd !== undefined) {
        this.runs.set(runId, {
          turnId: job.turnId,
          usage: { ...billed, ...job.usage, totalCostUsd: billed.totalCostUsd },
        });
        this.publish(job.turnId);
        this.pending.delete(runId);
      } else if (++job.attempts >= 4) this.pending.delete(runId);
    }
    this.schedule();
  }
}
