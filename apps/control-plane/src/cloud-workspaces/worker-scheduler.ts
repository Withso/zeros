/** Notifications are hints to claim durable work. Keep a separate poll deadline
 * so hints cannot postpone retries/maintenance, and retain one pending hint
 * while a tick is active so work committed during that tick is not lost. */
export class CloudWorkerScheduler {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private pending = false;
  private pollAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly run: (periodic: boolean) => Promise<void>,
    private readonly onError: () => void,
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
    this.timer = setTimeout(() => this.execute(), this.pending ? 0 : Math.max(0, this.pollAt - Date.now()));
    this.timer.unref();
  }

  private execute(): void {
    if (this.stopped) return;
    this.pending = false;
    const periodic = Date.now() >= this.pollAt;
    this.active = Promise.resolve().then(() => this.run(periodic)).catch(this.onError).finally(() => {
      this.active = undefined;
      if (periodic) this.pollAt = Date.now() + this.intervalMs;
      if (!this.stopped) this.schedule();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
