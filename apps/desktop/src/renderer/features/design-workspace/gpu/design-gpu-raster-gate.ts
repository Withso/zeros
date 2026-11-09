/** When the canvas may send the raster worker its next burst: never while
 * the worker's GPU context is lost, and after a failed burst only once a
 * delay has passed that doubles with each failure, up to a few seconds. */
export class DesignGpuRasterGate {
  private lost = false;
  private retryAt = 0;
  private delay = 0;

  constructor(private readonly minDelayMs = 250, private readonly maxDelayMs = 4_000) {}

  open(now: number): boolean {
    return !this.lost && now >= this.retryAt;
  }

  context(lost: boolean): void {
    this.lost = lost;
    if (!lost) { this.retryAt = 0; this.delay = 0; }
  }

  /** Returns how long to wait before trying again. */
  failed(now: number): number {
    this.delay = Math.min(this.maxDelayMs, Math.max(this.minDelayMs, this.delay * 2));
    this.retryAt = now + this.delay;
    return this.delay;
  }

  succeeded(): void {
    this.delay = 0;
    this.retryAt = 0;
  }
}
