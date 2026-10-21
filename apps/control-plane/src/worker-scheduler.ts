/** Notifications and durable deadlines are hints to claim work. Keep a separate poll deadline
 * so hints cannot postpone retries/maintenance, and retain one pending hint
 * while a tick is active so work committed during that tick is not lost. */
export class CloudWorkerScheduler {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private pending = false;
  private pollAt = 0;
  private workAt = Infinity;

  constructor(
    private readonly intervalMs: number,
    private readonly run: (periodic: boolean) => Promise<void>,
    private readonly onError: () => void,
    private readonly readNextDelayMs?: () => Promise<number | null>,
    private readonly options: { readBeforeRun?: boolean; jitter?: boolean } = {},
  ) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.execute();
  }

  notify(): void {
    if (!this.started || this.stopped || this.pending) return;
    this.pending = true;
    if (!this.active) this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.execute(), this.pending ? 0 : Math.max(0, Math.min(this.pollAt, this.workAt) - Date.now()));
    this.timer.unref();
  }

  private execute(): void {
    if (this.stopped) return;
    this.pending = false;
    this.workAt = Infinity;
    const periodic = Date.now() >= this.pollAt;
    this.active = Promise.resolve().then(async () => {
      try {
        if (this.options.readBeforeRun && this.readNextDelayMs) {
          const delay = await this.readNextDelayMs();
          if (this.stopped) return;
          // An empty queue only needs this read. Do not open a claim/write
          // transaction until the durable deadline says work can be due.
          if (delay === null || !Number.isFinite(delay) || delay > 0) {
            if (delay !== null && Number.isFinite(delay)) this.workAt = Date.now() + Math.max(100, delay);
            return;
          }
        }
        await this.run(periodic);
      } finally {
        if (periodic) this.pollAt = Date.now() + (this.options.jitter
          ? this.intervalMs * (0.5 + Math.random() * 0.5) : this.intervalMs);
      }
      if (this.stopped || !this.readNextDelayMs) return;
      const delay = await this.readNextDelayMs();
      // Another replica may hold an already-due claim. Debounce that case;
      // eligibility and ownership still come only from the normal transaction.
      if (delay !== null && Number.isFinite(delay)) this.workAt = Date.now() + Math.max(100, delay);
    }).catch(this.onError).finally(() => {
      this.active = undefined;
      if (!this.stopped) this.schedule();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
