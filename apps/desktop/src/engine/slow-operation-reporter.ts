import { monitorEventLoopDelay } from "node:perf_hooks";

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
  private eventLoopMaxMs = 0;
  private eventLoop: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private eventLoopUnavailable = false;
  private activeObservations = 0;
  private disposed = false;

  public constructor(options: SlowOperationReporterOptions) {
    this.thresholdMs = Math.max(0, options.thresholdMs);
    this.windowMs = Math.max(1, options.windowMs);
    this.maxOperations = Math.max(1, options.maxOperations ?? 6);
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Local callers opt in while work is active. One bounded histogram covers
   * overlapping operations, so its maximum describes the shared observation
   * window; it is disabled when the last operation settles. */
  public beginEventLoopObservation(): () => number | null {
    if (this.disposed || this.eventLoopUnavailable) return () => null;
    try {
      this.eventLoop ??= monitorEventLoopDelay({ resolution: 50 });
      if (this.activeObservations === 0) {
        this.eventLoop.reset();
        this.eventLoop.enable();
      }
    } catch {
      this.eventLoopUnavailable = true;
      this.disableEventLoop();
      return () => null;
    }
    this.activeObservations += 1;
    let finished = false;
    let measured: number | null = null;
    return () => {
      if (finished || this.disposed) return measured;
      finished = true;
      try {
        const maximum = this.eventLoop!.max / 1_000_000;
        measured = Number.isFinite(maximum) && maximum >= 0 ? maximum : null;
      } catch {
        this.eventLoopUnavailable = true;
      } finally {
        if (--this.activeObservations === 0) this.disableEventLoop();
      }
      return measured;
    };
  }

  public observe(operation: string, elapsedMs: number, eventLoopMaxMs?: number | null): void {
    if (this.disposed) return;
    if (!Number.isFinite(elapsedMs) || elapsedMs < this.thresholdMs) return;
    if (typeof eventLoopMaxMs === "number" && Number.isFinite(eventLoopMaxMs)) {
      this.eventLoopMaxMs = Math.max(this.eventLoopMaxMs, eventLoopMaxMs);
    }
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
      `[workspace] slow operations detected (first: ${operation} ${Math.round(elapsedMs)}ms); aggregating for ${this.windowMs}ms${this.eventLoopSuffix()}`,
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
      this.eventLoopMaxMs = 0;
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
      `[workspace] slow-operation summary: ${this.totalCalls} calls; ${shown.join("; ")}${hidden > 0 ? `; +${hidden} other ops` : ""}${this.eventLoopSuffix()}`,
    );
    this.operations.clear();
    this.totalCalls = 0;
    this.eventLoopMaxMs = 0;
  }

  private eventLoopSuffix(): string {
    return this.eventLoopMaxMs > 0 ? `; eventLoopMax=${Math.round(this.eventLoopMaxMs)}ms` : "";
  }

  private disableEventLoop(): void {
    try {
      this.eventLoop?.disable();
    } catch {
      this.eventLoopUnavailable = true;
    }
  }

  public dispose(): void {
    this.flush();
    this.disposed = true;
    this.disableEventLoop();
    this.eventLoop = null;
    this.activeObservations = 0;
  }
}
