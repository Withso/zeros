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
      try { await this.run(periodic); }
      finally { if (periodic) this.pollAt = Date.now() + this.intervalMs; }
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
