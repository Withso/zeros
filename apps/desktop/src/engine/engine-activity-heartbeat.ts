export interface EngineActivityFrame {
  type: "engine.heartbeat";
  instance: string;
  sequence: number;
  activeRequests: number;
  activeTurns: number;
}

/** Private host evidence that this exact engine is progressing through work.
 * HTTP can be delayed by workspace load; its supervisor must not infer that
 * every workspace's agents are dead from a short probe timeout alone. */
export class EngineActivityHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private activeRequests = 0;
  private sequence = 0;

  constructor(
    private readonly options: {
      instance: string;
      publish: (frame: EngineActivityFrame) => void;
      activeTurns: () => number;
      /** Local host lifecycle calls refresh on every activity transition. */
      stopWhenIdle?: boolean;
    },
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): void {
    if (!this.started) return;
    try {
      const activeTurns = this.options.activeTurns();
      if (this.options.stopWhenIdle && this.activeRequests === 0 && activeTurns === 0) {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      } else if (!this.timer) {
        this.timer = setInterval(() => this.refresh(), 3_000);
        this.timer.unref?.();
      }
      this.options.publish({
        type: "engine.heartbeat",
        instance: this.options.instance,
        sequence: ++this.sequence,
        activeRequests: this.activeRequests,
        activeTurns,
      });
    } catch {
      // Diagnostics never fail a request or interrupt an accepted agent turn.
    }
  }

  async track<T>(operation: () => Promise<T>): Promise<T> {
    this.activeRequests++;
    if (this.activeRequests === 1) this.refresh();
    try {
      return await operation();
    } finally {
      this.activeRequests--;
      if (this.activeRequests === 0) this.refresh();
    }
  }
}
