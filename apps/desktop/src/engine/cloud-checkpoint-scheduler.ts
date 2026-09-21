import { randomUUID } from "node:crypto";
import type { CloudCheckpointCapture, CloudDurabilityAuthority } from "./cloud-durability-runtime";

/** Heartbeat-driven recovery points never retire agents or pause user work.
 * A changing capture fails closed and retries on a later healthy heartbeat.
 * Lifecycle capture takes the exclusive lane after the bounded capture settles. */
export class CloudCheckpointScheduler {
  private nextAt: number | null = null;
  private active: Promise<void> | null = null;
  private paused = false;
  private closed = false;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private readonly options: {
    capture: (directive: CloudCheckpointCapture, authority: CloudDurabilityAuthority) => Promise<void>;
    eligible: () => boolean;
    failed?: (error: unknown) => void;
    now?: () => number;
    intervalMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 30_000 || this.intervalMs > 30 * 60_000)
      throw new Error("cloud checkpoint interval is invalid");
  }

  consider(authority: CloudDurabilityAuthority): void {
    if (this.closed || this.paused || this.active || !this.options.eligible()) return;
    const now = this.now();
    if (this.nextAt === null) this.nextAt = now + this.intervalMs;
    if (now < this.nextAt) return;
    const directive = { id: randomUUID(), reason: "periodic" as const, deadlineAtMs: now + 60_000 };
    const task = Promise.resolve()
      .then(() => {
        if (this.closed || this.paused || !this.options.eligible()) return;
        return this.options.capture(directive, authority);
      })
      .then(() => { this.nextAt = this.now() + this.intervalMs; })
      .catch(error => {
        this.nextAt = this.now() + Math.min(this.intervalMs, 60_000);
        // Diagnostics must never turn an already handled capture failure into
        // an unhandled rejection in the engine's authority path.
        try { this.options.failed?.(error); } catch { /* diagnostic only */ }
      })
      .finally(() => { if (this.active === task) this.active = null; });
    this.active = task;
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.active;
  }

  resume(): void {
    if (this.closed) return;
    this.paused = false;
    this.nextAt = this.now() + this.intervalMs;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pause();
  }
}
