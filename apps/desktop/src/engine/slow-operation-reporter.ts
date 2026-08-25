interface SlowOperationReporterOptions {
  readonly thresholdMs: number;
  readonly windowMs: number;
  readonly maxOperations?: number;
  readonly warn?: (message: string) => void;
}

interface OperationStats {
  count: number;
  maxMs: number;
  totalMs: number;
}

/** Rate-limited diagnostics for workspace calls. A subprocess storm must leave
 * evidence, but writing one warning per completion amplifies the storm and
 * makes the useful chronology unreadable. */
export class SlowOperationReporter {
  private readonly thresholdMs: number;
  private readonly windowMs: number;
  private readonly maxOperations: number;
  private readonly warn: (message: string) => void;
  private readonly operations = new Map<string, OperationStats>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private totalCalls = 0;

  public constructor(options: SlowOperationReporterOptions) {
    this.thresholdMs = Math.max(0, options.thresholdMs);
    this.windowMs = Math.max(1, options.windowMs);
    this.maxOperations = Math.max(1, options.maxOperations ?? 6);
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  public observe(operation: string, elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < this.thresholdMs) return;
    const firstInWindow = this.totalCalls === 0;
    const stats = this.operations.get(operation) ?? {
      count: 0,
      maxMs: 0,
      totalMs: 0,
    };
    stats.count += 1;
    stats.maxMs = Math.max(stats.maxMs, elapsedMs);
    stats.totalMs += elapsedMs;
    this.operations.set(operation, stats);
    this.totalCalls += 1;

    if (!firstInWindow) return;
    this.warn(
      `[workspace] slow operations detected (first: ${operation} ${Math.round(elapsedMs)}ms); aggregating for ${this.windowMs}ms`,
    );
    this.timer = setTimeout(() => this.flush(), this.windowMs);
    this.timer.unref?.();
  }

  /** Flush is public so an orderly engine shutdown can preserve the summary. */
  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.totalCalls === 0) return;
    if (this.totalCalls === 1) {
      this.operations.clear();
      this.totalCalls = 0;
      return;
    }

    const ranked = [...this.operations.entries()].sort(
      ([leftName, left], [rightName, right]) =>
        right.count - left.count ||
        right.maxMs - left.maxMs ||
        leftName.localeCompare(rightName),
    );
    const shown = ranked.slice(0, this.maxOperations).map(([name, stats]) => {
      const average = Math.round(stats.totalMs / stats.count);
      return `${name}=${stats.count} avg=${average}ms max=${Math.round(stats.maxMs)}ms`;
    });
    const hidden = ranked.length - shown.length;
    this.warn(
      `[workspace] slow-operation summary: ${this.totalCalls} calls; ${shown.join("; ")}${hidden > 0 ? `; +${hidden} other ops` : ""}`,
    );
    this.operations.clear();
    this.totalCalls = 0;
  }
}
